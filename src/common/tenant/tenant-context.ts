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
  impersonatedBy?: string; // Prompt 8, pas encore construit
  /** Posé UNIQUEMENT par runOutsideTenant — jamais par le middleware HTTP. */
  bypass?: boolean;
  bypassReason?: string;
  /** Posé par DiscoveryService (Prompt 5, pas encore construit) — lecture cross-tenant
   *  avec projection restreinte, jamais par le middleware HTTP standard. */
  discovery?: boolean;
}

const logger = new Logger('TenantContext');

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

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
 * Storefront public (Prompt 5, pas encore construit) — tenant résolu par slug, sans JWT.
 * Contexte role='guest', locationIds réduit à la seule location résolue.
 */
export function runAsGuest<T>(tenantId: string, locationId: string, fn: () => T): T {
  const ctx: TenantContext = {
    tenantId,
    locationId,
    locationIds: [locationId],
    role: 'guest',
    plan: 'starter',
    features: {},
    limits: {},
  };
  return tenantStorage.run(ctx, fn);
}
