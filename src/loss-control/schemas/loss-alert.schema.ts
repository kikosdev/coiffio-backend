import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LossAlertDocument = LossAlert & Document;
export type LossAlertKind = 'stock_variance' | 'staff_honesty' | 'extreme_usage';
export type LossAlertSeverity = 'warning' | 'critical';

@Schema({ _id: false })
export class LossAlertPeriod {
  @Prop({ required: true }) from: Date;
  @Prop({ required: true }) to: Date;
}
export const LossAlertPeriodSchema = SchemaFactory.createForClass(LossAlertPeriod);

/**
 * LC-6/LC-10 (SKILL_loss_control_doses.md, Prompt 5). ⚠️ Hiérarchie de sévérité : `kind` seul
 * ne suffit pas à distinguer une preuve physique d'un signal déclaratif — c'est
 * `LossAlertService` qui applique la règle (jamais 'critical' pour staff_honesty/extreme_usage,
 * cf. sa docstring), le schéma se contente d'autoriser les deux valeurs.
 */
@Schema({ timestamps: true })
export class LossAlert {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ type: String, enum: ['stock_variance', 'staff_honesty', 'extreme_usage'], required: true, index: true })
  kind: LossAlertKind;

  @Prop({ type: String, enum: ['warning', 'critical'], required: true })
  severity: LossAlertSeverity;

  @Prop({ type: String })
  productId?: string;

  @Prop({ type: String })
  stylistId?: string;

  // Présent UNIQUEMENT pour 'extreme_usage' — c'est ce qui rend le RDV investigable (LC-9).
  @Prop({ type: String })
  appointmentId?: string;

  @Prop({ required: true })
  expected: number;

  @Prop({ required: true })
  declared: number;

  // Optionnel par construction : n'ajoute de l'information que quand `declared` ne suffit pas
  // à lui seul (aucun kind actuel n'en a besoin séparément — réservé, cf. `LossAlertService`).
  @Prop()
  actual?: number;

  @Prop({ required: true })
  variancePct: number;

  @Prop({ required: true })
  thresholdPct: number;

  @Prop({ type: LossAlertPeriodSchema })
  period?: LossAlertPeriod;

  @Prop({ default: false, index: true })
  read: boolean;
}

export const LossAlertSchema = SchemaFactory.createForClass(LossAlert);
LossAlertSchema.index({ salonId: 1, read: 1, createdAt: -1 });
