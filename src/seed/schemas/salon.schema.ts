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

/**
 * LC-7/LC-6.3/LC-8 (SKILL_loss_control_doses.md) : config owner du module loss control.
 * `alertsEnabled` défaut `false` — le module reste silencieux tant que l'owner n'a pas
 * configuré `dosesPerUnit`/`doseConfig` (sinon écarts 100% sur du théorique vide dès l'activation).
 */
@Schema({ _id: false })
export class SalonLossControl {
  @Prop({ default: 15, min: 0, max: 100 }) varianceThresholdPct: number;
  @Prop({ default: 2, min: 1 }) extremeUsageFactor: number;
  @Prop({ default: 0, min: 0, max: 100 }) productCommissionPct: number;
  @Prop({ default: false }) alertsEnabled: boolean;
}
export const SalonLossControlSchema = SchemaFactory.createForClass(SalonLossControl);

export interface SalonLocation {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat] — ordre GeoJSON strict
}

/**
 * Sous-schéma de classe, PAS un objet littéral `{type: {type:{...}}}` — même bug que
 * `LocationGeoPoint` (`locations/schemas/location.schema.ts`, corrigé au Prompt 1) : Mongoose
 * interprète la clé `type` imbriquée à l'intérieur d'un autre `type:` comme un descripteur de
 * type ambigu, pas une valeur littérale — un document créé sans même fournir `location`
 * recevait quand même un défaut invalide `{type:{type:'Point'}}`, qui casse l'index
 * `2dsphere` dès la première écriture réelle par le code applicatif (`insertOne`/`create()`
 * Mongoose — jamais déclenché avant Prompt 8, seul écrit jusqu'ici via un script
 * `strict:false` qui contourne la validation). Signalé comme dette #3, corrigé ici car
 * `InternalService.provisionTenant` (Prompt 8) est le premier chemin de code applicatif
 * réel à créer un `Salon` via ce schéma.
 */
@Schema({ _id: false })
export class SalonGeoPoint {
  @Prop({ type: String, enum: ['Point'], default: 'Point' })
  type: 'Point';

  @Prop({ type: [Number] })
  coordinates: [number, number];
}
export const SalonGeoPointSchema = SchemaFactory.createForClass(SalonGeoPoint);

@Schema({ timestamps: true })
export class Salon {
  @Prop({ required: true }) name: string;
  @Prop({ trim: true, lowercase: true }) slug: string;

  /**
   * [P4 owner multi-salon] Libellé d'emplacement — PUREMENT D'AFFICHAGE. Sert à distinguer
   * deux tenants portant le même `name` ("Joshef Coif — Ezzahra" vs "Joshef Coif — Menzah 6"),
   * cas rendu courant par le rattachement d'un 2e salon à un owner existant (P3).
   *
   * ⚠️ ORTHOGONAL à `locationId`/`locations` (Sprint 1), à ne surtout pas confondre :
   *   - `locationId`     = 1 tenant → N sites. Intra-tenant, mêmes données sous-découpées.
   *   - `locationLabel`  = 1 owner → N tenants. Inter-tenant, données ISOLÉES.
   * Ce n'est donc ni `Location.name` (posé en dur à 'Principal' au provisioning) ni
   * `Location.region` (groupement géographique consommé par la découverte cross-tenant).
   *
   * Aucune logique métier n'en dépend : pas d'unicité, pas de scope, pas de validation
   * métier, aucun index. `slug` reste le seul champ unique du tenant.
   */
  @Prop({ type: String, trim: true }) locationLabel?: string;
  @Prop({ default: '' }) address: string;
  @Prop({ default: '' }) phone: string;
  @Prop({ default: '' }) email: string;
  @Prop({ default: 'Africa/Tunis' }) timezone: string;
  @Prop({ default: 'TND' }) currency: string;
  @Prop({ default: 19, min: 0, max: 100 }) taxRate: number;

  // Cycle de vie du tenant (Prompt 8, provisioning — pas encore construit). Absent du
  // schéma jusqu'ici ; défaut 'active' s'applique aussi aux documents existants au chargement
  // (comportement standard Mongoose), donc aucun backfill requis pour ce champ précis.
  @Prop({ type: String, enum: ['active', 'suspended', 'churned'], default: 'active', index: true })
  status: 'active' | 'suspended' | 'churned';

  // Géolocalisation (SKILL_client_home_dynamic — HOME.0). Absent tant que le
  // salon n'a pas été géocodé (backfill) — jamais fabriqué côté lecture.
  @Prop({ type: SalonGeoPointSchema })
  location?: SalonLocation;

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
  @Prop({ type: SalonLossControlSchema, default: () => ({}) }) lossControl: SalonLossControl;
}

export const SalonSchema = SchemaFactory.createForClass(Salon);
SalonSchema.index({ slug: 1 }, { unique: true, sparse: true });
SalonSchema.index({ location: '2dsphere' });
