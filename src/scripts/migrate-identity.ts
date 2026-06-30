/**
 * Script de migration idempotent : Identity/Auth Split.
 *
 * Transforme l'état legacy (User = clients + Staff avec passwordHash) vers
 * la nouvelle architecture (users = identité, clients/staffs = profils métier).
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-identity.ts
 *
 * Idempotent : relançable sans doublon (upsert par identifier / par (salonId, phone)).
 */

import 'reflect-metadata';
import mongoose, { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── Schémas inline (évite d'importer NestJS DI) ──────────────────────────────

const UserSchema = new mongoose.Schema({
  identifier:     { type: String, required: true, unique: true, index: true },
  identifierType: { type: String, enum: ['email', 'phone'], required: true },
  passwordHash:   { type: String, required: true },
  role:           { type: String, enum: ['owner', 'staff', 'client'], required: true },
  isActive:       { type: Boolean, default: true },
  expoPushToken:  { type: String },
  lastLoginAt:    { type: Date, default: null },
}, { timestamps: true });

const ClientSchema = new mongoose.Schema({
  salonId:  { type: Types.ObjectId, ref: 'Salon', required: true },
  userId:   { type: Types.ObjectId, ref: 'User', default: null },
  name:     { type: String, required: true },
  phone:    { type: String, required: true },
  email:    { type: String, default: '' },
  commsConsent:      { type: Boolean, default: true },
  preferredChannel:  { type: String, enum: ['email', 'sms'], default: 'email' },
  notes:    { type: String, default: '' },
  history:  { type: Array, default: [] },
}, { timestamps: true });
ClientSchema.index({ salonId: 1, phone: 1 }, { unique: true });

const StaffSchema = new mongoose.Schema({
  salonId:  { type: Types.ObjectId, ref: 'Salon', required: true },
  userId:   { type: Types.ObjectId, ref: 'User', required: false }, // nullable during migration
  name:     { type: String, required: true },
  email:    { type: String },
  phone:    { type: String, default: '' },
  color:    { type: String, default: '#B89968' },
  role:     { type: String, enum: ['owner', 'manager', 'stylist', 'colorist'], required: true },
  isActive: { type: Boolean, default: true },
  passwordHash: { type: String }, // legacy — present before migration
  week:     { type: Array, default: [] },
  publicProfile: { type: Object, default: { visible: true, order: 0 } },
}, { timestamps: true });

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  await mongoose.connect(uri);
  console.log('[migrate-identity] Connected to MongoDB.');

  // ── 0. Drop legacy indexes that conflict with the new schema ─────────────
  const usersCol = mongoose.connection.collection('users');
  const existingIndexes = await usersCol.indexes();
  for (const idx of existingIndexes) {
    const key = Object.keys(idx.key ?? {});
    // Drop old unique indexes on email/phone/salonId that no longer exist in the new schema.
    if (key.some((k) => ['email', 'phone', 'salonId', 'name'].includes(k))) {
      console.log(`[migrate-identity] Dropping legacy index: ${idx.name}`);
      await usersCol.dropIndex(idx.name as string);
    }
  }

  const UserModel   = mongoose.model('User', UserSchema);
  const ClientModel = mongoose.model('Client', ClientSchema);
  const StaffModel  = mongoose.model('Staff', StaffSchema);

  let usersCreated = 0;
  let staffsLinked = 0;
  let clientsLinked = 0;
  let walkinsKept = 0;
  let alreadyMigrated = 0;

  // ── 1. Migrer les Staff (owner/manager/stylist/colorist) ──────────────────
  const staffDocs = await StaffModel.find({}).lean();
  for (const staff of staffDocs) {
    if (staff.userId) {
      alreadyMigrated++;
      continue; // déjà migré
    }
    if (!staff.email && !staff.phone) {
      console.warn(`[migrate-identity] Skip staff ${staff._id}: no identifier.`);
      continue;
    }

    const identifier = staff.email?.toLowerCase() ?? staff.phone;
    const identifierType = staff.email ? 'email' : 'phone';
    const role: string = staff.role === 'owner' ? 'owner' : 'staff';

    // Upsert users document.
    let userDoc = await UserModel.findOne({ identifier });
    if (!userDoc) {
      const passwordHash = staff.passwordHash ?? await bcrypt.hash(Math.random().toString(36), 10);
      userDoc = await UserModel.create({
        identifier,
        identifierType,
        passwordHash,
        role,
        isActive: staff.isActive ?? true,
      });
      usersCreated++;
    }

    // Lier Staff.userId.
    await StaffModel.updateOne({ _id: staff._id }, { $set: { userId: userDoc._id } });
    staffsLinked++;
  }

  // ── 2. Migrer les User legacy (clients registered) ───────────────────────
  // Le modèle legacy User avait : salonId, name, email, phone, passwordHash, role:'client'
  // Cherche ces docs par leur shape (pas via le nouveau schéma qui a 'identifier').
  const legacyUserCollection = mongoose.connection.collection('users');
  // Docs sans 'identifier' = anciens (legacy shape avec 'email').
  const legacyUsers = await legacyUserCollection.find({ identifier: { $exists: false }, email: { $exists: true } }).toArray();

  for (const lu of legacyUsers) {
    if (!lu.email) continue;
    const identifier = lu.email.toLowerCase();

    let userDoc = await UserModel.findOne({ identifier });
    if (!userDoc) {
      await legacyUserCollection.updateOne(
        { _id: lu._id },
        {
          $set: {
            identifier,
            identifierType: 'email',
            role: 'client',
            isActive: lu.isActive ?? true,
          },
          $unset: { salonId: 1, name: 1, email: 1, phone: 1, registered: 1 },
        },
      );
      userDoc = (await UserModel.findById(lu._id))!;
      usersCreated++;
    }

    // Trouver ou créer le profil Client.
    const phone = lu.phone ?? '';
    const salonId = lu.salonId;
    if (salonId && phone) {
      let client = await ClientModel.findOne({ salonId, phone });
      if (!client) {
        try {
          client = await ClientModel.create({
            salonId,
            userId: lu._id,
            name: lu.name ?? 'Client',
            phone,
            email: identifier,
          });
          clientsLinked++;
        } catch {
          // doublon (salonId, phone) — lier à l'existant
          client = await ClientModel.findOneAndUpdate(
            { salonId, phone },
            { $set: { userId: lu._id } },
            { new: true },
          );
          if (client) clientsLinked++;
        }
      } else if (!client.userId) {
        await ClientModel.updateOne({ _id: client._id }, { $set: { userId: lu._id } });
        clientsLinked++;
      }
    }
  }

  // ── 3. Clients walk-in (sans User) restent tels quels (userId = null) ────
  const walkins = await ClientModel.countDocuments({ userId: null });
  walkinsKept = walkins;

  console.log('[migrate-identity] Done.', {
    usersCreated,
    staffsLinked,
    clientsLinked,
    walkinsKept,
    alreadyMigrated,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migrate-identity] Fatal:', err);
  process.exit(1);
});
