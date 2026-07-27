import { ForbiddenException, Injectable, Logger, NestMiddleware, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { AuthUser } from '../decorators/current-user.decorator';
import { extractToken } from '../guards/jwt.guard';
import { Staff, StaffDocument } from '../../team/schemas/staff.schema';
import { LocationService } from '../../locations/location.service';
import { runWithTenant, TenantContext, TenantRole } from './tenant-context';
import { TenantMisconfiguredException } from './tenant-misconfigured.exception';

// Sprint 1 — le Control Plane (Prompt 7) n'existe pas encore : pas de JWT d'entitlements
// à vérifier. Fallback explicite sur le plan 'starter', loggé en warn à chaque requête
// tant que Prompt 7 n'est pas branché (bruyant par design, spec l'exige — à revoir une
// fois l'entitlements service en place).
const STARTER_PLAN_DEFAULTS = { plan: 'starter', features: {}, limits: {} } as const;

/**
 * TenantContext middleware (Sprint 1 v2, Prompt 2).
 *
 * Design : un token absent OU invalide n'est PAS traité comme une erreur de résolution —
 * la requête continue sans contexte tenant établi. L'authentification proprement dite
 * reste la responsabilité de JwtGuard sur chaque contrôleur (déjà en place) ; ce
 * middleware n'a pas vocation à devenir une seconde porte d'auth avec une sémantique
 * différente, et beaucoup de routes publiques (public/*, marketplace, salons/nearby)
 * n'ont ni JWT ni :salonSlug exploitable ici (les path params NestJS ne sont pas encore
 * liés à ce stade du pipeline Express — seul Prompt 5/DiscoveryService, avec ses propres
 * routes dédiées, pourra résoudre proprement le cas guest par slug).
 *
 * En revanche, DÈS QU'un JWT valide identifie un tenant, la résolution qui suit ne
 * tolère plus aucun fallback silencieux : toute incohérence (header locationId hors
 * scope, aucune location primaire) throw. C'est le sens strict de la contrainte
 * "jamais d'erreur de résolution avalée" — elle s'applique à partir du moment où il y a
 * effectivement quelque chose à résoudre.
 *
 * ⚠️ tenantId = payload.salonId est un PLACEHOLDER Sprint 1. Le Sprint 2 (Membership)
 * remplacera cette source par la résolution multi-tenant via memberships — ne rien
 * construire de définitif sur cette lecture directe du JWT.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly jwt: JwtService,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly locations: LocationService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);
    if (!token) {
      next();
      return;
    }

    let payload: AuthUser;
    try {
      payload = await this.jwt.verifyAsync<AuthUser>(token);
    } catch {
      // Token présent mais invalide/expiré : pas une erreur de résolution tenant — on
      // laisse passer sans contexte. JwtGuard, sur les routes qui l'exigent, rejettera
      // la requête lui-même avec le même message qu'aujourd'hui.
      next();
      return;
    }

    // ⚠️ PLACEHOLDER Sprint 1 — voir docstring de la classe.
    const tenantId = payload.salonId;
    if (!tenantId) {
      next();
      return;
    }

    const scope = { salonId: tenantId };
    const role = payload.role as TenantRole;

    // Bootstrap : `staffs` est TENANT_SCOPED, donc cette lecture doit déjà tourner sous un
    // contexte pour satisfaire le plugin — alors même que c'est CETTE lecture qui sert à
    // construire le contexte final (locationId/locationIds pas encore connus, d'où les
    // placeholders). Trouvé en re-testant Prompt 4 de bout en bout : sans ce wrapper,
    // TOUT login stylist/colorist authentifié aurait throw "No tenant context available"
    // dès sa première requête — jamais capturé avant car ni le boot ni les tests isolés
    // du plugin (Prompt 3) n'exerçaient ce chemin précis.
    let staff: StaffDocument | null = null;
    if (payload.staffId) {
      staff = await runWithTenant(
        { tenantId, locationId: '', locationIds: [], role, plan: 'starter', features: {}, limits: {} },
        () => this.staffModel.findById(payload.staffId).select('locationIds defaultLocationId').exec(),
      );
    }

    const locationIds =
      role === 'stylist' || role === 'colorist'
        ? (staff?.locationIds ?? [])
        : (await this.locations.findAllForTenant(scope)).map((l) => l._id.toString());

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
    } else if (staff?.defaultLocationId) {
      locationId = staff.defaultLocationId;
    } else {
      try {
        const primary = await this.locations.findPrimary(scope);
        locationId = primary._id.toString();
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
        // Un tenant sans location primaire est un incident de provisioning, pas un 404
        // ordinaire — diagnosticable immédiatement plutôt que noyé dans des 404 répétés.
        this.logger.error(`No primary location for tenant ${tenantId} — provisioning incomplete or primary was deleted.`);
        throw new TenantMisconfiguredException(tenantId, 'no primary location configured');
      }
    }

    this.logger.warn(
      `Entitlements JWT not implemented yet (Prompt 7) — tenant ${tenantId} falling back to plan '${STARTER_PLAN_DEFAULTS.plan}'.`,
    );

    const ctx: TenantContext = {
      tenantId,
      locationId,
      locationIds,
      role,
      userId: payload.sub,
      staffId: payload.staffId,
      clientId: payload.clientId,
      plan: STARTER_PLAN_DEFAULTS.plan,
      features: { ...STARTER_PLAN_DEFAULTS.features },
      limits: { ...STARTER_PLAN_DEFAULTS.limits },
    };

    runWithTenant(ctx, () => next());
  }
}
