import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClientDocument = Client & Document;

export type PreferredChannel = 'email' | 'sms';
export type HistoryType = 'appointment' | 'order';

/** Entrée d'historique (alimentée aux Sprints 4/7). */
export interface ClientHistoryEntry {
  type: HistoryType;
  refId: string;
  date: Date;
  summary: string;
}

/**
 * Sprint 2 — CRM dual-mode (Décision #10 : phone = clé d'identité, merge-on-phone).
 * `registered:false` = client invité (guest). `salonId` partout (tenancy).
 */
@Schema({ timestamps: true })
export class Client {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  // phone = clé d'identité (#10) — indexé, scopé par salon (unicité applicative dans le service)
  @Prop({ required: true, trim: true, index: true })
  phone: string;

  @Prop({ default: '', lowercase: true, trim: true })
  email: string;

  // Décision #11 : consentement comms + canal préféré (email V1, SMS V2)
  @Prop({ default: true })
  commsConsent: boolean;

  @Prop({ type: String, enum: ['email', 'sms'], default: 'email' })
  preferredChannel: PreferredChannel;

  @Prop({ default: false })
  registered: boolean;

  @Prop({ default: '' })
  notes: string;

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

// Index composé : recherche/scoping par salon + phone (clé d'identité).
ClientSchema.index({ salonId: 1, phone: 1 });
