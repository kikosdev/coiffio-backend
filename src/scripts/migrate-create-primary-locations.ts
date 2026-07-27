/**
 * Migration idempotente : crée la Location primaire de chaque tenant qui n'en a pas
 * encore (Sprint 1 v2, Prompt 1). Reprend address/phone/openingHours depuis le doc
 * `salons` correspondant quand ils existent.
 *
 * ⚠️ NE PAS lancer en --apply avant que la normalisation de type de `salonId`
 * (migrate-normalize-salonid-to-string.ts) ne soit passée en production. Ce script écrit
 * `salonId` en String (Invariant #1) — s'il tourne avant, il resterait cohérent en soi,
 * mais les autres collections seraient encore mixtes tant que cette autre migration
 * n'a pas tourné. Ordre imposé : type d'abord, puis découverte/provisioning.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-create-primary-locations.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-create-primary-locations.ts --apply
 *
 * Idempotent : si une location isPrimary existe déjà pour le salonId, skip.
 */

import 'reflect-metadata';
import { Db, MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

interface SalonDoc {
  _id: ObjectId;
  name: string;
  slug?: string;
  address?: string;
  phone?: string;
  email?: string;
  timezone?: string;
  location?: { type: 'Point'; coordinates: [number, number] };
  businessHours?: { day: number; isOpen: boolean; start: string; end: string }[];
  contact?: { addressLine?: string; addressNote?: string; phone?: string; email?: string; lat?: number; lng?: number };
}

interface ReportRow {
  salonId: string;
  locationId: string;
  action: 'created' | 'skipped';
}

function toOpeningHours(businessHours: SalonDoc['businessHours']): unknown[] {
  if (!businessHours?.length) return [];
  return businessHours.map((h) => ({
    day: h.day,
    open: h.start ?? '09:00',
    close: h.end ?? '18:00',
    closed: !h.isOpen,
  }));
}

function resolveAddress(salon: SalonDoc): { line1: string; city: string; postalCode: string; country: string; lat?: number; lng?: number } {
  const lat = salon.contact?.lat ?? salon.location?.coordinates?.[1];
  const lng = salon.contact?.lng ?? salon.location?.coordinates?.[0];
  return {
    line1: salon.contact?.addressLine ?? salon.address ?? '',
    city: '',
    postalCode: '',
    country: '',
    ...(lat != null && lng != null ? { lat, lng } : {}),
  };
}

function toGeoPoint(lat?: number, lng?: number) {
  if (lat == null || lng == null) return undefined;
  return { type: 'Point' as const, coordinates: [lng, lat] as [number, number] };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db();
  console.log(`[migrate-create-primary-locations] Connected. Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const salons = await db.collection<SalonDoc>('salons').find({}).toArray();
  const locations = db.collection('locations');
  const report: ReportRow[] = [];

  for (const salon of salons) {
    const salonId = salon._id.toString();
    const existingPrimary = await locations.findOne({ salonId, isPrimary: true });

    if (existingPrimary) {
      report.push({ salonId, locationId: existingPrimary._id.toString(), action: 'skipped' });
      continue;
    }

    const address = resolveAddress(salon);
    const geo = toGeoPoint(address.lat, address.lng);
    const doc = {
      _id: new ObjectId(),
      salonId,
      name: salon.name,
      slug: 'principal',
      address,
      geo,
      phone: salon.contact?.phone ?? salon.phone ?? '',
      timezone: salon.timezone ?? 'Africa/Tunis',
      openingHours: toOpeningHours(salon.businessHours),
      // "à confirmer avec le métier" (spec Prompt 1) — laissé vide faute de champ
      // structuré `city` sur Salon aujourd'hui ; ne pas inventer une valeur.
      region: undefined as string | undefined,
      isPrimary: true,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (apply) {
      await locations.insertOne(doc);
    }

    report.push({ salonId, locationId: doc._id.toString(), action: 'created' });
  }

  console.log('\n=== Rapport ===');
  console.log('salonId'.padEnd(28), 'locationId'.padEnd(28), 'action');
  for (const r of report) {
    console.log(r.salonId.padEnd(28), r.locationId.padEnd(28), r.action);
  }

  const created = report.filter((r) => r.action === 'created').length;
  const skipped = report.filter((r) => r.action === 'skipped').length;
  console.log(`\n${apply ? 'Créé' : '[DRY-RUN] Créerait'} ${created} location(s) primaire(s), ${skipped} déjà existante(s).`);

  if (!apply && created > 0) {
    console.log('Relancer avec --apply pour écrire.');
  }

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-create-primary-locations] Fatal:', err);
  process.exit(1);
});
