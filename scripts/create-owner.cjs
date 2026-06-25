/* Insère (ou skip si déjà présent) l'owner dans la collection `staffs`.
   Le passwordHash fourni est utilisé tel-quel — pas de re-hash.
   Usage : depuis salon-backend/ →  node scripts/create-owner.cjs
   Lit MONGO_URI depuis .env. */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

function readEnv(key) {
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const m = env.match(new RegExp('^' + key + '=(.+)$', 'm'));
  return m ? m[1].trim() : undefined;
}

const SALON_ID  = '6a2c12cfa8b5cf60d1df98ab';
const STAFF_ID  = '6a257f11e8565bcb36e63767';

const OWNER_DOC = {
  _id:          new mongoose.Types.ObjectId(STAFF_ID),
  salonId:      new mongoose.Types.ObjectId(SALON_ID),
  name:         'Marie Galland',
  email:        'owner@salon.com',
  phone:        '+33 6 12 34 56 78',
  role:         'owner',
  passwordHash: '$2b$12$3kdB103JldZNJaJLTUU.PeKpndbPhRr7xtMlEFR3chMHydrLLgDOy',
  color:        '#B89968',
  isActive:     true,
  week:         [],
  publicProfile: { visible: false, order: 0 },
  createdAt:    new Date('2026-06-07T14:24:17.504Z'),
  updatedAt:    new Date('2026-06-07T14:24:17.504Z'),
};

(async () => {
  const uri = process.env.MONGO_URI || readEnv('MONGO_URI');
  if (!uri) throw new Error('MONGO_URI introuvable (process.env ou .env)');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  // Vérifie que le salon cible existe.
  const salon = await db.collection('salons').findOne({
    _id: new mongoose.Types.ObjectId(SALON_ID),
  });
  if (!salon) {
    throw new Error(`Salon ${SALON_ID} introuvable — exécutez "npm run seed" d'abord.`);
  }
  console.log('• Salon trouvé :', salon.name, '(' + SALON_ID + ')');

  // Upsert idempotent : $setOnInsert ne s'exécute que si le doc n'existe pas encore.
  const staffs = db.collection('staffs');
  const result = await staffs.updateOne(
    { _id: OWNER_DOC._id },
    { $setOnInsert: OWNER_DOC },
    { upsert: true },
  );

  if (result.upsertedCount > 0) {
    console.log('✅ Owner créé dans staffs');
  } else {
    console.log('ℹ️  Owner déjà présent dans staffs — aucune modification.');
  }

  const created = await staffs.findOne(
    { _id: OWNER_DOC._id },
    { projection: { passwordHash: 0 } },
  );
  console.log(JSON.stringify(created, null, 2));
  console.log('\n→ Connexion : email = %s', OWNER_DOC.email);
  console.log('→ _id staff  : %s', STAFF_ID);
  console.log('→ salonId    : %s', SALON_ID);

  await mongoose.disconnect();
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
