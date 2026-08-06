import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { StaffDocument } from '../../../team/schemas/staff.schema';
import { LocationDocument } from '../../../locations/schemas/location.schema';
import { ENFORCES_LIMIT_KEY } from '../decorators/enforces-limit.decorator';
import { LimitKey } from '../entitlements.types';
import { getTenantContext } from '../../tenant/tenant-context';

/**
 * Limites HARD uniquement (staffMax, locationsMax) — 403 bloquant. Compte l'usage courant
 * du tenant (re-lu en base à chaque appel, pas de cache : l'usage change à chaque
 * création/désactivation, un compteur périmé casserait la garantie). Les quotas de volume
 * (appointmentsMonth, smsQuota) sont SOFT et ne passent JAMAIS par ce guard — voir
 * `EntitlementsService.checkSoftLimit`.
 *
 * `@InjectConnection()` + `connection.model(...)` plutôt que `@InjectModel()` : ce guard est
 * référencé par CLASSE via `@UseGuards(LimitGuard)` depuis des modules qui n'enregistrent
 * pas forcément Staff/Location eux-mêmes (ex. LocationsModule n'a pas Staff). Constaté
 * empiriquement (scratch, boot réel) qu'un `@InjectModel()` déclaré dans `EntitlementsModule`
 * ne se résout pas de façon fiable pour un guard consommé par classe depuis un autre module
 * — Nest tente de le résoudre dans le contexte DI du module APPELANT. La connexion Mongoose
 * (`MongooseCoreModule`) est globale par construction du package `@nestjs/mongoose` ; les
 * modèles y sont déjà compilés par leurs modules propriétaires (TeamModule/LocationsModule),
 * plugin de scope inclus (appliqué une fois sur la connexion, pas par forFeature).
 */
@Injectable()
export class LimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitKey = this.reflector.getAllAndOverride<LimitKey | undefined>(ENFORCES_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!limitKey) return true;

    const ctx = getTenantContext();
    const limit = ctx.limits[limitKey];
    const current = await this.countCurrentUsage(limitKey, ctx.tenantId);

    if (current >= limit) {
      throw new ForbiddenException({
        code: 'LIMIT_REACHED',
        limitKey,
        currentPlan: ctx.plan,
        current,
        limit,
        message: `Limit '${limitKey}' reached for the '${ctx.plan}' plan (${current}/${limit}).`,
      });
    }
    return true;
  }

  private async countCurrentUsage(limitKey: LimitKey, tenantId: string): Promise<number> {
    if (limitKey === 'staffMax') {
      return this.connection.model<StaffDocument>('Staff').countDocuments({ salonId: tenantId, isActive: true });
    }
    if (limitKey === 'locationsMax') {
      return this.connection.model<LocationDocument>('Location').countDocuments({ salonId: tenantId, active: true });
    }
    throw new Error(`LimitGuard: unsupported HARD limitKey '${limitKey}' — only staffMax/locationsMax are enforced here.`);
  }
}
