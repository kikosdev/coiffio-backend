/**
 * One-off script to reset a user's password by identifier.
 *
 * Usage:
 *   npx ts-node src/scripts/reset-password.ts owner@salon.com NewPassword123
 */

import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const [identifier, newPassword] = process.argv.slice(2);
  if (!identifier || !newPassword) {
    console.error('Usage: npx ts-node src/scripts/reset-password.ts <identifier> <newPassword>');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set.');

  await mongoose.connect(uri);
  console.log('[reset-password] Connected.');

  const col = mongoose.connection.collection('users');
  const user = await col.findOne({ identifier: identifier.toLowerCase().trim() });
  if (!user) {
    console.error(`[reset-password] No user found with identifier: ${identifier}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await col.updateOne({ _id: user._id }, { $set: { passwordHash } });

  console.log(`[reset-password] Password updated for ${identifier} (role: ${user.role}).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[reset-password] Fatal:', err);
  process.exit(1);
});
