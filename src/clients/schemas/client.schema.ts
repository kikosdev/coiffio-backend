import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClientDocument = Client & Document;

export type PreferredChannel = 'email' | 'sms';
export type HistoryType = 'appointment' | 'order';

export interface ClientHistoryEntry {
  type: HistoryType;
  refId: string;
  date: Date;
  summary: string;
}

/**
 * Collection `clients` — profil métier CRM (Décision #10 : phone = clé d'identité,
 * merge-on-phone). `userId = null` = client walk-in (sans compte). `userId` présent =
 * client inscrit lié à la collection `users` (Identity Service).
 */
@Schema({ timestamps: true })
export class Client {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // Lien vers users (Identity). NULL = walk-in sans compte.
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  @Prop({ required: true })
  name: string;

  // phone = clé d'identité (#10) — index unique composé (salonId, phone)
  @Prop({ required: true, trim: true, index: true })
  phone: string;

  @Prop({ default: '', lowercase: true, trim: true })
  email: string;

  @Prop({ default: true })
  commsConsent: boolean;

  @Prop({ type: String, enum: ['email', 'sms'], default: 'email' })
  preferredChannel: PreferredChannel;

  @Prop({ default: '' })
  notes: string;

  // Lien vers ClientProfile (GLOBAL, Prompt 4) — nullable, sparse. N'affecte PAS
  // l'index unique (salonId, phone) ci-dessous, qui reste la clé locale au tenant.
  @Prop({ type: String, index: true, sparse: true })
  profileId?: string;

  @Prop({
    type: [
      {
        type: { type: String, enum: ['appointment', 'order'], required: true },
        refId: { type: String, required: true },
        date: { type: Date, required: true },
        summary: { type: String, default: '' },
      },
    ],
    default: [],
  })
  history: ClientHistoryEntry[];
}

export const ClientSchema = SchemaFactory.createForClass(Client);

// Index unique composé : un seul client par (salonId, phone) — merge-on-phone (#10).
ClientSchema.index({ salonId: 1, phone: 1 }, { unique: true });
