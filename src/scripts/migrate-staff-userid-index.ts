/**
 * Migration Sprint 2 v2, Prompt 3 (Option B, owner multi-tenant) — remplace l'index unique
 * global `staffs.{userId:1}` par un index composite unique `{userId:1, salonId:1}`.
 *
 * Contexte : l'ancien index limitait un `userId` à UN SEUL profil `staffs`, tous tenants
 * confondus — bloquant structurellement le scénario que ce prompt vient ouvrir (un même
 * user staff dans N tenants, ex. owner du tenant A + stylist du tenant B). Signalé par le
 * Prompt 2 (bloquait la construction du fixture multi-tenant de `test/identity-multitenant
 * .spec.ts`), traité ici comme prérequis explicite avant `MembershipService.grant()`.
 *
 * Prudence identique à `migrate-normalize-salonid-to-string.ts` (dette `salonroles` Sprint
 * 1) : contrôle anti-collision AVANT tout `dropIndex`/`createIndex` — un `createIndex`
 * unique sur des doublons échoue en E11000, mais SEULEMENT après avoir déjà droppé l'ancien
 * index si on ne vérifie pas d'abord. Ce script vérifie explicitement, puis seulement si
 * 0 doublon confirmé, drop puis recrée.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-staff-userid-index.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-staff-userid-index.ts --apply
 *
 * Idempotent : si le composite existe déjà et l'ancien index global n'existe plus, ne fait
 * rien (ni en dry-run ni en --apply).
 */
import 'reflect-metadata';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

const OLD_INDEX_NAME = 'userId_1';
const NEW_INDEX_KEY = { userId: 1, salonId: 1 } as const;
const NEW_INDEX_NAME = 'userId_1_salonId_1';

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI ?? '';
  const dbName = uri.split('/').pop()?.split('?')[0];
  if (dbName === 'salonos') {
    throw new Error('Refus de continuer : MONGO_URI pointe sur "salonos" (prod). Cette migration ne tourne que sur multitenant pour ce prompt.');
  }
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  console.log(`[migrate-staff-userid-index] Connected to "${db.databaseName}". Mode: ${apply ? 'APPLY' : 'DRY-RUN'}.`);

  const coll = db.collection('staffs');
  const existing = await coll.indexes();
  const hasOld = existing.some((idx) => idx.name === OLD_INDEX_NAME);
  const hasNew = existing.some((idx) => idx.name === NEW_INDEX_NAME);

  console.log('\nIndex actuels sur staffs :');
  for (const idx of existing) console.log(`  ${idx.name} → ${JSON.stringify(idx.key)}${idx.unique ? ' (unique)' : ''}`);

  if (hasNew && !hasOld) {
    console.log('\n✓ Déjà migré : composite présent, ancien index absent. Rien à faire.');
    await client.close();
    return;
  }

  console.log('\n=== Contrôle anti-collision : doublons (userId, salonId) ===');
  const dups = await coll
    .aggregate([
      { $group: { _id: { userId: '$userId', salonId: '$salonId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (dups.length > 0) {
    console.error(`✗ ${dups.length} doublon(s) (userId, salonId) trouvé(s) — migration refusée, createIndex unique échouerait :`);
    console.error(JSON.stringify(dups, null, 2));
    await client.close();
    process.exit(1);
  }
  console.log(`✓ 0 doublon (userId, salonId) sur ${await coll.countDocuments()} documents staffs.`);

  console.log(`\n=== Plan ===`);
  if (hasOld) console.log(`  1. dropIndex("${OLD_INDEX_NAME}")`);
  if (!hasNew) console.log(`  2. createIndex(${JSON.stringify(NEW_INDEX_KEY)}, { unique: true })`);

  if (!apply) {
    console.log('\nDry-run — aucune écriture. Relancer avec --apply pour exécuter.');
    await client.close();
    return;
  }

  if (hasOld) {
    await coll.dropIndex(OLD_INDEX_NAME);
    console.log(`✓ dropIndex("${OLD_INDEX_NAME}") fait.`);
  }
  if (!hasNew) {
    await coll.createIndex(NEW_INDEX_KEY, { unique: true, background: true });
    console.log(`✓ createIndex(${JSON.stringify(NEW_INDEX_KEY)}, { unique: true }) fait.`);
  }

  const after = await coll.indexes();
  console.log('\nIndex après migration :');
  for (const idx of after) console.log(`  ${idx.name} → ${JSON.stringify(idx.key)}${idx.unique ? ' (unique)' : ''}`);

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-staff-userid-index] Fatal:', err);
  process.exit(1);
});
