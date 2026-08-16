import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PaymentDocument = Payment & Document;
export type PaymentMethod = 'cash' | 'card';
export type LineKind = 'service' | 'product';

export interface PaymentLine {
  kind: LineKind;
  refId: string;
  name: string;
  qty: number;
  unitPrice: number;
}

/** Encaissement (Sprint 5). `refunded` + `refundedBy/At` = refund owner-only (#8). */
@Schema({ timestamps: true })
export class Payment {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED (Prompt 3). Optionnel : absent des documents existants tant que le
  // backfill (Prompt 6) n'a pas tourné, injecté automatiquement par le plugin en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ type: Types.ObjectId, ref: 'Appointment' })
  appointmentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true, index: true })
  stylistId: Types.ObjectId;

  @Prop({
    type: [
      {
        kind: { type: String, enum: ['service', 'product'], required: true },
        refId: { type: String, default: '' },
        name: { type: String, default: '' },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
      },
    ],
    default: [],
  })
  items: PaymentLine[];

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ default: 0, min: 0 })
  tip: number;

  @Prop({ default: 0, min: 0 })
  commission: number; // dérivée de StaffProfile.commissionPct au moment de l'encaissement (SERVICE)

  // LC-8 (SKILL_loss_control_doses.md, Prompt 6) — DISTINCT de `commission` (service),
  // délibérément : deux règles indépendantes, l'owner doit pouvoir les distinguer (audit,
  // paie, litige). Assiette = lignes kind:'product' uniquement. Dérivée de
  // Salon.lossControl.productCommissionPct au moment de l'encaissement.
  @Prop({ default: 0, min: 0 })
  productCommission: number;

  @Prop({ type: String, enum: ['cash', 'card'], default: 'cash' })
  method: PaymentMethod;

  /** Espèces remises par le client (rendu de monnaie du POS). Absent sur un paiement carte
   *  et sur les encaissements antérieurs à cette fonctionnalité. */
  @Prop({ min: 0 })
  cashReceived?: number;

  /** Monnaie rendue = `cashReceived − amount`. Stocké plutôt que recalculé : c'est ce qui a
   *  RÉELLEMENT quitté le tiroir, et le montant du ticket peut être corrigé après coup. */
  @Prop({ min: 0 })
  changeGiven?: number;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ default: false, index: true })
  refunded: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  refundedBy?: Types.ObjectId;

  @Prop()
  refundedAt?: Date;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ salonId: 1, stylistId: 1, date: 1 });
