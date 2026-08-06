/**
 * Liste (jamais d'écriture) les index composites `{salonId, locationId}` à créer sur les
 * 9 collections LOCATION_SCOPED (Sprint 1 v2, Prompt 6, Partie B).
 *
 * Chaque collection a déjà un index simple sur `locationId` seul (ajouté Prompt 4/5, cf.
 * `@Prop({ index: true })` sur chaque schéma) — insuffisant une fois que le plugin de scope
 * (Prompt 3) filtre systématiquement par `salonId` ET `locationId` ensemble : Mongo ne peut
 * combiner deux index single-field via un index intersection efficace à l'échelle, il faut
 * un vrai index composé.
 *
 * Portée volontairement restreinte au composé `{salonId:1, locationId:1}` de base pour
 * chacune des 9 collections — c'est la forme structurelle garantie par le plugin de scope,
 * pas une supposition. Étendre des index composés EXISTANTS (ex. le `{salonId,stylistId,
 * start,end}` d'appointments) avec `locationId` est laissé à une passe ultérieure, une fois
 * qu'un vrai pattern de requête multi-champs incluant locationId existe dans le code — pas
 * fabriqué ici.
 *
 * Ce script n'écrit JAMAIS d'index (pas de mode --apply). Il introspecte les index réels
 * via `.indexes()` et imprime les commandes `createIndex` à lancer manuellement (mongosh
 * ou migration dédiée) une fois la décision validée.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-create-indexes.ts
 */

import 'reflect-metadata';
import { Db, MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

const LOCATION_SCOPED_COLLECTIONS = [
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

const PROPOSED_COMPOUND = { salonId: 1, locationId: 1 } as const;

function indexKeyLabel(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([field, dir]) => `${field}:${dir}`)
    .join(', ');
}

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k]);
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db();
  console.log('[migrate-create-indexes] Connected. Mode: LIST-ONLY (aucune écriture).');

  const toCreate: { collection: string; key: Record<string, number> }[] = [];

  for (const collectionName of LOCATION_SCOPED_COLLECTIONS) {
    const coll = db.collection(collectionName);
    const existing = await coll.indexes();

    console.log(`\n=== ${collectionName} ===`);
    console.log('Index existants :');
    for (const idx of existing) {
      console.log(`  ${idx.name} → { ${indexKeyLabel(idx.key as Record<string, unknown>)} }`);
    }

    const alreadyHasCompound = existing.some((idx) => sameKey(idx.key as Record<string, unknown>, PROPOSED_COMPOUND));
    if (alreadyHasCompound) {
      console.log(`  ✓ Composé { ${indexKeyLabel(PROPOSED_COMPOUND)} } déjà présent — rien à faire.`);
    } else {
      console.log(`  → À créer : { ${indexKeyLabel(PROPOSED_COMPOUND)} }`);
      toCreate.push({ collection: collectionName, key: PROPOSED_COMPOUND as unknown as Record<string, number> });
    }
  }

  console.log(`\n=== Commandes à lancer manuellement (${toCreate.length}) ===`);
  if (toCreate.length === 0) {
    console.log('Aucune — tous les index composés proposés existent déjà.');
  }
  for (const { collection, key } of toCreate) {
    console.log(`db.${collection}.createIndex(${JSON.stringify(key)}, { background: true });`);
  }

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-create-indexes] Fatal:', err);
  process.exit(1);
});
