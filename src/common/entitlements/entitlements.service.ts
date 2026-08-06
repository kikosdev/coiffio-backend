import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { MemoryCache } from '../utils/memory-cache.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { todayIsoInTz } from '../time/tz-day.util';
import { STARTER_ENTITLEMENTS, FALLBACK_CACHE_TTL_MS } from './entitlements.constants';
import { EntitlementsJwtPayload, Feature, LimitKey, ResolvedEntitlements } from './entitlements.types';
import { FlagsService } from './flags.service';

/**
 * Vérifie (jamais n'émet) le JWT d'entitlements du Control Plane (Sprint 3, pas encore
 * construit — cf. SKILL Prompt 7). RÈGLE DE SURVIE, verrouillée par l'utilisateur : si les
 * entitlements sont absents, expirés ou invalides, ce service NE DOIT JAMAIS throw ni
 * bloquer une requête. Il retombe sur `STARTER_ENTITLEMENTS` + un log d'erreur. Le Control
 * Plane peut tomber, être injoignable, ou ne pas exister du tout (le cas de tout le
 * Sprint 1) — les salons continuent de fonctionner.
 *
 * Cache : `MemoryCache` (stand-in Redis provisoire, même pattern que Prompt 5 — voir sa
 * docstring). Clé `ent:{tenantId}`, TTL = exp - now pour un résultat vérifié, sinon
 * `FALLBACK_CACHE_TTL_MS` (borne aussi la fréquence du log d'erreur : une fois par fenêtre,
 * pas une fois par requête, sur un service où 100% du trafic est en fallback en Sprint 1).
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);
  private readonly cache = new MemoryCache();

  constructor(
    private readonly notifications: NotificationsService,
    private readonly flags: FlagsService,
  ) {}

  private cacheKey(tenantId: string): string {
    return `ent:${tenantId}`;
  }

  private fallback(tenantId: string, reason: string): ResolvedEntitlements {
    this.logger.error(`Entitlements fallback for tenant ${tenantId}: ${reason}. Using plan '${STARTER_ENTITLEMENTS.plan}'.`);
    return { ...STARTER_ENTITLEMENTS, features: { ...STARTER_ENTITLEMENTS.features }, limits: { ...STARTER_ENTITLEMENTS.limits }, flags: { ...STARTER_ENTITLEMENTS.flags } };
  }

  /** Vérifie un JWT d'entitlements déjà obtenu (ex. via `refresh`) avec CP_PUBLIC_KEY.
   *  Renvoie aussi `exp` (epoch seconds) pour que l'appelant calcule le TTL de cache réel. */
  private verifyRaw(token: string, expectedTenantId: string): { resolved: ResolvedEntitlements; exp: number } {
    const rawPublicKey = process.env.CP_PUBLIC_KEY;
    if (!rawPublicKey) throw new Error('CP_PUBLIC_KEY not configured');
    // `.env` (dotenv) ne supporte pas un PEM multi-ligne brut sans guillemets spéciaux — la
    // valeur y est donc stockée sur une seule ligne avec des `\n` littéraux échappés. Sans
    // cette normalisation, `jwt.verify()` reçoit une chaîne à une seule ligne et throw
    // immédiatement ("secretOrPublicKey must be an asymmetric key"). Même logique que
    // `normalizePem()` côté CP (`salonos-admin/src/common/config/env.validation.ts`).
    const publicKey = rawPublicKey.includes('\\n') ? rawPublicKey.replace(/\\n/g, '\n') : rawPublicKey;

    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as EntitlementsJwtPayload;
    if (payload.tenantId !== expectedTenantId) {
      throw new Error(`entitlements tenantId mismatch: expected ${expectedTenantId}, got ${payload.tenantId}`);
    }

    return {
      resolved: {
        plan: payload.plan,
        features: { ...STARTER_ENTITLEMENTS.features, ...payload.features },
        limits: { ...STARTER_ENTITLEMENTS.limits, ...payload.limits },
        status: payload.status,
        // [Delta 3] `payload.flags` absent (CP antérieur à ce prompt, ou aucun flag créé) ->
        // `{}`, jamais `undefined` — même garantie "toujours complet" que features/limits.
        flags: { ...payload.flags },
        source: 'verified',
      },
      exp: payload.exp,
    };
  }

  /** Vérifie un JWT d'entitlements — utilisable directement (tests, appelants externes).
   *  Throw si invalide/expiré/mismatch : c'est `refresh`/`resolve` qui absorbent l'erreur
   *  en fallback, jamais cette méthode elle-même. */
  verify(token: string, expectedTenantId: string): ResolvedEntitlements {
    return this.verifyRaw(token, expectedTenantId).resolved;
  }

  /**
   * Va chercher un token frais auprès du Control Plane (signature HMAC sortante, même
   * convention que `X-CP-Signature`/`X-CP-Timestamp` prévue pour /internal en Prompt 8).
   * CP_URL absent (tout le Sprint 1) → fallback immédiat, pas d'appel réseau tenté.
   */
  private async refresh(tenantId: string): Promise<{ resolved: ResolvedEntitlements; ttlMs: number }> {
    const cpUrl = process.env.CP_URL;
    const sharedSecret = process.env.CP_SHARED_SECRET;
    if (!cpUrl || !sharedSecret) {
      return {
        resolved: this.fallback(tenantId, 'CP_URL/CP_SHARED_SECRET not configured (Sprint 1 — Control Plane does not exist yet)'),
        ttlMs: FALLBACK_CACHE_TTL_MS,
      };
    }

    try {
      const timestamp = Date.now().toString();
      const signature = crypto.createHmac('sha256', sharedSecret).update(`${timestamp}.${tenantId}`).digest('hex');
      const res = await fetch(`${cpUrl}/internal/entitlements/${tenantId}`, {
        headers: { 'X-CP-Signature': signature, 'X-CP-Timestamp': timestamp },
      });
      if (!res.ok) return { resolved: this.fallback(tenantId, `CP responded ${res.status}`), ttlMs: FALLBACK_CACHE_TTL_MS };
      const { token } = (await res.json()) as { token: string };
      const { resolved, exp } = this.verifyRaw(token, tenantId);
      return { resolved, ttlMs: Math.max(1000, exp * 1000 - Date.now()) };
    } catch (err) {
      return {
        resolved: this.fallback(tenantId, `CP unreachable or invalid response (${(err as Error).message})`),
        ttlMs: FALLBACK_CACHE_TTL_MS,
      };
    }
  }

  /** Point d'entrée normal — cache-first, jamais throw. */
  async resolve(tenantId: string): Promise<ResolvedEntitlements> {
    const key = this.cacheKey(tenantId);
    const cached = this.cache.get<ResolvedEntitlements>(key);
    if (cached) return cached;

    const { resolved, ttlMs } = await this.refresh(tenantId);
    this.cache.set(key, resolved, ttlMs);
    return resolved;
  }

  /** Webhook d'invalidation (POST /internal/entitlements/invalidate) — supprime le cache
   *  pour forcer un `refresh` au prochain `resolve`. */
  invalidate(tenantId: string): void {
    this.cache.delete(this.cacheKey(tenantId));
  }

  /**
   * Limite SOFT (appointmentsMonth, smsQuota, ...) : ne bloque JAMAIS. Notifie le salon
   * (broadcast, room `salon:{id}`) au franchissement de 80% puis 100% — dédupliqué par mois
   * calendaire via `dispatchOnce` (upsert unique sur salonId+type+groupId), donc appelable
   * à chaque création sans jamais spammer plus d'une fois par palier par mois.
   *
   * [Delta 3, Sprint 3 Prompt 7] Point de lecture concret du flag `mute-quota-warnings` —
   * un tenant CP-marqué (override explicite, ex. un compte "white-glove" qui ne veut pas de
   * notifications de quota) ne reçoit AUCUNE de ces notifications, quel que soit le seuil
   * franchi. Comportement RÉEL qui change selon le flag, pas un simple champ exposé — la
   * preuve que le CP émet un flag ET que le DP le lit ET s'en sert (comme Delta 8).
   */
  async checkSoftLimit(salonId: string, limitKey: LimitKey, current: number, limit: number): Promise<void> {
    if (limit <= 0) return;
    if (this.flags.isEnabled('mute-quota-warnings')) return;
    const pct = current / limit;
    const threshold = pct >= 1 ? 100 : pct >= 0.8 ? 80 : null;
    if (threshold === null) return;

    const period = todayIsoInTz().slice(0, 7); // 'YYYY-MM'
    await this.notifications.dispatchOnce({
      salonId,
      groupId: `entitlements:${limitKey}:${period}:${threshold}`,
      type: 'entitlements.quota_warning',
      title: threshold >= 100 ? 'Quota atteint' : 'Quota bientôt atteint',
      body: `${limitKey} : ${current}/${limit} (${Math.round(pct * 100)}%) ce mois-ci.`,
      payload: { limitKey, current, limit, pct: Math.round(pct * 100), threshold },
    });
  }
}

export type { Feature, LimitKey, ResolvedEntitlements };
