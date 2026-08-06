import { getTenantContext } from '../tenant/tenant-context';

export interface SalonScope {
  salonId: string;
}

/**
 * Construit un SalonScope depuis le TenantContext courant (AsyncLocalStorage, peuplé par
 * TenantContextMiddleware). Zéro fallback : `getTenantContext()` throw s'il n'y a pas de
 * contexte — jamais un tenant deviné.
 *
 * Ce fichier n'est PAS supprimé (le spec le demandait) : les services prennent toujours
 * `scope: SalonScope` en paramètre — ce nettoyage est un prompt de suivi séparé (décision
 * explicite, vu le volume : ~100+ call sites sur ~14 services).
 *
 * Sprint 2 v2 Prompt 4 : `getSalonScope(req)` (fallback `DEFAULT_SALON_ID`) a été retiré —
 * sa propre docstring le disait "nécessaire" pour les routes storefront à JWT optionnel/
 * absent (booking/orders/stock), mais un grep confirme qu'AUCUNE de ces routes ne l'appelle
 * plus depuis leur migration vers `GuestScopeService`/`runAsGuest` (Sprint 1 v2, Prompt 6,
 * Partie C) — 0 usage réel, du code mort dont la justification n'était plus vraie.
 */
export function currentScope(): SalonScope {
  return { salonId: getTenantContext().tenantId };
}
