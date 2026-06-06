import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StylistDocument = Stylist & Document;

export enum StylistTag {
  SENIOR = 'Senior',
  MASTER = 'Master',
}

@Schema({ timestamps: true })
export class Stylist {
  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ required: true })
  role: string;

  @Prop({ type: String, enum: StylistTag, default: StylistTag.SENIOR })
  tag: StylistTag;

  @Prop({ type: [Number], default: [10, 20] })
  shift: [number, number]; // [startHour, endHour]

  @Prop({ type: [String], default: [] })
  qualifiedServiceIds: string[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  bio: string;
}

export const StylistSchema = SchemaFactory.createForClass(Stylist);
