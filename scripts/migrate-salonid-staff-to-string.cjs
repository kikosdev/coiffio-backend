/**
 * Migration : convertit `salonId` de ObjectId vers String dans staffs/schedules/staffprofiles.
 *
 * Contexte : team.service.ts#createStaff (et l'ancienne migrate-users-to-staffs.ts) stockaient
 * salonId en ObjectId, alors que getSalonScope() et toutes les requêtes du code comparent avec
 * un salonId en string (issu du JWT ou de DEFAULT_SALON_ID) — résultat : aucune requête staff
 * scoped par salonId ne matchait jamais (liste staff back-office, disponibilités, planning).
 * Ce script aligne les données existantes sur la convention string utilisée partout ailleurs
 * (services, clients, etc.).
 *
 * Usage : node scripts/migrate-salonid-staff-to-string.cjs
 * Idempotent : ne touche que les documents où salonId est encore un ObjectId.
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

function readEnv(key) {
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const m = env.match(new RegExp('^' + key + '=(.+)$', 'm'));
  return m ? m[1].trim() : undefined;
}

const COLLECTIONS = ['staffs', 'schedules', 'staffprofiles'];

(async () => {
  const uri = process.env.MONGO_URI || readEnv('MONGO_URI');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  for (const name of COLLECTIONS) {
    const col = db.collection(name);
    const docs = await col.find({ salonId: { $type: 'objectId' } }).toArray();
    console.log(`${name}: ${docs.length} document(s) avec salonId en ObjectId`);
    for (const doc of docs) {
      await col.updateOne({ _id: doc._id }, { $set: { salonId: doc.salonId.toString() } });
    }
  }

  console.log('Migration terminée.');
  await mongoose.disconnect();
})().catch((e) => {
  console.error('Migration échouée :', e.message);
  process.exit(1);
});
