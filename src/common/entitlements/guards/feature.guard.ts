import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_FEATURE_KEY } from '../decorators/requires-feature.decorator';
import { Feature } from '../entitlements.types';
import { assertFeature } from '../entitlements.assertions';
import { getTenantContext } from '../../tenant/tenant-context';

/**
 * Lit `TenantContext.features` — déjà résolu une fois par requête (middleware pour le
 * backoffice, `GuestScopeService` pour le storefront public), jamais re-résolu ici. À
 * utiliser APRÈS JwtGuard/OptionalJwtGuard (qui posent le contexte tenant en amont, via le
 * middleware ou `GuestScopeService.run`).
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(REQUIRES_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const ctx = getTenantContext();
    assertFeature(ctx.plan, ctx.features, feature);
    return true;
  }
}
