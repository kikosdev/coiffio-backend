import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ExpenseDocument = Expense & Document;

@Schema({ timestamps: true })
export class Expense {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;
}

export const ExpenseSchema = SchemaFactory.createForClass(Expense);
ExpenseSchema.index({ salonId: 1, date: 1 });
