import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NestMiddleware, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { AuthUser, LegacyAuthPayload } from '../decorators/current-user.decorator';
import { extractToken } from '../guards/jwt.guard';
import { Staff, StaffDocument } from '../../team/schemas/staff.schema';
import { Salon, SalonDocument } from '../../seed/schemas/salon.schema';
import { User, UserDocument } from '../../auth/schemas/user.schema';
import { LocationService } from '../../locations/location.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MembershipService } from '../../identity/membership.service';
import { MemoryCache } from '../utils/memory-cache.util';
import { runWithTenant, TenantContext, TenantRole } from './tenant-context';
import { TenantMisconfiguredException } from './tenant-misconfigured.exception';
import { PosTokenPayload } from '../../auth/dto/auth.dto';

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Même TTL que `MembershipService.findByUserCached` — `users.role` change encore moins
 *  souvent qu'un membership, donc 60s est au moins aussi sûr ici. */
const ACCOUNT_ROLE_CACHE_TTL_MS = 60_000;
const accountRoleCacheKey = (userId: string): string => `acct-role:${userId}`;

/**
 * TenantContext middleware (Sprint 1 v2 Prompt 2 → Sprint 2 v2 Prompt 2).
 *
 * Design (inchangé depuis Sprint 1) : un token absent OU invalide n'est PAS traité comme
 * une erreur de résolution — la requête continue sans contexte tenant établi.
 * L'authentification proprement dite reste incarnée ici (voir plus bas) : ce middleware
 * est désormais le SEUL endroit qui décode le JWT et peuple `req.user` — `JwtGuard`/
 * `OptionalJwtGuard` ne font plus que vérifier que cette résolution a eu lieu (voir leurs
 * docstrings). Nécessaire parce que résoudre `req.user.role`/`.salonId` demande maintenant
 * la MÊME logique memberships que `TenantContext` — les calculer deux fois indépendamment
 * (comme avant, un décodage ici + un décodage dans JwtGuard) risquerait de diverger.
 *
 * ⚠️ Sprint 2 v2 Prompt 2 : le JWT ne porte plus `payload.salonId`/`payload.role` figés —
 * il porte `payload.memberships[]` (voir `AuthTokenPayload`). Le tenant actif est résolu
 * PAR REQUÊTE :
 *   1. `payload.scope === 'pos'` → `payload.salonId`, verrouillé (`handlePosToken`,
 *      INCHANGÉ — le token POS garde sa forme actuelle, `{staffId,salonId,scope,role}`,
 *      voir la note sur `PosTokenPayload` dans sa docstring).
 *   2. Header `x-tenant-id` → doit être un tenant où le user a un membership ACTIF.
 *   3. Sous-domaine/slug → pas d'infrastructure de sous-domaine dans cet environnement
 *      (dev: localhost/127.0.0.1) — no-op structurel pour l'instant, prêt à être complété.
 *   4. Un seul membership actif → ce tenant.
 *   5. Sinon → 400 `{code:'TENANT_REQUIRED', memberships:[...]}`.
 *
 * La liste des memberships ACTIFS n'est PAS lue depuis le JWT (qui reste valide 7 jours,
 * pas de refresh ce sprint — décision explicite) mais relue depuis la base à CHAQUE
 * requête, via `MembershipService.findByUserCached()` (cache 60s, clé `mbr:{userId}`) :
 * c'est ce qui fait qu'une révocation ou un changement de `locationIds` se propage en
 * ≤60s au lieu d'attendre l'expiration du token. Le JWT ne sert plus qu'à identifier le
 * user (`sub`) et à distinguer un token neuf d'un ancien (voir le fallback ci-dessous).
 *
 * ⚠️ FALLBACK TRANSITOIRE — tokens émis AVANT ce déploiement (jusqu'à 7 jours après, vu
 * `JWT_EXPIRES=7d` et l'absence de refresh ce sprint) portent encore l'ancien format
 * `{salonId, role, staffId?, clientId?}` sans `memberships`. Détecté via l'absence du
 * champ `memberships` dans le payload décodé — reconstruit un membership "candidat" depuis
 * `payload.salonId`, mais celui-ci est ENSUITE VÉRIFIÉ contre les memberships actifs réels
 * (même logique que le chemin normal) : un ancien token dont l'accès a été révoqué depuis
 * est donc bloqué, pas juste toléré aveuglément. À SUPPRIMER 7 jours après le déploiement
 * de ce changement en prod (chercher ce commentaire).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  /** Cache local au middleware (instance unique, comme MembershipService) — jamais un état
   *  par requête. Clé `acct-role:{userId}`, distincte de `mbr:{userId}`. */
  private readonly accountRoleCache = new MemoryCache();

  constructor(
    private readonly jwt: JwtService,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly locations: LocationService,
    private readonly entitlements: EntitlementsService,
    private readonly memberships: MembershipService,
  ) {}

  /**
   * Type de COMPTE (`users.role`), à ne pas confondre avec le rôle DANS un tenant
   * (`Membership.role`, résolu plus bas). C'est la seule source de vérité disponible AVANT
   * toute résolution de tenant : `Membership.role` est circulaire ici — on cherche justement
   * à savoir si ce compte a besoin d'un membership.
   *
   * `users` est GLOBAL (exempté du plugin de scope), donc cette lecture ne requiert aucun
   * TenantContext — c'est ce qui la rend utilisable à cet endroit précis.
   */
  private async accountRole(userId: string): Promise<'owner' | 'staff' | 'client' | null> {
    return this.accountRoleCache.getOrSet(accountRoleCacheKey(userId), ACCOUNT_ROLE_CACHE_TTL_MS, async () => {
      const user = await this.userModel.findById(userId).select('role').lean();
      return user?.role ?? null;
    });
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);
    if (!token) {
      next();
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch {
      // Token présent mais invalide/expiré : pas une erreur de résolution tenant — on
      // laisse passer sans contexte. JwtGuard rejettera la requête lui-même (401).
      next();
      return;
    }

    if (payload.scope === 'pos') {
      await this.handlePosToken(req, payload as unknown as PosTokenPayload, next);
      return;
    }

    const userId = payload.sub as string | undefined;
    if (!userId) {
      next();
      return;
    }

    const isLegacyToken = !Array.isArray(payload.memberships);
    const activeMemberships = await this.memberships.findByUserCached(userId);

    let candidateTenantId: string | undefined;
    const headerTenantId = req.header('x-tenant-id');

    if (isLegacyToken) {
      // Voir le ⚠️ FALLBACK TRANSITOIRE dans la docstring de la classe.
      candidateTenantId = (payload as unknown as LegacyAuthPayload).salonId;
      if (!candidateTenantId) {
        next();
        return;
      }
    } else if (headerTenantId) {
      candidateTenantId = headerTenantId;
    } else if (activeMemberships.length === 1) {
      candidateTenantId = activeMemberships[0].tenantId;
    }
    // Étape 3 (sous-domaine/slug) : aucune infrastructure de sous-domaine dans cet
    // environnement — no-op structurel, voir la docstring de la classe.

    if (!candidateTenantId) {
      /**
       * MODÈLE MÉTIER : un CLIENT n'appartient à aucun salon — il parcourt l'annuaire et
       * réserve chez plusieurs salons. Il n'a donc, par conception, aucun Membership (celui-ci
       * est le lien staff/owner ↔ salon). Exiger un tenant ici le rendait incapable de
       * s'authentifier ; c'est ce qui avait motivé la création d'un faux `kind:'client'`
       * (retiré, voir auth.service.ts#register).
       *
       * `users.role` — PAS `Membership.role`, qui serait circulaire à ce point (cf. accountRole).
       *
       * Aucune ouverture d'accès : on passe SANS TenantContext, donc toute lecture d'une
       * collection TENANT_SCOPED continue de throw au niveau du plugin Mongoose, et RolesGuard
       * refuse toujours les routes staff/owner. Les routes salon-scopées du client
       * (`/:salonSlug/...`) posent leur propre contexte via GuestScopeService, depuis l'URL.
       */
      const role = await this.accountRole(userId);
      if (role === 'client') {
        req.user = { sub: userId, salonId: '', role: 'client', accountType: 'client' } as AuthUser;
        next();
        return;
      }

      throw new HttpException(
        {
          code: 'TENANT_REQUIRED',
          message: 'Multiple tenants available for this account — specify X-Tenant-Id.',
          memberships: activeMemberships.map((m) => ({ tenantId: m.tenantId, role: m.role })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const activeMembership = activeMemberships.find((m) => m.tenantId === candidateTenantId);
    if (!activeMembership) {
      // Couvre 2 cas à la fois : header pointant un tenant sans membership actif (403,
      // spec) ET ancien token dont le membership a depuis été révoqué (idem, ≤60s après
      // la révocation grâce au cache — jamais 7 jours).
      throw new HttpException(
        { code: 'TENANT_FORBIDDEN', message: 'No active membership for this tenant.' },
        HttpStatus.FORBIDDEN,
      );
    }

    const tenantId = activeMembership.tenantId;
    const role = activeMembership.role as TenantRole;
    const staffId = activeMembership.staffId?.toString();
    const clientId = activeMembership.clientId?.toString();

    // Prompt 8 (Sprint 1) : cycle de vie du tenant (`salons` est UNSCOPED — lisible sans
    // contexte). churned → accès coupé entièrement. suspended → lecture seule.
    const salon = await this.salonModel.findById(tenantId).select('status').lean();
    if (salon?.status === 'churned') {
      throw new HttpException({ code: 'TENANT_CHURNED', message: 'This tenant is no longer active.' }, HttpStatus.FORBIDDEN);
    }
    if (salon?.status === 'suspended' && MUTATING_METHODS.includes(req.method)) {
      throw new HttpException({ code: 'TENANT_SUSPENDED', message: 'This salon is suspended — read-only.' }, HttpStatus.PAYMENT_REQUIRED);
    }

    const locationIds = activeMembership.locationIds ?? [];
    const headerLocationId = req.header('x-location-id');
    let locationId: string;

    if (headerLocationId) {
      if (!locationIds.includes(headerLocationId)) {
        throw new ForbiddenException({
          code: 'LOCATION_OUT_OF_SCOPE',
          message: 'The requested location is not accessible to this account.',
        });
      }
      locationId = headerLocationId;
    } else if (activeMembership.defaultLocationId) {
      locationId = activeMembership.defaultLocationId;
    } else {
      // Fallback rare (Membership sans defaultLocationId — ex. migration ancienne) :
      // `locations` est TENANT_SCOPED, ce lookup a donc besoin d'un contexte bootstrap.
      // C'est désormais le SEUL point de ce middleware qui en a besoin (le lookup staff
      // qui causait 4 récidives du même bug au Sprint 1 a disparu — locationIds/
      // defaultLocationId viennent maintenant du Membership, jamais d'un nouveau lookup
      // staff ici).
      const bootstrapCtx: TenantContext = { tenantId, locationId: '', locationIds, role, plan: 'starter', features: {}, limits: {} };
      locationId = await runWithTenant(bootstrapCtx, async () => {
        try {
          const primary = await this.locations.findPrimary({ salonId: tenantId });
          return primary._id.toString();
        } catch (err) {
          if (!(err instanceof NotFoundException)) throw err;
          this.logger.error(`No primary location for tenant ${tenantId} — provisioning incomplete or primary was deleted.`);
          throw new TenantMisconfiguredException(tenantId, 'no primary location configured');
        }
      });
    }

    // Prompt 7 (Sprint 1) : ne throw jamais, ne bloque jamais — fallback 'starter' + log
    // error géré entièrement par le service.
    const resolved = await this.entitlements.resolve(tenantId);

    const impersonatedBy = payload.impersonatedBy as string | undefined;
    const impersonationReason = payload.impersonationReason as string | undefined;
    if (impersonatedBy) {
      this.logger.warn(
        `Impersonated request: tenant=${tenantId} admin=${impersonatedBy} reason="${impersonationReason ?? ''}" ${req.method} ${req.path}`,
      );
    }

    const ctx: TenantContext = {
      tenantId,
      locationId,
      locationIds,
      role,
      userId,
      staffId,
      clientId,
      plan: resolved.plan,
      features: resolved.features,
      limits: resolved.limits,
      flags: resolved.flags, // [Delta 3]
      impersonatedBy,
    };

    // Sprint 2 v2 Prompt 2 : req.user est désormais peuplé ICI (résolu depuis le
    // membership actif), plus par JwtGuard/OptionalJwtGuard qui décodaient indépendamment
    // le JWT brut — celui-ci ne porte plus role/salonId à la racine, un décodage
    // indépendant y lirait `undefined` partout. `name`/`email`/`phone` ne sont plus
    // peuplés (le nouveau JWT ne les porte pas — voir la docstring d'`AuthUser`).
    // `role`/`accountType` castés : TenantRole inclut 'guest' (jamais possible ici, un
    // Membership n'a que owner|manager|stylist|colorist|client), Role (AuthUser) non.
    (req as Request & { user?: AuthUser }).user = {
      sub: userId,
      salonId: tenantId,
      role: role as AuthUser['role'],
      accountType: clientId ? 'client' : 'staff',
      staffId,
      clientId,
      impersonatedBy,
      impersonationReason,
    };

    runWithTenant(ctx, () => next());
  }

  /**
   * Token POS — INCHANGÉ (spec Sprint 2 v2 Prompt 2 : "Token POS INCHANGÉ... Ne pas y
   * toucher"). ⚠️ Écart signalé, pas deviné : la section "Contrat de token cible" du SKILL
   * décrit le payload POS comme `{sub, scope:'pos', tenantId, locationId, staffId, role}`,
   * mais le payload RÉEL (émis par `AuthService.loginPin()`, `PosTokenPayload` dans
   * `auth.dto.ts`) est `{staffId, salonId, scope:'pos', role}` — pas de `sub`, `salonId`
   * pas `tenantId`, pas de `locationId` dans le token (résolu ici comme avant, via un
   * lookup staff). Le SKILL décrit une forme aspirationnelle qui ne correspond pas à ce
   * qui a réellement été livré au Sprint 1 — je n'ai RIEN renommé (conforme à "ne pas y
   * toucher"), cette méthode lit les champs RÉELS. Logique IDENTIQUE à l'ancien chemin
   * générique (bootstrap `runWithTenant` + lookup staff pour locationIds/defaultLocationId
   * — nécessaire ici, contrairement au chemin memberships ci-dessus, puisqu'un token POS
   * n'a pas de Membership associé).
   */
  private async handlePosToken(req: Request, payload: PosTokenPayload, next: NextFunction): Promise<void> {
    const tenantId = payload.salonId;
    if (!tenantId) {
      next();
      return;
    }

    const salon = await this.salonModel.findById(tenantId).select('status').lean();
    if (salon?.status === 'churned') {
      throw new HttpException({ code: 'TENANT_CHURNED', message: 'This tenant is no longer active.' }, HttpStatus.FORBIDDEN);
    }
    if (salon?.status === 'suspended' && MUTATING_METHODS.includes(req.method)) {
      throw new HttpException({ code: 'TENANT_SUSPENDED', message: 'This salon is suspended — read-only.' }, HttpStatus.PAYMENT_REQUIRED);
    }

    const scope = { salonId: tenantId };
    const role = payload.role as TenantRole;

    const bootstrapCtx: TenantContext = { tenantId, locationId: '', locationIds: [], role, plan: 'starter', features: {}, limits: {} };
    const { locationIds, locationId } = await runWithTenant(bootstrapCtx, async () => {
      const staff = payload.staffId
        ? await this.staffModel.findById(payload.staffId).select('locationIds defaultLocationId').exec()
        : null;

      const locationIds =
        role === 'stylist' || role === 'colorist'
          ? (staff?.locationIds ?? [])
          : (await this.locations.findAllForTenant(scope)).map((l) => l._id.toString());

      // Token POS verrouillé (spec) : x-tenant-id n'est JAMAIS lu ici. x-location-id reste
      // utile si le kiosque change de poste dans le même tenant.
      const headerLocationId = req.header('x-location-id');
      let locationId: string;
      if (headerLocationId) {
        if (!locationIds.includes(headerLocationId)) {
          throw new ForbiddenException({ code: 'LOCATION_OUT_OF_SCOPE', message: 'The requested location is not accessible to this account.' });
        }
        locationId = headerLocationId;
      } else if (staff?.defaultLocationId) {
        locationId = staff.defaultLocationId;
      } else {
        try {
          const primary = await this.locations.findPrimary(scope);
          locationId = primary._id.toString();
        } catch (err) {
          if (!(err instanceof NotFoundException)) throw err;
          this.logger.error(`No primary location for tenant ${tenantId} — provisioning incomplete or primary was deleted.`);
          throw new TenantMisconfiguredException(tenantId, 'no primary location configured');
        }
      }
      return { locationIds, locationId };
    });

    const resolved = await this.entitlements.resolve(tenantId);
    const ctx: TenantContext = {
      tenantId,
      locationId,
      locationIds,
      role,
      staffId: payload.staffId,
      plan: resolved.plan,
      features: resolved.features,
      limits: resolved.limits,
    };

    (req as Request & { user?: AuthUser }).user = {
      sub: payload.staffId,
      salonId: tenantId,
      role: role as AuthUser['role'],
      accountType: 'staff',
      staffId: payload.staffId,
    };

    runWithTenant(ctx, () => next());
  }
}
