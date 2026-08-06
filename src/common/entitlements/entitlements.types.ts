/** Features gérées par le Control Plane (Sprint 3) — cf. SKILL Prompt 7. */
export type Feature = 'pos' | 'ecommerce' | 'mobileApp' | 'analytics' | 'customDomain' | 'api';

/** Limites gérées par le Control Plane (Sprint 3) — cf. SKILL Prompt 7. */
export type LimitKey = 'staffMax' | 'locationsMax' | 'appointmentsMonth' | 'smsQuota';

/** Payload attendu du JWT d'entitlements signé RS256 par le Control Plane. */
export interface EntitlementsJwtPayload {
  tenantId: string;
  plan: string;
  features: Partial<Record<Feature, boolean>>;
  limits: Partial<Record<LimitKey, number>>;
  status: 'active' | 'suspended' | 'churned';
  /**
   * [Delta 3, Sprint 3 Prompt 7] Overrides de feature flags résolus côté CP
   * (`FlagsService.resolveAllForTenant()`), fusionnés ici au `buildToken()`. Optionnel —
   * un CP antérieur à ce prompt n'émet pas ce champ, `undefined` doit rester silencieusement
   * traité comme "aucun flag actif" (voir `entitlements.service.ts#verifyRaw`), jamais une
   * raison de rejeter le token.
   */
  flags?: Record<string, boolean>;
  iat: number;
  exp: number;
}

/** Résultat résolu, toujours complet (toutes les clés Feature/LimitKey présentes) — ce que
 *  `TenantContext.plan/features/limits` porte réellement pendant la requête. */
export interface ResolvedEntitlements {
  plan: string;
  features: Record<Feature, boolean>;
  limits: Record<LimitKey, number>;
  status: 'active' | 'suspended' | 'churned';
  /** [Delta 3] Toujours présent (jamais `undefined`) — `{}` si le CP n'a émis aucun flag ou
   *  n'existe pas encore, exactement comme `features`/`limits` sont toujours complets même
   *  en fallback. `FlagsService.isEnabled()` lit directement cette clé. */
  flags: Record<string, boolean>;
  /** 'verified' = JWT CP vérifié avec succès. 'fallback' = CP absent/injoignable/token
   *  invalide — plan starter de secours, jamais un blocage (règle de survie, Prompt 7). */
  source: 'verified' | 'fallback';
}
