import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LocationDocument = Location & Document;

export interface LocationGeoPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat] — ordre GeoJSON strict
}

export interface OpeningHoursEntry {
  day: number; // 0=dimanche … 6=samedi
  open: string; // "HH:mm"
  close: string; // "HH:mm"
  closed: boolean;
}

@Schema({ _id: false })
export class LocationAddress {
  @Prop({ default: '' }) line1: string;
  @Prop({ default: '' }) city: string;
  @Prop({ default: '' }) postalCode: string;
  @Prop({ default: '' }) country: string;
  @Prop() lat?: number;
  @Prop() lng?: number;
}
export const LocationAddressSchema = SchemaFactory.createForClass(LocationAddress);

/**
 * Location — Sprint 1 v2 (SKILL_saas_sprint1_tenant_isolation_v2, Prompt 1).
 * 1 Tenant = N Locations. `salonId` est TOUJOURS un String brut (Invariant #1) —
 * jamais `new Types.ObjectId()`, quel que soit le call site.
 *
 * `geo` (GeoJSON Point + index 2dsphere) est dérivé de `address.lat`/`address.lng` par
 * le service à la création/mise à jour — un 2dsphere Mongo ne s'applique qu'à un champ
 * GeoJSON, jamais à deux Number bruts. Même pattern que `Salon.contact.lat/lng` →
 * `Salon.location` (seed/schemas/salon.schema.ts).
 */
@Schema({ timestamps: true })
export class Location {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true, lowercase: true })
  slug: string;

  @Prop({ type: LocationAddressSchema, default: () => ({}) })
  address: LocationAddress;

  @Prop({
    type: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: undefined },
    },
    _id: false,
  })
  geo?: LocationGeoPoint;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: 'Africa/Tunis' })
  timezone: string;

  @Prop({
    type: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        open: { type: String, default: '09:00' },
        close: { type: String, default: '18:00' },
        closed: { type: Boolean, default: false },
      },
    ],
    default: [],
  })
  openingHours: OpeningHoursEntry[];

  // Groupement géographique — consommé par la découverte cross-tenant (Prompt 5, pas encore construit).
  @Prop({ index: true })
  region?: string;

  @Prop({ default: false })
  isPrimary: boolean;

  @Prop({ default: true })
  active: boolean;
}

export const LocationSchema = SchemaFactory.createForClass(Location);
LocationSchema.index({ salonId: 1, slug: 1 }, { unique: true });
LocationSchema.index({ salonId: 1, isPrimary: 1 });
LocationSchema.index({ geo: '2dsphere' });
LocationSchema.index({ region: 1, active: 1 });
