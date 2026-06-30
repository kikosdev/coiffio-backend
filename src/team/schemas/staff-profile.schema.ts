import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type StaffProfileDocument = StaffProfile & Document;

export type StaffLevel = 'master' | 'senior' | 'apprentice';

/**
 * Sprint 3 — métadonnées RH du stylist (User role='stylist').
 * `capabilities` = qui peut faire quoi : liste de `serviceId` et/ou de `gender`
 * ('men'|'women'|'universal'). Elle est LUE par le booking engine (Sprint 4) pour
 * filtrer les stylists capables d'un service (#2 du SKILL booking).
 * `baseRate` / `commissionPct` = données de paie — exposées au seul stylist concerné (#9)
 * ou aux owner/manager (full financials, matrice).
 */
@Schema({ timestamps: true })
export class StaffProfile {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: ['master', 'senior', 'apprentice'], default: 'senior' })
  level: StaffLevel;

  // serviceId (ObjectId stringifié) et/ou gender ('men'|'women'|'universal').
  @Prop({ type: [String], default: [] })
  capabilities: string[];

  @Prop({ default: 0, min: 0 })
  baseRate: number;

  @Prop({ default: 0, min: 0, max: 100 })
  commissionPct: number;

  @Prop({ default: true })
  isPublicOnLanding: boolean;

  @Prop({ default: '' })
  publicTitle: string;

  @Prop({ type: String, enum: ['Master', 'Senior', 'Junior'], default: 'Senior' })
  seniorityTag: string;

  @Prop({ default: 0, min: 0 })
  landingOrder: number;
}

export const StaffProfileSchema = SchemaFactory.createForClass(StaffProfile);
// Un seul profil par stylist dans un salon.
StaffProfileSchema.index({ salonId: 1, userId: 1 }, { unique: true });
