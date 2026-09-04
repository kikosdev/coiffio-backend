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
  @Prop({ type: String, required: true, index: true })
  salonId: string;

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

  // Paie & RH (SKILL_owner_paie_rh, P2/P0-décision) : salaire fixe mensuel, en millimes.
  // Distinct de `baseRate` (dont la sémantique existante — horaire ? par prestation ? —
  // n'était pas confirmée) : 0 = commission-only, valeur normale sinon. N'écrase jamais baseRate.
  @Prop({ default: 0, min: 0 })
  baseSalary: number;

  // Jour de rappel de paie (1..28). Hors scope V1 (pas de cron/notif dessus) — champ posé
  // pour un futur rappel automatique.
  @Prop({ min: 1, max: 28 })
  payDay?: number;

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
