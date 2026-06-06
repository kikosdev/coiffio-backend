import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ServiceDocument = Service & Document;

export enum ServiceAudience {
  ALL = 'all',
  WOMEN = 'women',
  MEN = 'men',
}

export enum ServiceCategory {
  CUTS = 'Cuts',
  COLOUR = 'Colour',
  GROOMING = 'Grooming',
  TREATMENTS = 'Treatments',
  STYLING = 'Styling',
}

@Schema({ timestamps: true })
export class Service {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  description: string;

  @Prop({ type: String, enum: ServiceCategory, required: true })
  category: ServiceCategory;

  @Prop({ type: String, enum: ServiceAudience, default: ServiceAudience.ALL })
  audience: ServiceAudience;

  @Prop({ required: true })
  durationMinutes: number;

  @Prop({ required: true })
  priceEur: number;

  @Prop({ type: [String], default: [] })
  qualifiedStylistIds: string[];

  @Prop({ default: true })
  isActive: boolean;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
