import { AsyncLocalStorage } from 'async_hooks';
import { InternalServerErrorException, Logger } from '@nestjs/common';

export type TenantRole = 'owner' | 'manager' | 'stylist' | 'colorist' | 'client' | 'guest';

export interface TenantContext {
  tenantId: string; // ≡ salonId, String brut — Invariant #1
  locationId: string;
  locationIds: string[];
  role: TenantRole;
  userId?: string;
  staffId?: string;
  clientId?: string;
  profileId?: string; // ClientProfile — Prompt 4, pas encore construit
  plan: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  /** [Delta 3, Sprint 3 Prompt 7] Optionnel — les sites qui construisent un `TenantContext`
   *  sans passer par `TenantContextMiddleware` (`runOutsideTenant`/`runAsGuest`/
   *  `runAsDiscovery`) n'en posent jamais, `FlagsService.isEnabled()` traite l'absence comme
   *  "aucun flag actif", jamais une erreur. */
  flags?: Record<string, boolean>;
  impersonatedBy?: string; // Prompt 8, pas encore construit
  /** Posé UNIQUEMENT par runOutsideTenant — jamais par le middleware HTTP. */
  bypass?: boolean;
  bypassReason?: string;
}

const logger = new Logger('TenantContext');

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Marque "ce contexte est en mode découverte" — DÉLIBÉRÉMENT PAS un champ de
 * `TenantContext`. Un champ public (même `readonly`) serait posable par n'importe lequel
 * des centaines d'appels `runWithTenant({...}, fn)` déjà dans le codebase, en ajoutant
 * juste une clé de plus à l'objet littéral — aucune vérification ne l'en empêcherait.
 * Un WeakSet privé, jamais exporté, ne peut recevoir un ajout que depuis CE fichier :
 * `runAsDiscovery()` est le seul endroit qui appelle `.add()`. Node n'expose aucune
 * liaison non exportée à un autre module — ce n'est pas une convention, c'est une
 * garantie du système de modules.
 */
const discoveryContexts = new WeakSet<TenantContext>();

/** Lecture seule — safe à exporter largement (le plugin en a besoin). Ne permet à
 *  personne de FAIRE entrer un contexte en mode découverte, seulement de vérifier. */
export function isDiscoveryContext(ctx: TenantContext): boolean {
  return discoveryContexts.has(ctx);
}

/**
 * Même raisonnement que `discoveryContexts` ci-dessus (durcissement post-Sprint-1-v2,
 * trou trouvé au Prompt 6) : `role: 'guest'` était une étiquette de donnée, falsifiable par
 * n'importe quel `runWithTenant({role:'guest', ...}, fn)` déjà existant dans le codebase —
 * pas une barrière structurelle. Un WeakSet privé, jamais exporté, ne peut recevoir un ajout
 * que depuis CE fichier : `runAsGuest()` est le seul endroit qui appelle `.add()`.
 */
const guestContexts = new WeakSet<TenantContext>();

/** Lecture seule — le plugin en a besoin pour appliquer la whitelist GUEST_READABLE. Ne
 *  permet à personne de FAIRE entrer un contexte en mode guest, seulement de vérifier. */
export function isGuestContext(ctx: TenantContext): boolean {
  return guestContexts.has(ctx);
}

/**
 * Renvoie le TenantContext courant. Throw si le code s'exécute hors requête HTTP et
 * hors boundary explicite (runWithTenant / runOutsideTenant / runAsGuest) — c'est le
 * signal qu'un chemin (job cron, script) a oublié de poser son contexte.
 */
export function getTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new InternalServerErrorException(
      'No tenant context available — this code path is running outside a request or a ' +
        'runWithTenant/runOutsideTenant/runAsGuest boundary.',
    );
  }
  return ctx;
}

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

/**
 * Réservé aux scripts de migration et aux jobs cron système — JAMAIS au flux HTTP
 * normal. Pose { bypass: true, reason } dans le store et logge en warn à chaque usage,
 * pour que tout contournement du scope tenant reste visible dans les logs.
 */
export function runOutsideTenant<T>(reason: string, fn: () => T): T {
  logger.warn(`Tenant scope bypass: ${reason}`);
  const ctx: TenantContext = {
    tenantId: '',
    locationId: '',
    locationIds: [],
    role: 'guest',
    plan: 'starter',
    features: {},
    limits: {},
    bypass: true,
    bypassReason: reason,
  };
  return tenantStorage.run(ctx, fn);
}

/**
 * Storefront public — tenant résolu par slug, sans JWT. Contexte role='guest',
 * locationIds réduit à la seule location résolue. Utilisé pour un tenant DÉJÀ identifié
 * (ex. disponibilité publique d'un salon précis) — PAS pour le parcours de découverte
 * cross-tenant lui-même, qui passe par `runAsDiscovery` ci-dessous.
 *
 * Durci post-Sprint-1-v2 (trou trouvé au Prompt 6, fermé avant Sprint 2) : `role: 'guest'`
 * est désormais structurellement appliqué par `tenant-scope.plugin.ts` — un contexte marqué
 * ici (via `guestContexts`, WeakSet privé au fichier, jamais falsifiable de l'extérieur, même
 * garantie que `isDiscoveryContext`) ne peut lire QUE les collections listées dans
 * `GUEST_READABLE` (`scoping-registry.ts`) ; toute lecture hors whitelist (`clients`,
 * `payments`, `sales`, `expenses`...) throw au niveau du plugin, pas une convention côté
 * service. `staffs` EST dans `GUEST_READABLE` (contrairement à une première version de cette
 * whitelist, corrigée par la suite de tests elle-même — `BookingService.loadStylistContext`
 * lit `staffModel.find(...)` en direct pour calculer les disponibilités, pas seulement
 * `appointments`). `clients` reste volontairement HORS whitelist : le code interne qui a
 * légitimement besoin d'une lecture `clients` bornée sous un appel guest (ex.
 * `BookingService.resolveClient`, dédup merge-on-phone) le fait via un contexte interne
 * scopé explicite (`runWithTenant(bootstrapCtx(tenantId), ...)`), jamais via le contexte
 * guest ambiant — même principe que `systemReadContext` dans `client-profile.service.ts`.
 */
/**
 * `entitlements` optionnel (Prompt 7) : `GuestScopeService` résout les vraies entitlements
 * du tenant (via `EntitlementsService.resolve`, jamais throw) et les passe ici, pour que
 * `@RequiresFeature('ecommerce')` sur le storefront public (orders/carts) lise un
 * `TenantContext.features` réel plutôt qu'un objet vide qui bloquerait tout visiteur. Les
 * autres appelants (ex. `DiscoveryService.availability`, qui ne passe par aucun
 * `@RequiresFeature`) gardent le comportement par défaut plan starter/`{}` — ce fichier
 * n'a et ne doit pas avoir de dépendance DI vers `EntitlementsService`.
 */
export function runAsGuest<T>(
  tenantId: string,
  locationId: string,
  fn: () => T,
  entitlements?: { plan: string; features: Record<string, boolean>; limits: Record<string, number> },
): T {
  const ctx: TenantContext = {
    tenantId,
    locationId,
    locationIds: [locationId],
    role: 'guest',
    plan: entitlements?.plan ?? 'starter',
    features: entitlements?.features ?? {},
    limits: entitlements?.limits ?? {},
  };
  guestContexts.add(ctx);
  return tenantStorage.run(ctx, fn);
}

/**
 * Découverte cross-tenant publique (Prompt 5, DiscoveryService UNIQUEMENT). Aucun
 * tenantId — c'est précisément le point : parcourir plusieurs tenants avant qu'aucun ne
 * soit choisi. Le plugin, en voyant `isDiscoveryContext(store)` vrai, n'injecte AUCUN
 * salonId et n'autorise que les collections listées dans PUBLIC_DISCOVERY, avec
 * projection de champs forcée — jamais un simple laisser-passer.
 */
export function runAsDiscovery<T>(fn: () => T): T {
  const ctx: TenantContext = {
    tenantId: '',
    locationId: '',
    locationIds: [],
    role: 'guest',
    plan: 'starter',
    features: {},
    limits: {},
  };
  discoveryContexts.add(ctx);
  return tenantStorage.run(ctx, fn);
}
