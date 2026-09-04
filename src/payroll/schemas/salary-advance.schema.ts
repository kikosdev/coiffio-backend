import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalaryAdvanceDocument = SalaryAdvance & Document;

export type SalaryAdvanceStatus = 'pending' | 'approved' | 'rejected' | 'settled';

/**
 * Avance sur salaire (SKILL_owner_paie_rh, P6). Cycle : pending → approved|rejected → settled.
 * `settled` = absorbée par une paie (`settledInPayrollId`), immuable au-delà de ce point.
 * `staffId`/`salonId` en String (P8) : jamais ObjectId — `staffId` s'aligne directement sur
 * `user.staffId` du JWT (déjà une string, `Staff._id.toString()`), pas de cast à faire.
 */
@Schema({ timestamps: true })
export class SalaryAdvance {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ type: String, required: true, index: true })
  staffId: string;

  // Millimes.
  @Prop({ type: Number, required: true, min: 1 })
  amount: number;

  @Prop({ type: String, default: '' })
  reason?: string;

  @Prop({ type: String, enum: ['pending', 'approved', 'rejected', 'settled'], default: 'pending', index: true })
  status: SalaryAdvanceStatus;

  // staffId (self) si demandée par le staff, ownerId si accordée directement par l'owner.
  @Prop({ type: String, required: true })
  requestedBy: string;

  @Prop({ type: String })
  approvedBy?: string;

  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({ type: String })
  rejectedReason?: string;

  // Set quand status → settled (P6) : id du SalaryPayment qui a absorbé cette avance.
  @Prop({ type: String })
  settledInPayrollId?: string;

  // Décision P0 (cash ledger link) : id du CashMovement écrit à l'approbation (cash remis en
  // main propre) — traçabilité caisse, jamais recalculé, posé par le service au moment du write.
  @Prop({ type: String })
  cashMovementId?: string;
}

export const SalaryAdvanceSchema = SchemaFactory.createForClass(SalaryAdvance);
SalaryAdvanceSchema.index({ salonId: 1, status: 1, staffId: 1 });
