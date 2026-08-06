/**
 * Sprint 2 v2 Prompt 6, Partie D — nettoyage backend uniquement (le switcher frontend est
 * reporté en sessions dédiées par repo). `passwordHash` n'existe déjà plus sur le schéma
 * Mongoose `Staff` (retiré avant ce prompt, lors du split d'identité Sprint 1 v2) — mais
 * retirer un champ du SCHÉMA ne supprime pas les données déjà écrites (piège connu du SKILL,
 * `$unset` explicite requis). Ce script fait le $unset réel sur `multitenant`.
 *
 * `multitenant` : 0 doc concerné (confirmé par audit avant d'écrire ce script) — ce run
 * prouve le no-op, ne le suppose pas. `salonos` (prod) : 4/4 staffs portent encore le champ
 * (audit lecture seule, confirmé) — ce script REFUSE structurellement d'y tourner. Le
 * $unset prod reste une décision séparée de l'utilisateur, hors de ce prompt.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-unset-staff-passwordhash.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-unset-staff-passwordhash.ts --apply
 *
 * Idempotent : ne touche que les documents où `passwordHash` existe encore.
 */
import 'reflect-metadata';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI ?? '';
  const dbName = uri.split('/').pop()?.split('?')[0];
  if (dbName === 'salonos') {
    throw new Error('Refus de continuer : MONGO_URI pointe sur "salonos" (prod). Ce script ne tourne que sur multitenant pour ce prompt.');
  }
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  console.log(`[migrate-unset-staff-passwordhash] Connected to "${db.databaseName}". Mode: ${apply ? 'APPLY' : 'DRY-RUN'}.`);

  const coll = db.collection('staffs');
  const total = await coll.countDocuments();
  const affected = await coll.countDocuments({ passwordHash: { $exists: true } });
  console.log(`\nTotal staffs : ${total}`);
  console.log(`Avec passwordHash encore présent : ${affected}`);

  if (affected === 0) {
    console.log('\n✓ Rien à faire — 0 document concerné (no-op prouvé, pas supposé).');
    await client.close();
    return;
  }

  console.log(`\n=== Plan ===`);
  console.log(`  updateMany({ passwordHash: { $exists: true } }, { $unset: { passwordHash: '' } }) sur ${affected} document(s)`);

  if (!apply) {
    console.log('\nDry-run — aucune écriture. Relancer avec --apply pour exécuter.');
    await client.close();
    return;
  }

  const result = await coll.updateMany({ passwordHash: { $exists: true } }, { $unset: { passwordHash: '' } });
  console.log(`\n✓ $unset appliqué : ${result.modifiedCount} document(s) modifié(s).`);

  const remaining = await coll.countDocuments({ passwordHash: { $exists: true } });
  console.log(`Vérification post-écriture (relu base) : ${remaining} document(s) portent encore passwordHash.`);

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-unset-staff-passwordhash] Fatal:', err);
  process.exit(1);
});
