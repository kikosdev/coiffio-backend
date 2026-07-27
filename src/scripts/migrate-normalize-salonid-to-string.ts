/**
 * Migration idempotente : normalise le type BSON de `salonId` en String sur
 * les 17 collections scopées tenant (Invariant #1, SKILL sprint 1 v2).
 *
 * Contexte : `salonId` est déclaré `Types.ObjectId` dans les schémas Mongoose
 * mais l'app écrit en pratique des strings (JWT / DEFAULT_SALON_ID). L'audit
 * a trouvé 3 collections en état mixte (clients, services, salonroles) et
 * notifications à 100% objectId — ce script aligne tout sur String avant que
 * le code (Étape 2/3) ne suppose ce type.
 *
 * Résilience : chaque collection est traitée indépendamment (try/catch) —
 * l'échec d'une collection n'interrompt jamais les suivantes. Pour les
 * collections portant un index unique composite au-delà de salonId seul
 * (voir UNIQUE_COMPOSITE_KEYS), un contrôle anti-collision tourne AVANT tout
 * updateMany : si convertir un doc objectId→string produirait une clé déjà
 * occupée par un doc string existant, la conversion de CETTE collection est
 * refusée et signalée (jamais d'écriture partielle silencieuse).
 * `clients` (salonId+phone) est volontairement exclu de ce garde-fou : son
 * index n'est pas réellement unique en base aujourd'hui (constat séparé,
 * traité ailleurs avec ClientProfile) — sa conversion suit le chemin standard.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-normalize-salonid-to-string.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-normalize-salonid-to-string.ts --apply
 *
 * Idempotent : ne modifie que les documents où salonId est encore un objectId.
 * Ne touche à aucun autre champ (_id, stylistId, clientId, userId, services[], etc.).
 */

import 'reflect-metadata';
import { Collection, MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

const COLLECTIONS = [
  'appointments',
  'staffs',
  'staffprofiles',
  'leaverequests',
  'schedules',
  'notifications',
  'clients',
  'products',
  'stockmoves',
  'sales',
  'expenses',
  'payments',
  'orders',
  'carts',
  'testimonials',
  'services',
  'salonroles',
];

// Collections portant un index unique COMPOSITE (salonId + autre(s) champ(s))
// à vérifier avant conversion. `clients` est volontairement absent : son
// index (salonId+phone) n'est pas unique en base (constat séparé, hors scope).
// `fields` = champs à comparer en plus de salonId. `requireExists` (optionnel)
// = champ qui doit exister pour que la contrainte s'applique (index partiel).
const UNIQUE_COMPOSITE_KEYS: Record<string, { fields: string[]; requireExists?: string }> = {
  staffs: { fields: ['email'] },
  staffprofiles: { fields: ['userId'] },
  schedules: { fields: ['stylistId'] },
  notifications: { fields: ['type', 'groupId'], requireExists: 'groupId' },
  salonroles: { fields: ['name'] },
};

interface TypeCounts {
  string: number;
  objectId: number;
  other: number;
}

async function typeCounts(col: Collection): Promise<TypeCounts> {
  const agg = await col
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: { $type: '$salonId' }, count: { $sum: 1 } } },
    ])
    .toArray();

  const counts: TypeCounts = { string: 0, objectId: 0, other: 0 };
  for (const row of agg) {
    if (row._id === 'string') counts.string = row.count;
    else if (row._id === 'objectId') counts.objectId = row.count;
    else counts.other += row.count;
  }
  return counts;
}

interface Collision {
  key: Record<string, unknown>;
  objectIdDocId: unknown;
  existingStringDocId: unknown;
}

/**
 * Simule la conversion objectId→string pour `col` et vérifie, pour chaque
 * doc candidat, si un doc string existant occupe déjà la même clé composite
 * (salonId converti + les autres champs de l'index unique). Ne modifie rien.
 */
async function findCollisions(
  col: Collection,
  spec: { fields: string[]; requireExists?: string },
): Promise<Collision[]> {
  const candidates = await col.find({ salonId: { $type: 'objectId' } }).toArray();
  const collisions: Collision[] = [];

  for (const doc of candidates) {
    if (spec.requireExists && (doc as Record<string, unknown>)[spec.requireExists] === undefined) {
      continue; // index partiel : la contrainte ne s'applique pas à ce doc
    }

    const key: Record<string, unknown> = { salonId: String(doc.salonId) };
    for (const field of spec.fields) {
      key[field] = (doc as Record<string, unknown>)[field];
    }

    const existing = await col.findOne({ ...key, _id: { $ne: doc._id } });
    if (existing) {
      collisions.push({ key, objectIdDocId: doc._id, existingStringDocId: existing._id });
    }
  }

  return collisions;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  console.log(`[migrate-normalize-salonid] Connected. Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const report: Array<{
    collection: string;
    before: TypeCounts;
    after: TypeCounts;
    modified: number;
    status: 'ok' | 'refused' | 'error' | 'skipped';
    detail?: string;
  }> = [];

  for (const name of COLLECTIONS) {
    const col = db.collection(name);

    try {
      const before = await typeCounts(col);
      let modified = 0;
      let status: 'ok' | 'refused' | 'error' | 'skipped' = 'ok';
      let detail: string | undefined;

      const guard = UNIQUE_COMPOSITE_KEYS[name];
      if (before.objectId > 0 && guard) {
        const collisions = await findCollisions(col, guard);
        if (collisions.length > 0) {
          status = 'refused';
          detail = `${collisions.length} collision(s) détectée(s) sur l'index unique composite — conversion refusée`;
          console.error(`\n[REFUS] ${name} : ${detail}`);
          for (const c of collisions) {
            console.error(
              `  clé=${JSON.stringify(c.key)} objectIdDoc=${c.objectIdDocId} entre en collision avec stringDoc=${c.existingStringDocId}`,
            );
          }
          report.push({ collection: name, before, after: before, modified: 0, status, detail });
          continue;
        }
      }

      if (apply && before.objectId > 0) {
        const result = await col.updateMany({ salonId: { $type: 'objectId' } }, [
          { $set: { salonId: { $toString: '$salonId' } } },
        ]);
        modified = result.modifiedCount;
      }

      const after = apply ? await typeCounts(col) : before;
      report.push({ collection: name, before, after, modified, status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n[ERREUR] ${name} : ${message}`);
      const fallback = await typeCounts(col).catch(() => ({ string: -1, objectId: -1, other: -1 }));
      report.push({
        collection: name,
        before: fallback,
        after: fallback,
        modified: 0,
        status: 'error',
        detail: message,
      });
      // Ne pas propager : on continue avec les collections suivantes.
    }
  }

  console.log('\n=== Rapport ===');
  console.log(
    'collection'.padEnd(16),
    'avant(str/obj)'.padEnd(16),
    'après(str/obj)'.padEnd(16),
    'modified'.padEnd(10),
    'status',
  );
  for (const r of report) {
    console.log(
      r.collection.padEnd(16),
      `${r.before.string}/${r.before.objectId}`.padEnd(16),
      `${r.after.string}/${r.after.objectId}`.padEnd(16),
      String(r.modified).padEnd(10),
      r.status + (r.detail ? ` (${r.detail})` : ''),
    );
  }

  if (!apply) {
    const convertible = report.filter((r) => r.status !== 'refused');
    const totalObjectId = convertible.reduce((sum, r) => sum + r.before.objectId, 0);
    const refusedNow = report.filter((r) => r.status === 'refused');
    console.log(
      `\n[DRY-RUN] ${totalObjectId} document(s) seraient converti(s) au total. Relancer avec --apply pour écrire.`,
    );
    if (refusedNow.length > 0) {
      console.log(
        `[DRY-RUN] ${refusedNow.length} collection(s) refuseraient la conversion (collision détectée) : ${refusedNow
          .map((r) => r.collection)
          .join(', ')}`,
      );
    }
    await client.close();
    return;
  }

  const refused = report.filter((r) => r.status === 'refused');
  const errored = report.filter((r) => r.status === 'error');
  if (refused.length > 0 || errored.length > 0) {
    console.log('\n=== Collections en échec ===');
    for (const r of refused) console.log(`  [REFUSÉ] ${r.collection} — ${r.detail}`);
    for (const r of errored) console.log(`  [ERREUR] ${r.collection} — ${r.detail}`);
  }

  console.log('\n=== Vérification post-migration ===');
  let nonConform = 0;
  for (const r of report) {
    if (r.after.objectId > 0) {
      console.error(
        `[ÉCHEC] ${r.collection} contient encore ${r.after.objectId} document(s) avec salonId en objectId.`,
      );
      nonConform += r.after.objectId;
    }
    if (r.after.other > 0) {
      console.error(
        `[ÉCHEC] ${r.collection} contient ${r.after.other} document(s) avec salonId d'un type inattendu (ni string ni objectId).`,
      );
      nonConform += r.after.other;
    }
  }

  await client.close();

  if (nonConform > 0) {
    console.error(
      `\n[migrate-normalize-salonid] ÉCHEC : ${nonConform} document(s) non conforme(s) après migration.`,
    );
    process.exit(1);
  }

  console.log('\n[migrate-normalize-salonid] OK : 100% string sur les 17 collections.');
}

main().catch((err) => {
  console.error('[migrate-normalize-salonid] Fatal:', err);
  process.exit(1);
});
