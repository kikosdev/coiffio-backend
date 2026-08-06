/**
 * Migration idempotente : backfill `locationId` sur les 9 collections LOCATION_SCOPED
 * (appointments, payments, sales, expenses, products, stockmoves, schedules, orders,
 * carts) + `staffs.locationIds` (Sprint 1 v2, Prompt 6, Partie A).
 *
 * Politique : TOUJOURS la location primaire du tenant (`isPrimary: true`), jamais un
 * choix parmi plusieurs locations. Ce n'est PAS un pari — aucun document existant n'a
 * jamais pu être créé "à" une location non-primaire, puisque rien dans l'app n'écrit
 * encore `locationId` avant que ce Prompt 6 ne le câble (booking, POS, etc.). Toute
 * l'activité pré-existante, quel que soit le nombre de locations du tenant aujourd'hui,
 * appartient donc historiquement à la location primaire (celle issue du doc `salons`
 * d'origine via migrate-create-primary-locations.ts).
 *
 * Un tenant sans location primaire (`migrate-create-primary-locations.ts --apply` pas
 * encore passé chez lui) est une anomalie d'ordonnancement : listé dans `noPrimary`,
 * AUCUN document de ce tenant n'est traité.
 *
 * ⚠️ NE PAS lancer --apply avant migrate-create-primary-locations.ts --apply.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-backfill-location-id.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-backfill-location-id.ts --apply
 *
 * Idempotent : ne retraite jamais un document qui a déjà `locationId` (ou, pour staffs,
 * `locationIds` non vide).
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

interface SalonRow {
  salonId: string;
  primaryLocationId: string | null;
}

interface CollectionReport {
  collection: string;
  missingBefore: number;
  updated: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db();
  console.log(`[migrate-backfill-location-id] Connected. Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const salons = await db.collection('salons').find({}).toArray();
  const locations = db.collection('locations');

  const salonRows: SalonRow[] = [];
  const noPrimary: string[] = [];

  for (const salon of salons) {
    const salonId = salon._id.toString();
    const primary = await locations.findOne({ salonId, isPrimary: true });
    if (!primary) {
      noPrimary.push(salonId);
      salonRows.push({ salonId, primaryLocationId: null });
      continue;
    }
    salonRows.push({ salonId, primaryLocationId: primary._id.toString() });
  }

  console.log(`\n=== Tenants ===`);
  console.log(`Total salons             : ${salonRows.length}`);
  console.log(`Sans location primaire   : ${noPrimary.length} (skip complet — migrer les locations primaires d'abord)`);
  if (noPrimary.length > 0) {
    console.log(`  salonId(s) : ${noPrimary.join(', ')}`);
  }

  const eligible = salonRows.filter((r): r is SalonRow & { primaryLocationId: string } => r.primaryLocationId !== null);

  const collectionReports: CollectionReport[] = [];

  for (const collectionName of LOCATION_SCOPED_COLLECTIONS) {
    const coll = db.collection(collectionName);
    let missingBefore = 0;
    let updated = 0;

    for (const { salonId, primaryLocationId } of eligible) {
      const filter = {
        salonId,
        $or: [{ locationId: { $exists: false } }, { locationId: null }],
      };
      const count = await coll.countDocuments(filter);
      missingBefore += count;

      if (apply && count > 0) {
        const res = await coll.updateMany(filter, { $set: { locationId: primaryLocationId } });
        updated += res.modifiedCount;
      }
    }

    collectionReports.push({ collection: collectionName, missingBefore, updated });
  }

  // staffs.locationIds — tableau, pas un scalaire ; idempotence via $size:0 / absent.
  const staffs = db.collection('staffs');
  let staffMissingBefore = 0;
  let staffUpdated = 0;
  for (const { salonId, primaryLocationId } of eligible) {
    const filter = {
      salonId,
      $or: [{ locationIds: { $exists: false } }, { locationIds: { $size: 0 } }],
    };
    const count = await staffs.countDocuments(filter);
    staffMissingBefore += count;
    if (apply && count > 0) {
      const res = await staffs.updateMany(filter, { $set: { locationIds: [primaryLocationId] } });
      staffUpdated += res.modifiedCount;
    }
  }

  console.log(`\n=== ${apply ? 'Résultat' : '[DRY-RUN] Résultat projeté'} par collection ===`);
  console.log('collection'.padEnd(14), 'sans locationId'.padEnd(18), apply ? 'mis à jour' : 'serait mis à jour');
  for (const r of collectionReports) {
    console.log(r.collection.padEnd(14), String(r.missingBefore).padEnd(18), apply ? r.updated : r.missingBefore);
  }
  console.log('staffs.locationIds'.padEnd(14), String(staffMissingBefore).padEnd(18), apply ? staffUpdated : staffMissingBefore);

  if (!apply) {
    console.log('\n[DRY-RUN] Rien écrit. Relancer avec --apply pour traiter les tenants avec location primaire.');
  }

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-backfill-location-id] Fatal:', err);
  process.exit(1);
});
