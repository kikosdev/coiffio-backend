import { Injectable } from '@nestjs/common';
import { tenantStorage } from '../tenant/tenant-context';

/**
 * [Delta 3, Sprint 3 Prompt 7] Point de lecture DP des feature flags émis par le CP
 * (`FeatureFlag.overrides` -> fusionnés au `buildToken()` -> `TenantContext.flags`, posé par
 * `TenantContextMiddleware`). Avant ce prompt, RIEN dans `salon-backend` ne lisait jamais ce
 * champ — c'est la "vraie petite tâche DP" nommée par le SKILL, pas un simple passe-plat CP.
 *
 * Lit `tenantStorage.getStore()` DIRECTEMENT (jamais `getTenantContext()`, qui throw sans
 * contexte établi) — même raisonnement que `DestructiveGuard` (DP-SWEEP, Sprint 3) : un
 * appel fait hors contexte (job cron, script) doit lire "aucun flag actif", jamais crasher.
 */
@Injectable()
export class FlagsService {
  isEnabled(key: string): boolean {
    return tenantStorage.getStore()?.flags?.[key] === true;
  }
}
