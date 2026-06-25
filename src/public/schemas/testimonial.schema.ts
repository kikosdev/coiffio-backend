import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TestimonialDocument = Testimonial & Document;

@Schema({ timestamps: true })
export class Testimonial {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ required: true })
  quote: string;

  @Prop({ required: true })
  authorName: string;

  @Prop({ default: '' })
  authorMeta: string;

  @Prop({ default: false })
  isApproved: boolean;

  @Prop({ default: 0, min: 0 })
  order: number;
}

export const TestimonialSchema = SchemaFactory.createForClass(Testimonial);
TestimonialSchema.index({ salonId: 1, isApproved: 1, order: 1 });
