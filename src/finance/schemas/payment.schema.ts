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
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

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
  commission: number; // dérivée de StaffProfile.commissionPct au moment de l'encaissement

  @Prop({ type: String, enum: ['cash', 'card'], default: 'cash' })
  method: PaymentMethod;

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
