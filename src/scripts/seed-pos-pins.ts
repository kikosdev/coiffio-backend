/**
 * Sets bcrypt-hashed PINs on all staff and enables posEnabled=true.
 *
 * Usage:
 *   SEED_PIN=5678 npx ts-node src/scripts/seed-pos-pins.ts
 *   SEED_PIN=5678 STAFF_EMAIL=alice@salon.com npx ts-node src/scripts/seed-pos-pins.ts
 *
 * D-SIGNIN-1: Never use SEED_PIN=1234 in production.
 */

import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

const BCRYPT_ROUNDS = 10;

async function main() {
  const pin = process.env.SEED_PIN;
  if (!pin) {
    console.error('[seed-pos-pins] ERROR: SEED_PIN env var is required.');
    console.error('  Example: SEED_PIN=9271 npx ts-node src/scripts/seed-pos-pins.ts');
    process.exit(1);
  }
  if (!/^\d{4}$/.test(pin)) {
    console.error('[seed-pos-pins] ERROR: SEED_PIN must be exactly 4 digits.');
    process.exit(1);
  }
  if (pin === '1234') {
    console.error('[seed-pos-pins] ERROR: SEED_PIN=1234 is forbidden (D-SIGNIN-1).');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set.');

  await mongoose.connect(uri);
  console.log('[seed-pos-pins] Connected.');

  const col = mongoose.connection.collection('staffs');
  const filter: Record<string, unknown> = {};

  const targetEmail = process.env.STAFF_EMAIL;
  if (targetEmail) {
    filter.email = targetEmail.toLowerCase().trim();
    console.log(`[seed-pos-pins] Targeting single staff: ${targetEmail}`);
  } else {
    console.log('[seed-pos-pins] Targeting ALL staff documents.');
  }

  const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  const result = await col.updateMany(filter, {
    $set: { pinHash, posEnabled: true, pinAttempts: 0 },
    $unset: { pinLockedUntil: '' },
  });

  console.log(`[seed-pos-pins] Updated ${result.modifiedCount} staff document(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed-pos-pins] Fatal:', err);
  process.exit(1);
});
