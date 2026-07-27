/**
 * Source de vérité du scoping (Sprint 1 v2, Prompt 3). Classement validé — reprend
 * l'inventaire réel des modèles Mongoose de l'étape 0c (voir rapport d'audit), pas une
 * liste devinée. Toute collection ci-dessous est une COLLECTION MongoDB (nom au pluriel,
 * tel que retourné par `Model.collection.name`), pas un nom de classe/modèle Mongoose.
 */

/** Lecture cross-tenant, UNIQUEMENT via DiscoveryService (Prompt 5, pas encore construit).
 *  N'est PAS un niveau de scope : une collection ici reste par ailleurs classée dans
 *  TENANT_SCOPED ou UNSCOPED ci-dessous — c'est juste une autorisation d'accès en plus. */
export const PUBLIC_DISCOVERY = ['salons', 'locations', 'services', 'testimonials', 'staffs'] as const;

/** Identité, hors scope tenant. `memberships`/`refreshtokens` n'existent pas encore — à
 *  ajouter ici au fur et à mesure de leur création (Sprint 2). */
export const GLOBAL = ['users', 'clientprofiles'] as const;

/** `salonId` seul. */
export const TENANT_SCOPED = [
  'clients',
  'services',
  'staffs',
  'staffprofiles',
  'locations',
  'salonroles',
  'leaverequests',
  'notifications',
  'testimonials',
] as const;

/** `salonId` + `locationId`. */
export const LOCATION_SCOPED = [
  'appointments',
  'payments',
  'sales',
  'expenses',
  'products',
  'stockmoves',
  'schedules',
  'orders',
  'carts',
] as const;

/** Le doc tenant lui-même. */
export const UNSCOPED = ['salons'] as const;

const ALL_SCOPED_COLLECTIONS = new Set<string>([...GLOBAL, ...TENANT_SCOPED, ...LOCATION_SCOPED, ...UNSCOPED]);

/**
 * Throw au boot si un modèle Mongoose enregistré n'appartient à aucune des quatre listes
 * de scope réel (GLOBAL | TENANT_SCOPED | LOCATION_SCOPED | UNSCOPED — PUBLIC_DISCOVERY
 * exclu, ce n'est pas un niveau de scope). Rend structurellement impossible d'ajouter une
 * collection sans décision de scope explicite : l'app ne démarre pas sinon.
 *
 * @param collectionNames noms de COLLECTION (pas noms de modèle) — ex. `mongoose.modelNames()`
 *   résolus via `mongoose.model(name).collection.name`, pas les noms de classe bruts.
 */
export function assertRegistryCoverage(collectionNames: string[]): void {
  const missing = collectionNames.filter((name) => !ALL_SCOPED_COLLECTIONS.has(name));
  if (missing.length > 0) {
    throw new Error(
      `[scoping-registry] ${missing.length} collection(s) enregistrée(s) sans scope assigné : ` +
        `${missing.join(', ')}. Ajoute chacune à GLOBAL, TENANT_SCOPED, LOCATION_SCOPED ou UNSCOPED ` +
        `dans scoping-registry.ts avant de redémarrer.`,
    );
  }
}
