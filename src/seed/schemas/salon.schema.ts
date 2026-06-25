import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SalonDocument = Salon & Document;

const DEFAULT_HOURS = [
  { day: 0, isOpen: false, start: '09:00', end: '18:00' },
  { day: 1, isOpen: true, start: '09:00', end: '18:00' },
  { day: 2, isOpen: true, start: '09:00', end: '18:00' },
  { day: 3, isOpen: true, start: '09:00', end: '18:00' },
  { day: 4, isOpen: true, start: '09:00', end: '18:00' },
  { day: 5, isOpen: true, start: '09:00', end: '18:00' },
  { day: 6, isOpen: true, start: '09:00', end: '13:00' },
];

@Schema({ _id: false })
export class SalonLanding {
  @Prop({ default: '' }) eyebrow: string;
  @Prop({ default: '' }) headlineLine1: string;
  @Prop({ default: '' }) headlineEmphasis: string;
  @Prop({ default: '' }) headlineLine2: string;
  @Prop({ default: '' }) heroParagraph: string;
  @Prop({ type: Types.ObjectId, ref: 'Service' }) signatureServiceId?: Types.ObjectId;
  @Prop({ default: '' }) philosophyTitle: string;
  @Prop({ type: [String], default: [] }) philosophyParagraphs: string[];
  @Prop({ default: '' }) pressQuote: string;
  @Prop({ default: '' }) pressAttribution: string;
  @Prop() openedAt?: Date;
}
export const SalonLandingSchema = SchemaFactory.createForClass(SalonLanding);

@Schema({ _id: false })
export class SalonContact {
  @Prop({ default: '' }) addressLine: string;
  @Prop({ default: '' }) addressNote: string;
  @Prop({ default: '' }) phone: string;
  @Prop({ default: '' }) email: string;
  @Prop({ default: '' }) walkIns: string;
  @Prop() lat?: number;
  @Prop() lng?: number;
}
export const SalonContactSchema = SchemaFactory.createForClass(SalonContact);

@Schema({ _id: false })
export class SalonHoursEntry {
  @Prop({ required: true }) label: string;
  @Prop({ required: true }) range: string;
}
export const SalonHoursEntrySchema = SchemaFactory.createForClass(SalonHoursEntry);

@Schema({ timestamps: true })
export class Salon {
  @Prop({ required: true }) name: string;
  @Prop({ trim: true, lowercase: true }) slug: string;
  @Prop({ default: '' }) address: string;
  @Prop({ default: '' }) phone: string;
  @Prop({ default: '' }) email: string;
  @Prop({ default: 'Africa/Tunis' }) timezone: string;
  @Prop({ default: 'TND' }) currency: string;
  @Prop({ default: 19, min: 0, max: 100 }) taxRate: number;

  @Prop({
    type: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        isOpen: { type: Boolean, default: true },
        start: { type: String, default: '09:00' },
        end: { type: String, default: '18:00' },
      },
    ],
    default: () => DEFAULT_HOURS,
  })
  businessHours: { day: number; isOpen: boolean; start: string; end: string }[];

  @Prop({ type: SalonLandingSchema, default: () => ({}) }) landing: SalonLanding;
  @Prop({ type: SalonContactSchema, default: () => ({}) }) contact: SalonContact;
  @Prop({ type: [SalonHoursEntrySchema], default: [] }) hours: SalonHoursEntry[];
}

export const SalonSchema = SchemaFactory.createForClass(Salon);
SalonSchema.index({ slug: 1 }, { unique: true, sparse: true });
