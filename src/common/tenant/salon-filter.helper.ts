import { getTenantContext } from './tenant-context';

/**
 * Sucre syntaxique pour la lisibilité des services — le plugin (`tenant-scope.plugin.ts`)
 * reste la vraie barrière : un service qui oublie d'appeler `salonFilter()` est quand
 * même protégé, ce helper n'est là que pour rendre l'intention explicite dans le code.
 */
export function salonFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ctx = getTenantContext();
  return { salonId: ctx.tenantId, ...extra };
}
