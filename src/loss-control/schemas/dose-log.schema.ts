import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DoseLogDocument = DoseLog & Document;

/**
 * LC-3/LC-4 (SKILL_loss_control_doses.md, Prompt 2) : déclaration du staff, produit par
 * produit, pour UN appointment. `appointmentId` est TOUJOURS présent — LC-0 (Prompt 0-bis)
 * garantit que tout service rendu a un RDV, donc aucun DoseLog orphelin n'est possible.
 *
 * `dosesExpected` est un SNAPSHOT figé au moment de la déclaration — jamais recalculé si
 * `Service.doseConfig` change ensuite (une déclaration passée reste comparée au théorique
 * qui s'appliquait sur le moment, pas au théorique actuel).
 */
@Schema({ timestamps: true })
export class DoseLog {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ type: String, required: true, index: true })
  appointmentId: string;

  @Prop({ type: String, required: true })
  stylistId: string;

  @Prop({ type: String, required: true })
  serviceId: string;

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ required: true, min: 0 })
  dosesDeclared: number;

  @Prop({ required: true, min: 0 })
  dosesExpected: number;

  @Prop({ required: true })
  variancePct: number;

  @Prop({ required: true })
  declaredAt: Date;

  // LC-4 : posé par `FinanceService.markAppointmentCompleted()` quand l'appointment clôt.
  // Absent = encore modifiable via une nouvelle déclaration (upsert). Présent = verrouillé,
  // seule une correction owner (`PATCH /doses/:id`) peut encore le changer.
  @Prop()
  lockedAt?: Date;

  @Prop({ type: String })
  correctedBy?: string;

  @Prop({ type: String, default: '' })
  correctionNote?: string;
}

export const DoseLogSchema = SchemaFactory.createForClass(DoseLog);

DoseLogSchema.index({ salonId: 1, appointmentId: 1 });
DoseLogSchema.index({ salonId: 1, stylistId: 1, declaredAt: -1 });
DoseLogSchema.index({ salonId: 1, productId: 1, declaredAt: -1 });
// Renforce l'upsert applicatif (POST /pos/appointments/:id/doses) au niveau DB : une
// re-déclaration du même produit sur le même RDV écrase, ne duplique jamais.
DoseLogSchema.index({ salonId: 1, appointmentId: 1, productId: 1 }, { unique: true });
