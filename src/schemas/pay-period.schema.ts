import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayPeriodDocument = PayPeriod & Document;

export enum PeriodStatus {
  CURRENT = 'current',
  PAID = 'paid',
  UPCOMING = 'upcoming',
}

@Schema({ timestamps: true })
export class PayPeriod {
  @Prop({ required: true })
  label: string; // ex. "May 2026"

  @Prop({ default: '' })
  range: string; // ex. "1–31 May"

  @Prop({ default: 1 })
  mult: number; // facteur de variation vs mois courant

  @Prop({ type: String, enum: PeriodStatus, default: PeriodStatus.CURRENT })
  status: PeriodStatus;
}

export const PayPeriodSchema = SchemaFactory.createForClass(PayPeriod);
