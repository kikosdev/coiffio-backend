import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  description: string;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true })
  priceEur: number;

  @Prop({ default: 0 })
  stockQuantity: number;

  @Prop({ default: '' })
  brand: string;

  @Prop({ default: '' })
  imageUrl: string;

  @Prop({ default: true })
  isActive: boolean;

  // E-commerce public fields
  @Prop({ default: false })
  isPublic: boolean;

  @Prop()
  publicDescription?: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ default: 0 })
  salesCount: number;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
