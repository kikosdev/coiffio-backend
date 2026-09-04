import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalaryPaymentDocument = SalaryPayment & Document;

/** Ligne d'avance absorbée par cette paie (montant figé au moment du payout, P5). */
export interface AdvanceDeduction {
  advanceId: string;
  amount: number;
}

export interface PayrollPeriod {
  year: number;
  month: number; // 1..12
}

/**
 * Fiche de paie (SKILL_owner_paie_rh, P1/P5). NOM DÉLIBÉRÉMENT DISTINCT de `Payment`
 * (finance/schemas/payment.schema.ts = encaissement client POS) — collision de nommage
 * interdite (P1), collections et sens métier n'ont rien en commun.
 * `baseSalary`/`commissionTotal` sont des SNAPSHOTS figés à la création (P5) : un changement
 * ultérieur de `StaffProfile.commissionPct`/`baseSalary` ne réécrit jamais une paie passée.
 * `salonId`/`staffId` en String (P8), jamais ObjectId.
 */
@Schema({ timestamps: true })
export class SalaryPayment {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ type: String, required: true, index: true })
  staffId: string;

  @Prop({
    type: { year: { type: Number, required: true }, month: { type: Number, required: true, min: 1, max: 12 } },
    required: true,
    _id: false,
  })
  period: PayrollPeriod;

  // Millimes — snapshot au moment du payout (P5).
  @Prop({ type: Number, required: true, min: 0 })
  baseSalary: number;

  @Prop({ type: Number, required: true, min: 0 })
  commissionTotal: number;

  @Prop({
    type: [{ advanceId: { type: String, required: true }, amount: { type: Number, required: true }, _id: false }],
    default: [],
  })
  advancesDeducted: AdvanceDeduction[];

  @Prop({ type: Number, default: 0 })
  bonus: number;

  @Prop({ type: Number, default: 0 })
  deductions: number;

  // base + commission + bonus − Σavances − deductions. Jamais négatif persisté (P15).
  @Prop({ type: Number, required: true, min: 0 })
  netPaid: number;

  // V1 cash-only (release-V1). Konnect/Flouci hors scope, slot prévu non câblé.
  @Prop({ type: String, enum: ['cash'], default: 'cash' })
  method: 'cash';

  @Prop({ type: String, default: '' })
  note?: string;

  @Prop({ type: String, required: true })
  paidBy: string; // ownerId

  @Prop({ type: Date, required: true })
  paidAt: Date;

  // Décision P0 (cash ledger link) : id du CashMovement écrit dans la même transaction que
  // ce payout, pour que la caisse journal reflète le net payé en cash.
  @Prop({ type: String })
  cashMovementId?: string;
}

export const SalaryPaymentSchema = SchemaFactory.createForClass(SalaryPayment);
// Une seule paie par staff par mois — rejouer un payout = 409 (collision d'index), pas de doublon.
SalaryPaymentSchema.index({ salonId: 1, staffId: 1, 'period.year': 1, 'period.month': 1 }, { unique: true });
