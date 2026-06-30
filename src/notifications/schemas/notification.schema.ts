import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', index: true })
  userId?: Types.ObjectId; // destinataire précis (ex. stylist)

  @Prop({ index: true })
  role?: string; // ou diffusion à un rôle (ex. owner)

  @Prop({ required: true })
  type: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ default: false, index: true })
  read: boolean;

  @Prop({ required: true, index: true })
  date: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ salonId: 1, userId: 1, read: 1 });
NotificationSchema.index({ salonId: 1, role: 1, read: 1 });
