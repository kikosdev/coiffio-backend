import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CashMovementDocument = CashMovement & Document;
export type CashMovementType = 'in' | 'out';
export type CashMovementReason = 'apport' | 'retrait' | 'achat' | 'avance' | 'autre';

export const CASH_MOVEMENT_REASONS: CashMovementReason[] = ['apport', 'retrait', 'achat', 'avance', 'autre'];

/**
 * Mouvement d'espèces saisi à la main, hors encaissement : apport de monnaie, prélèvement
 * du patron, achat réglé du tiroir, avance sur salaire. Toujours rattaché à une session
 * OUVERTE (`CaisseService.addMovement` refuse une session close) — sans ça, le théorique
 * d'une journée déjà clôturée pourrait bouger après coup et l'écart archivé deviendrait
 * faux.
 *
 * `amount` est TOUJOURS positif ; c'est `type` qui porte le signe. Un montant signé
 * autoriserait une sortie "négative" (donc une entrée) qui échapperait aux totaux par sens.
 */
@Schema({ timestamps: true })
export class CashMovement {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED : injecté automatiquement par le plugin tenant en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ type: Types.ObjectId, ref: 'CashSession', required: true, index: true })
  sessionId: Types.ObjectId;

  @Prop({ type: String, enum: ['in', 'out'], required: true })
  type: CashMovementType;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ type: String, enum: CASH_MOVEMENT_REASONS, default: 'autre' })
  reason: CashMovementReason;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  @Prop({ required: true, index: true })
  date: Date;
}

export const CashMovementSchema = SchemaFactory.createForClass(CashMovement);
CashMovementSchema.index({ salonId: 1, sessionId: 1, date: 1 });
