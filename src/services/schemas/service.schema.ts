import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ServiceDocument = Service & Document;

export type ServiceGender = 'men' | 'women' | 'universal';

/**
 * Sprint 2 — catalogue genré. `bufferMin` = temps tampon par service (Décision #2,
 * soustrait au calcul de disponibilité). `active:false` = soft delete (jamais de hard delete).
 */
@Schema({ timestamps: true })
export class Service {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  category: string;

  @Prop({ type: String, enum: ['men', 'women', 'universal'], default: 'universal', index: true })
  gender: ServiceGender;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, min: 0 })
  durationMin: number;

  @Prop({ default: 0, min: 0 })
  bufferMin: number;

  @Prop({ default: '#B89968' })
  color: string;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop({ default: false })
  isFeatured: boolean;

  @Prop({ default: 0, min: 0 })
  featuredOrder: number;

  @Prop({ default: true })
  isPublic: boolean;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index({ salonId: 1, gender: 1, active: 1 });
ServiceSchema.index({ salonId: 1, isFeatured: 1, isPublic: 1, featuredOrder: 1 });
