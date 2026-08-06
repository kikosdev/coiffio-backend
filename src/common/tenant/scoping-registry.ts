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

/**
 * Durcissement post-Sprint-1-v2 (trou trouvé au Prompt 6, fermé avant Sprint 2) : whitelist
 * structurelle des collections lisibles sous `runAsGuest` — même esprit que PUBLIC_DISCOVERY,
 * appliquée par le plugin lui-même, jamais une simple convention côté service. `clients` en
 * est délibérément EXCLU (une lecture y reste possible, mais uniquement via un contexte
 * interne scopé explicite — `bootstrapCtx`/`systemReadContext` — jamais via le contexte guest
 * ambiant). `orders`/`carts` sont inclus : un guest lit légitimement SON PROPRE panier/sa
 * propre commande (`OrdersService.getCart`/`.track`, déjà en prod) — ce n'est pas la même
 * classe de donnée que `clients`/`payments`/`sales` (jamais exposées, jamais nécessaires côté
 * storefront public). `staffs`/`staffprofiles`/`schedules` sont inclus aussi :
 * `BookingService.loadStylistContext` (disponibilité publique) lit les trois en direct, pas
 * seulement `appointments` — `staffs` omis dans une première version de cette liste, corrigé
 * par la suite de tests existante elle-même (`tenant-isolation`/`discovery`/
 * `storefront-guest` sont tombés à 403 dès le premier run) ; `staffprofiles`/`schedules`
 * trouvés par audit du code juste après (même méthode, pas encore couverts par un test).
 */
export const GUEST_READABLE = [
  'services',
  'appointments',
  'products',
  'salons',
  'locations',
  'testimonials',
  'orders',
  'carts',
  'staffs',
  'staffprofiles',
  'schedules',
] as const;

/** Identité, hors scope tenant. `memberships` ajouté au Sprint 2 v2 Prompt 1 — lu
 *  cross-tenant par `userId` pour résoudre TOUS les tenants d'un user (c'est le point),
 *  mais toute requête backoffice filtre `tenantId` explicitement côté service
 *  (`MembershipService`), jamais une injection du plugin (exempté ici). `refreshtokens`
 *  n'existe pas encore — à ajouter au fur et à mesure. */
export const GLOBAL = ['users', 'clientprofiles', 'memberships'] as const;

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
  'invitations',
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

/**
 * Whitelist de champs par collection pour le mode découverte (Prompt 5) — appliquée par
 * le plugin lui-même (`tenant-scope.plugin.ts`) comme filet de sécurité, PAS seulement
 * par les `.select()` du DiscoveryService. Noms de champs RÉELS du schéma, pas ceux du
 * texte du spec — plusieurs divergent (constaté à l'écriture de ce prompt, jamais deviné) :
 *   - salons.logo / salons.description / salons.rating → n'existent pas sur le schéma.
 *     Absents ici ; DiscoveryService renvoie `null`, jamais une valeur fabriquée.
 *   - locations : lat/lng sont imbriqués dans `address`, pas des champs plats — on
 *     sélectionne `address` en entier (qui les contient).
 *   - services.duration → le champ réel est `durationMin`.
 *   - testimonials.rating → n'existe pas sur ce schéma (pas de note chiffrée, juste
 *     `isApproved`/`order`). testimonials.comment → le champ réel est `quote`.
 *     authorFirstName → dérivé de `authorName.split(' ')[0]` côté DiscoveryService,
 *     le schéma n'a qu'un nom complet.
 *   - staffs.avatar → n'existe pas sur ce schéma. Absent ; toujours `null` en sortie.
 */
export const PUBLIC_DISCOVERY_FIELDS: Record<string, string[]> = {
  salons: ['name', 'slug'],
  locations: ['name', 'address', 'phone', 'openingHours', 'region'],
  services: ['name', 'category', 'price', 'durationMin'],
  testimonials: ['quote', 'authorName', 'isApproved', 'order', 'createdAt'],
  staffs: ['name', 'role', 'publicProfile'],
};

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
