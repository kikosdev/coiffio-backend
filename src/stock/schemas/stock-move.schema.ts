import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type StockMoveDocument = StockMove & Document;
export type MoveType = 'in' | 'out';

@Schema({ timestamps: true })
export class StockMove {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED (Prompt 3). Optionnel : absent des documents existants tant que le
  // backfill (Prompt 6) n'a pas tourné, injecté automatiquement par le plugin en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, index: true })
  productId: Types.ObjectId;

  @Prop({ type: String, enum: ['in', 'out'], required: true })
  type: MoveType;

  @Prop({ required: true, min: 0 })
  qty: number;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;
}

export const StockMoveSchema = SchemaFactory.createForClass(StockMove);
StockMoveSchema.index({ salonId: 1, productId: 1, date: 1 });
