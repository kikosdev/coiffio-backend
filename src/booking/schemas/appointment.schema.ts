import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AppointmentDocument = Appointment & Document;

export type AppointmentStatus = 'booked' | 'confirmed' | 'completed' | 'cancelled' | 'noshow';
export type AppointmentSource = 'online' | 'walkin' | 'phone';

/**
 * Appointment (constitution + SKILL_booking_engine). Décision #1 : aucune collection de
 * slots — la disponibilité est une fonction pure de `Schedule − Appointments`. Décision #3 :
 * services chaînés bookés en un bloc contigu partagent le même `groupId`. Le verrou
 * transactionnel (#6) garantit l'absence de double-booking à l'écriture.
 */
@Schema({ timestamps: true })
export class Appointment {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true, index: true })
  stylistId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  // Services chaînés bookés en un bloc contigu partagent le même groupId (Décision #3).
  @Prop({ index: true })
  groupId: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Service' }], default: [] })
  services: Types.ObjectId[];

  @Prop({ required: true, index: true })
  start: Date;

  @Prop({ required: true, index: true })
  startDay: string;

  @Prop({ required: true })
  end: Date;

  @Prop({
    type: String,
    enum: ['booked', 'confirmed', 'completed', 'cancelled', 'noshow'],
    default: 'booked',
    index: true,
  })
  status: AppointmentStatus;

  @Prop({ type: String, enum: ['online', 'walkin', 'phone'], default: 'online' })
  source: AppointmentSource;

  @Prop({ default: 0 })
  price: number;

  @Prop({ index: true })
  checkInCode?: string;

  @Prop()
  deposit?: number;

  // Manual POS check-in — lets the front desk flag a client as arrived/in-chair
  // ahead of (or regardless of) the scheduled start time. Null = not checked in.
  @Prop()
  checkedInAt?: Date;
}

export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
// Requêtes de chevauchement par stylist sur une plage de dates (conflits + availability).
AppointmentSchema.index({ salonId: 1, stylistId: 1, start: 1, end: 1 });
AppointmentSchema.index(
  { salonId: 1, startDay: 1, checkInCode: 1 },
  { unique: true, partialFilterExpression: { checkInCode: { $exists: true }, startDay: { $exists: true } } },
);
