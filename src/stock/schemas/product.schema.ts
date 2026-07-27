import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED (Prompt 3). Optionnel : absent des documents existants tant que le
  // backfill (Prompt 6) n'a pas tourné, injecté automatiquement par le plugin en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  category: string;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ default: 0, min: 0 })
  cost: number;

  @Prop({ default: 0, min: 0 })
  stock: number;

  @Prop({ default: 0, min: 0 })
  lowStockAt: number;

  @Prop({ default: '' })
  supplier: string;

  @Prop({ default: '' })
  barcode: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: true })
  visibleLanding: boolean;

  @Prop({ default: false })
  promo: boolean;

  @Prop({ default: 0, min: 0, max: 90 })
  promoPercent: number;

  @Prop({ default: '' })
  promoLabel: string;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop({ default: 0, min: 0 })
  salesCount: number;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ salonId: 1, active: 1 });
