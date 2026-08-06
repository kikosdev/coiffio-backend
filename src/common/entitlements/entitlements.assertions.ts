import { ForbiddenException } from '@nestjs/common';
import { Feature } from './entitlements.types';

/**
 * Payload 403 partagé entre `FeatureGuard` (routes backoffice, contexte déjà posé par
 * TenantContextMiddleware avant la phase guard) et `GuestScopeService.run()` (routes
 * storefront publiques : le contexte n'existe qu'À L'INTÉRIEUR du callback `runAsGuest`,
 * donc un `CanActivate` classique ne peut pas y lire `getTenantContext()` — le check doit
 * se faire manuellement, avec exactement le même payload).
 */
export function assertFeature(plan: string, features: Record<string, boolean>, feature: Feature): void {
  if (features[feature]) return;
  throw new ForbiddenException({
    code: 'FEATURE_NOT_IN_PLAN',
    feature,
    currentPlan: plan,
    // Aucun catalogue de plans n'existe encore (Control Plane, Sprint 3) — champ présent
    // dès maintenant pour le contrat frontend, rempli pour de vrai dès que le catalogue existera.
    requiredPlan: null,
    message: `Feature '${feature}' is not included in the '${plan}' plan.`,
  });
}
