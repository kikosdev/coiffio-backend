import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;

export enum NotifType {
  APPOINTMENT_CREATED   = 'appointment_created',
  APPOINTMENT_CONFIRMED = 'appointment_confirmed',
  APPOINTMENT_CANCELLED = 'appointment_cancelled',
  APPOINTMENT_REMINDER  = 'appointment_reminder',
  TIMEOFF_REQUESTED     = 'timeoff_requested',
  TIMEOFF_DECISION      = 'timeoff_decision',
  PAYMENT_RECORDED      = 'payment_recorded',
  SALE_RECORDED         = 'sale_recorded',
  LOW_STOCK             = 'low_stock',
  OUT_OF_STOCK          = 'out_of_stock',
}

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: NotifType, required: true })
  type: NotifType;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  body: string;

  @Prop({ type: Object })
  data?: Record<string, unknown>;

  @Prop({ default: false })
  isRead: boolean;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
