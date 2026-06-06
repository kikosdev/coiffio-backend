import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AppointmentDocument = Appointment & Document;

export enum AppointmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

@Schema({ timestamps: true })
export class Appointment {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  clientId: Types.ObjectId | null;

  @Prop({ default: '' })
  guestName: string;

  @Prop({ default: '' })
  guestEmail: string;

  @Prop({ default: '' })
  guestPhone: string;

  @Prop({ type: Types.ObjectId, ref: 'Stylist', required: true })
  stylistId: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Service' }], default: [] })
  serviceIds: Types.ObjectId[];

  @Prop({ required: true })
  startsAt: Date;

  @Prop({ required: true })
  endsAt: Date;

  @Prop({ required: true })
  totalDurationMinutes: number;

  @Prop({ required: true })
  totalPriceEur: number;

  @Prop({ type: String, enum: AppointmentStatus, default: AppointmentStatus.PENDING })
  status: AppointmentStatus;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: '' })
  referenceCode: string;
}

export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
