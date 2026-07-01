/**
 * Script de migration idempotent : backfill géolocalisation des salons.
 *
 * Pour chaque salon sans `location` :
 *   1. Si `contact.lat`/`contact.lng` existent déjà, les convertit en GeoJSON Point.
 *   2. Sinon, géocode `address` via Nominatim (throttle 1 req/s, policy OSM).
 *   3. Si ni l'un ni l'autre, log un avertissement — le salon reste sans coords
 *      (SKILL_client_home_dynamic HOME.1 : ces salons sont listés en bas des
 *      résultats "nearby", jamais masqués).
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/backfill-salon-geo.ts
 *
 * Idempotent : ne touche pas aux salons qui ont déjà `location`.
 */

import 'reflect-metadata';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

import { geocodeAddress } from '../common/geocode/nominatim';

const NOMINATIM_DELAY_MS = 1100; // > 1 req/s policy OSM

interface SalonLean {
  _id: mongoose.Types.ObjectId;
  name: string;
  address?: string;
  contact?: { lat?: number; lng?: number };
}

// Schéma inline, non strict (n'importe pas le vrai schéma NestJS — évite le DI).
const SalonSchema = new mongoose.Schema({}, { strict: false, collection: 'salons' });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  await mongoose.connect(uri);
  console.log('[backfill-salon-geo] Connected to MongoDB.');

  const SalonModel = mongoose.model<SalonLean>('Salon', SalonSchema);

  const salons = await SalonModel.find({ 'location.coordinates': { $exists: false } }).lean();
  console.log(`[backfill-salon-geo] ${salons.length} salon(s) without location.`);

  let fromContact = 0;
  let fromGeocode = 0;
  let unresolved = 0;

  for (const salon of salons) {
    const contactLat = salon.contact?.lat;
    const contactLng = salon.contact?.lng;

    if (typeof contactLat === 'number' && typeof contactLng === 'number') {
      await SalonModel.updateOne(
        { _id: salon._id },
        { $set: { location: { type: 'Point', coordinates: [contactLng, contactLat] } } },
      );
      fromContact++;
      continue;
    }

    if (!salon.address) {
      console.warn(`[backfill-salon-geo] Skip ${salon._id} (${salon.name}): no address to geocode.`);
      unresolved++;
      continue;
    }

    const geo = await geocodeAddress(salon.address);
    await sleep(NOMINATIM_DELAY_MS);

    if (geo) {
      await SalonModel.updateOne(
        { _id: salon._id },
        { $set: { location: { type: 'Point', coordinates: [geo.lng, geo.lat] } } },
      );
      fromGeocode++;
    } else {
      console.warn(`[backfill-salon-geo] Unresolved ${salon._id} (${salon.name}): "${salon.address}" not geocodable — fix manually.`);
      unresolved++;
    }
  }

  console.log('[backfill-salon-geo] Done.', { fromContact, fromGeocode, unresolved });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill-salon-geo] Fatal:', err);
  process.exit(1);
});
