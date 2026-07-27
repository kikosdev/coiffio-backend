import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { Aggregate, Document, Model, PipelineStage, Query, Schema, Types } from 'mongoose';
import { GLOBAL, LOCATION_SCOPED, UNSCOPED } from './scoping-registry';
import { getTenantContext, tenantStorage } from './tenant-context';

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

function applyQueryScope(query: Query<unknown, unknown>): void {
  const collectionName = collectionNameOfQuery(query);
  if (!collectionName || isScopeExempt(collectionName)) return;

  const store = tenantStorage.getStore();
  if (store?.bypass) {
    logger.warn(`Tenant scope bypass on query (${collectionName}): ${store.bypassReason}`);
    return;
  }
  if (store?.discovery) {
    // Prompt 5 (DiscoveryService) pas encore construit — la projection restreinte aux
    // champs whitelistés est de sa responsabilité, pas de ce plugin. Laisse passer.
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
  if (!collectionName || isScopeExempt(collectionName)) return;

  const store = tenantStorage.getStore();
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
      if (!collectionName || isScopeExempt(collectionName)) {
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
      if (collectionName && !isScopeExempt(collectionName)) {
        for (const doc of docs as Record<string, unknown>[]) applyWriteScope(doc, collectionName);
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
