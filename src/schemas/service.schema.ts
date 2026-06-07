import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { StaffJob } from './user.schema';

export type ServiceDocument = Service & Document;

export enum ServiceCategory {
  HAIRCUT    = 'HAIRCUT',
  COLORING   = 'COLORING',
  TREATMENT  = 'TREATMENT',
  STYLING    = 'STYLING',
  EXTENSIONS = 'EXTENSIONS',
  BEARD      = 'BEARD',
  KIDS       = 'KIDS',
  OTHER      = 'OTHER',
}

@Schema({ timestamps: true })
export class Service {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, enum: ServiceCategory, required: true })
  category: ServiceCategory;

  @Prop({ maxlength: 500 })
  description?: string;

  @Prop({ required: true, min: 5, max: 600 })
  duration: number;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ min: 0 })
  costPrice?: number;

  @Prop({ default: '#B89968' })
  color: string;

  @Prop()
  imageUrl?: string;

  @Prop({ type: [String], enum: StaffJob, default: [] })
  requiredJobs: StaffJob[];

  @Prop({ default: 0, min: 0 })
  bufferBefore: number;

  @Prop({ default: 0, min: 0 })
  bufferAfter: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: 0 })
  displayOrder: number;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);

ServiceSchema.index({ category: 1, isActive: 1 });
ServiceSchema.index({ name: 'text', description: 'text' });
