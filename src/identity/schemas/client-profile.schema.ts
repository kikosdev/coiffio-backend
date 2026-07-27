import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClientProfileDocument = ClientProfile & Document;

export interface ClientProfileAddress {
  line1?: string;
  city?: string;
  lat?: number;
  lng?: number;
}

/**
 * ClientProfile — GLOBAL (hors scope tenant), Sprint 1 v2 Prompt 4. Porte l'historique
 * d'un client à travers tous les tenants où il apparaît. `phone` (normalisé via
 * `normalizePhone`) est la clé d'identité globale — unique, jamais la clé locale
 * `clients.phone` qui reste (salonId, phone) par tenant, INCHANGÉE par ce prompt.
 *
 * `tenantIds` (au-delà du spec littéral) — dénormalisé, maintenu par `linkClient()`.
 * Résout un problème d'architecture non couvert explicitement par le spec : découvrir
 * "quels tenants" pour `getGlobalHistory()` nécessiterait sinon une lecture cross-tenant
 * sur `clients` (TENANT_SCOPED), ce que le plugin bloque hors bypass — et `runOutsideTenant`
 * est explicitement réservé aux scripts/cron, pas à un endpoint utilisateur live
 * (`GET /clients/me/history`). `ClientProfile` étant GLOBAL, ce champ est lisible sans
 * contexte tenant du tout, et le vrai fetch par tenant reste ensuite scopé normalement.
 */
@Schema({ timestamps: true })
export class ClientProfile {
  @Prop({ type: Types.ObjectId, ref: 'User', index: true, sparse: true })
  userId?: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  phone: string;

  @Prop({ default: '' })
  name: string;

  @Prop({ default: '' })
  email: string;

  @Prop()
  avatar?: string;

  @Prop({ index: true })
  homeRegion?: string;

  @Prop({
    type: { line1: String, city: String, lat: Number, lng: Number },
    _id: false,
  })
  address?: ClientProfileAddress;

  @Prop({ type: [String], default: [] })
  tenantIds: string[];
}

export const ClientProfileSchema = SchemaFactory.createForClass(ClientProfile);
