import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { Aggregate, Document, Model, PipelineStage, Query, Schema, Types } from 'mongoose';
import { GLOBAL, GUEST_READABLE, LOCATION_SCOPED, PUBLIC_DISCOVERY, PUBLIC_DISCOVERY_FIELDS, UNSCOPED } from './scoping-registry';
import { getTenantContext, isDiscoveryContext, isGuestContext, tenantStorage } from './tenant-context';

const logger = new Logger('TenantScopePlugin');

/**
 * Suivi (hors du schéma lui-même — évite de se battre avec le typage de SchemaOptions
 * pour une métadonnée arbitraire) des schémas effectivement passés par ce plugin. Sert
 * uniquement à vérifier au boot que `mongoose.plugin()` a bien été enregistré AVANT la
 * construction des schémas applicatifs (voir `assertPluginApplied` + main.ts). Si un
 * modèle en est absent, le plugin global n'a structurellement pas pu s'appliquer à lui —
 * exactement le genre d'oubli silencieux que ce plugin existe pour éliminer.
 */
const pluginAppliedSchemas = new WeakSet<Schema>();

function isScopeExempt(collectionName: string): boolean {
  return (UNSCOPED as readonly string[]).includes(collectionName) || (GLOBAL as readonly string[]).includes(collectionName);
}

/**
 * Applique la whitelist de champs + le blocage de collection en mode découverte. Appelée
 * depuis les trois chemins (query/aggregate) — jamais un simple laisser-passer, contraint
 * par le point critique hérité du Prompt 3 (spec Prompt 5, §critique).
 */
function assertDiscoveryCollectionAllowed(collectionName: string): void {
  if (!(PUBLIC_DISCOVERY as readonly string[]).includes(collectionName)) {
    throw new ForbiddenException(`Discovery mode cannot access non-whitelisted collection: ${collectionName}`);
  }
}

/**
 * Durcissement post-Sprint-1-v2 (trou trouvé au Prompt 6, fermé avant Sprint 2) : même
 * principe que `assertDiscoveryCollectionAllowed`, mais pour `runAsGuest`. Contrairement à la
 * découverte, un contexte guest reste mono-tenant (`ctx.tenantId` réel) — cette fonction ne
 * remplace donc PAS l'injection normale salonId/locationId qui suit, elle ajoute juste un
 * filtre de COLLECTION en amont : une lecture guest hors `GUEST_READABLE` throw avant même
 * d'atteindre cette injection.
 */
function assertGuestCollectionAllowed(collectionName: string): void {
  if (!(GUEST_READABLE as readonly string[]).includes(collectionName)) {
    throw new ForbiddenException(`Guest mode cannot read non-whitelisted collection: ${collectionName}`);
  }
}

/**
 * `QUERY_HOOKS` (plus bas) fait passer `updateOne`/`updateMany`/`deleteOne`/`deleteMany`/
 * `findOneAndUpdate`/`findOneAndDelete` par le MÊME hook Mongoose que les vraies lectures
 * (`find`/`findOne`/`count`/`countDocuments`) — un artefact de l'architecture du plugin, pas
 * une lecture au sens du spec ("Toute LECTURE guest... → THROW"). La whitelist guest ne doit
 * restreindre QUE les opérations de lecture réelles ; les écritures via ces hooks (ex.
 * `NotificationsService.dispatchOnce`'s `updateOne` upsert) restent volontairement
 * non-restreintes, comme `.create()`/`.save()` (`applyWriteScope`, jamais touché ici).
 */
const GUEST_RESTRICTED_READ_OPS = new Set(['find', 'findOne', 'count', 'countDocuments']);

function isReadOp(query: Query<unknown, unknown>): boolean {
  return GUEST_RESTRICTED_READ_OPS.has((query as unknown as { op?: string }).op ?? '');
}

function assertPlainString(value: unknown, label: string): void {
  if (value instanceof Types.ObjectId) {
    throw new InternalServerErrorException(`Invariant #1 violated: ${label} must be a plain String, got ObjectId.`);
  }
}

function collectionNameOfQuery(query: Query<unknown, unknown>): string | undefined {
  return query.model?.collection?.name;
}

function collectionNameOfDoc(doc: Document): string | undefined {
  // Les sous-documents embarqués (_id:false, ex. LocationAddress) n'ont pas de `.collection`
  // — seuls les documents backés par un vrai Model en ont un. C'est le garde-fou qui évite
  // que ce hook, posé globalement, ne s'exécute par erreur sur un sous-document lors du
  // save en cascade de son parent.
  return (doc as unknown as { collection?: { name?: string } }).collection?.name;
}

/**
 * Durci post-Sprint-1-v2 (trou trouvé au Prompt 6, fermé avant Sprint 2 — voir docstring
 * complète sur `runAsGuest` dans tenant-context.ts) : un contexte guest (`isGuestContext`)
 * passe désormais par `assertGuestCollectionAllowed` avant les vérifications tenant/location
 * normales — une lecture hors `GUEST_READABLE` (`clients`/`payments`/... compris) throw ici,
 * structurellement, plutôt que de dépendre de l'absence de route contrôleur publique
 * l'exposant.
 */
function applyQueryScope(query: Query<unknown, unknown>): void {
  const collectionName = collectionNameOfQuery(query);
  if (!collectionName) return;

  const store = tenantStorage.getStore();

  // Vérifié AVANT isScopeExempt à dessein : `salons` est UNSCOPED (donc normalement
  // exempté) mais reste la collection la plus sensible (email, phone, taxRate...) —
  // en mode découverte, elle doit quand même passer par la whitelist de champs, pas
  // être laissée passer sous prétexte qu'elle échappe au scope tenant habituel.
  if (store && isDiscoveryContext(store)) {
    assertDiscoveryCollectionAllowed(collectionName);
    const fields = PUBLIC_DISCOVERY_FIELDS[collectionName];
    if (fields) query.select(fields.join(' '));
    // Filtre de ligne pour staffs : jamais un profil non public, même si le
    // DiscoveryService oublie de le filtrer lui-même — backstop, pas la seule barrière.
    if (collectionName === 'staffs') {
      const filter = query.getFilter() as Record<string, unknown>;
      query.setQuery({ ...filter, 'publicProfile.visible': true });
    }
    return; // volontairement cross-tenant : aucune injection salonId/locationId ici
  }

  if (isScopeExempt(collectionName)) return;

  // Vérifié APRÈS isScopeExempt, contrairement à la découverte : `users`/`clientprofiles`
  // (GLOBAL) restent lisibles sous un contexte guest exactement comme partout ailleurs
  // (ex. `NotificationsService.resolvePushRecipients`, appelé en fire-and-forget depuis
  // une notification déclenchée par un booking public) — seules les collections
  // TENANT/LOCATION_SCOPED, qui exigent une résolution de contexte, passent par la
  // whitelist `GUEST_READABLE`.
  if (store && isGuestContext(store) && isReadOp(query)) {
    assertGuestCollectionAllowed(collectionName);
    // Pas de `return` ici, contrairement à la découverte : un contexte guest reste
    // mono-tenant — l'injection normale salonId/locationId ci-dessous doit continuer.
  }

  if (store?.bypass) {
    logger.warn(`Tenant scope bypass on query (${collectionName}): ${store.bypassReason}`);
    return;
  }

  const ctx = getTenantContext(); // throws InternalServerErrorException si aucun contexte
  assertPlainString(ctx.tenantId, 'tenantId');

  const filter = query.getFilter() as Record<string, unknown>;

  if (filter.salonId !== undefined) {
    assertPlainString(filter.salonId, 'salonId (filter)');
    if (filter.salonId !== ctx.tenantId) {
      throw new ForbiddenException('Cross-tenant query blocked');
    }
  } else {
    query.setQuery({ ...filter, salonId: ctx.tenantId });
  }

  if ((LOCATION_SCOPED as readonly string[]).includes(collectionName)) {
    const current = query.getFilter() as Record<string, unknown>;
    if (current.locationId !== undefined) {
      assertPlainString(current.locationId, 'locationId (filter)');
      if (!ctx.locationIds.includes(current.locationId as string)) {
        throw new ForbiddenException('Cross-location query blocked');
      }
    } else {
      query.setQuery({ ...current, locationId: ctx.locationId });
    }
  }
}

function applyWriteScope(target: Record<string, unknown>, collectionName: string): void {
  const store = tenantStorage.getStore();
  if (store?.bypass) {
    logger.warn(`Tenant scope bypass on write (${collectionName}): ${store.bypassReason}`);
    return;
  }
  if (store && isDiscoveryContext(store)) {
    // La découverte est une vitrine en lecture seule — aucune écriture ne doit jamais
    // s'y produire, même par accident de code. Backstop, pas la seule barrière.
    throw new ForbiddenException('Discovery mode is read-only — writes are never permitted.');
  }

  const ctx = getTenantContext();
  assertPlainString(ctx.tenantId, 'tenantId');

  if (target.salonId !== undefined && target.salonId !== null) {
    assertPlainString(target.salonId, 'salonId (document)');
    if (target.salonId !== ctx.tenantId) {
      throw new ForbiddenException('Cross-tenant write blocked');
    }
  } else {
    target.salonId = ctx.tenantId;
  }

  if ((LOCATION_SCOPED as readonly string[]).includes(collectionName)) {
    if (target.locationId === undefined || target.locationId === null) {
      target.locationId = ctx.locationId;
    } else {
      assertPlainString(target.locationId, 'locationId (document)');
    }
  }
}

function applyAggregateScope(agg: Aggregate<unknown>): void {
  const model = typeof agg.model === 'function' ? agg.model() : undefined;
  const collectionName = model?.collection?.name;
  if (!collectionName) return;

  const store = tenantStorage.getStore();

  if (store && isDiscoveryContext(store)) {
    // Contrairement à find() (`.select()` universellement sûr), un pipeline d'agrégation
    // peut légitimement RESHAPER les documents (ex. $group pour /discovery/regions, qui
    // ne renvoie que { region, count } — aucune fuite possible sur ces deux champs-là).
    // Forcer un $project figé sur les noms de champs de la whitelist casserait un tel
    // $group. Le garde-fou ici reste réel mais plus étroit : collection whitelistée
    // uniquement, pas de projection auto-devinée. `nearby()` (find-like, sans $group)
    // ajoute lui-même son propre $project conforme à la whitelist, comme find().
    assertDiscoveryCollectionAllowed(collectionName);
    return; // volontairement cross-tenant : aucun $match salonId/locationId ici
  }

  if (isScopeExempt(collectionName)) return;

  // Même raison que dans applyQueryScope : vérifié APRÈS isScopeExempt pour ne pas
  // restreindre les collections GLOBAL (users/clientprofiles), déjà exemptées partout.
  if (store && isGuestContext(store)) {
    assertGuestCollectionAllowed(collectionName);
    // Pas de `return` ici : mono-tenant, l'injection $match salonId/locationId continue.
  }

  if (store?.bypass) {
    logger.warn(`Tenant scope bypass on aggregate (${collectionName}): ${store.bypassReason}`);
    return;
  }

  const ctx = getTenantContext();
  assertPlainString(ctx.tenantId, 'tenantId');

  const matchStage: Record<string, unknown> = { salonId: ctx.tenantId };
  if ((LOCATION_SCOPED as readonly string[]).includes(collectionName)) {
    matchStage.locationId = ctx.locationId;
  }

  const pipeline = agg.pipeline();
  const first = pipeline[0] as unknown as Record<string, unknown> | undefined;

  if (first && typeof first === 'object' && '$match' in first) {
    const existingMatch = first.$match as Record<string, unknown>;
    if (existingMatch.salonId !== undefined) {
      assertPlainString(existingMatch.salonId, 'salonId ($match)');
      if (existingMatch.salonId !== ctx.tenantId) {
        throw new ForbiddenException('Cross-tenant aggregate blocked');
      }
    }
    first.$match = { ...matchStage, ...existingMatch };
  } else {
    pipeline.unshift({ $match: matchStage } as PipelineStage);
  }
}

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'count',
  'countDocuments',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const;

/**
 * Plugin Mongoose global — cœur du Sprint 1 v2 (Prompt 3). L'isolation devient
 * structurelle : une requête sans TenantContext throw, elle ne retourne jamais de
 * données silencieusement non filtrées.
 *
 * ⚠️ Doit être enregistré via `mongoose.plugin(tenantScopePlugin)` AVANT que le premier
 * schéma applicatif ne soit construit (voir main.ts) — un plugin global Mongoose ne
 * s'applique qu'aux schémas créés APRÈS son enregistrement. `assertPluginApplied()`
 * vérifie cette condition au boot plutôt que de la supposer silencieusement correcte.
 */
export function tenantScopePlugin(schema: Schema): void {
  pluginAppliedSchemas.add(schema);

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook as never, function (this: Query<unknown, unknown>, next: (err?: Error) => void) {
      try {
        applyQueryScope(this);
        next();
      } catch (err) {
        next(err as Error);
      }
    });
  }

  // pre('validate'), pas pre('save') : les validateurs `required` de Mongoose tournent
  // DANS validate(), qui s'exécute AVANT les hooks pre('save') — si salonId/locationId
  // sont required et injectés seulement à pre('save'), la validation required échoue
  // avant même que l'injection n'ait eu lieu. Trouvé empiriquement (cas #4 du run manuel
  // Prompt 3 : `Appointment validation failed: salonId: Path 'salonId' is required`).
  schema.pre('validate', function (this: Document, next) {
    try {
      const collectionName = collectionNameOfDoc(this);
      if (!collectionName) {
        next();
        return;
      }
      const store = tenantStorage.getStore();
      // Vérifié AVANT isScopeExempt : une écriture en mode découverte doit throw même
      // sur une collection normalement exemptée (ex. `salons`) — la découverte est une
      // vitrine en lecture seule, sans exception.
      if (store && isDiscoveryContext(store)) {
        throw new ForbiddenException('Discovery mode is read-only — writes are never permitted.');
      }
      if (isScopeExempt(collectionName)) {
        next();
        return;
      }
      applyWriteScope(this as unknown as Record<string, unknown>, collectionName);
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  schema.pre('insertMany', function (this: Model<unknown>, next, docs: unknown) {
    try {
      const collectionName = this.collection?.name;
      if (collectionName) {
        const store = tenantStorage.getStore();
        if (store && isDiscoveryContext(store)) {
          throw new ForbiddenException('Discovery mode is read-only — writes are never permitted.');
        }
        if (!isScopeExempt(collectionName)) {
          for (const doc of docs as Record<string, unknown>[]) applyWriteScope(doc, collectionName);
        }
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  schema.pre('aggregate', function (this: Aggregate<unknown>, next) {
    try {
      applyAggregateScope(this);
      next();
    } catch (err) {
      next(err as Error);
    }
  });
}

/**
 * Vérifie au boot que le plugin a effectivement été appliqué à chaque modèle listé —
 * détecte l'oubli d'enregistrement global ou un mauvais ordre d'import (voir docstring
 * de `tenantScopePlugin`). Sans ce contrôle, un ordre d'import cassé désactiverait
 * l'isolation en silence pour tout ou partie des modèles.
 */
export function assertPluginApplied(models: Model<unknown>[]): void {
  const missing = models.filter((m) => !pluginAppliedSchemas.has(m.schema)).map((m) => m.modelName);
  if (missing.length > 0) {
    throw new Error(
      `[tenant-scope.plugin] ${missing.length} modèle(s) construit(s) sans le plugin de scope tenant : ` +
        `${missing.join(', ')}. mongoose.plugin(tenantScopePlugin) a probablement été enregistré trop tard ` +
        `(après la construction de ces schémas) — vérifie l'ordre d'import dans main.ts.`,
    );
  }
}
