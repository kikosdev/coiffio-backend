/**
 * One-off unblock: set a tenant owner's password by tenantId, when the setup email never
 * fired (no SMTP configured) and the owner user exists with no passwordHash yet.
 *
 * Resolves via staffs (salonId = tenantId, role = owner) -> users, not by identifier — the
 * operator knows the tenant, not necessarily the owner's exact login identifier.
 *
 * Usage:
 *   npx ts-node src/scripts/set-owner-password.ts <tenantId> <newPassword>
 */

import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

const BCRYPT_ROUNDS = 10;
const EXPECTED_DB_NAME = 'multitenant';

async function main() {
  const [tenantId, newPassword] = process.argv.slice(2);
  if (!tenantId || !newPassword) {
    console.error('Usage: npx ts-node src/scripts/set-owner-password.ts <tenantId> <newPassword>');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set.');

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No active database connection after connect().');

  // Garde-fou : ce script écrit des identités réelles — refuse de tourner contre autre chose
  // que la base multitenant du DP (jamais salonos_admin/salonos, jamais une base de test).
  if (db.databaseName !== EXPECTED_DB_NAME) {
    console.error(
      `[set-owner-password] Refusing to run: MONGO_URI points at "${db.databaseName}", expected "${EXPECTED_DB_NAME}".`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`[set-owner-password] Connected to "${db.databaseName}".`);

  const staff = await db.collection('staffs').findOne({ salonId: tenantId, role: 'owner' });
  if (!staff) {
    console.error(`[set-owner-password] No owner staff found for tenantId "${tenantId}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = await db.collection('users').findOne({ _id: staff.userId });
  if (!user) {
    console.error(`[set-owner-password] Staff owner found (${staff._id}) but no linked user (${staff.userId}) — data inconsistency.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db.collection('users').updateOne({ _id: user._id }, { $set: { passwordHash } });

  console.log(
    `[set-owner-password] Password set for owner "${staff.name}" (identifier: ${user.identifier}, tenantId: ${tenantId}).`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[set-owner-password] Fatal:', err);
  process.exit(1);
});
