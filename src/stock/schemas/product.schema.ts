import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED (Prompt 3). Optionnel : absent des documents existants tant que le
  // backfill (Prompt 6) n'a pas tourné, injecté automatiquement par le plugin en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  category: string;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ default: 0, min: 0 })
  cost: number;

  @Prop({ default: 0, min: 0 })
  stock: number;

  @Prop({ default: 0, min: 0 })
  lowStockAt: number;

  @Prop({ default: '' })
  supplier: string;

  @Prop({ default: '' })
  barcode: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: true })
  visibleLanding: boolean;

  @Prop({ default: false })
  promo: boolean;

  @Prop({ default: 0, min: 0, max: 90 })
  promoPercent: number;

  @Prop({ default: '' })
  promoLabel: string;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop({ default: 0, min: 0 })
  salesCount: number;

  // ── Loss control (LC-1, LC-7 — SKILL_loss_control_doses.md) ──────────────────
  // Conditionnement : 1 unité de stock = `dosesPerUnit` doses consommables en service. Absent
  // = produit non dosable (retail pur), refusé par `Service.doseConfig` (LC-T8).
  @Prop({ min: 0 })
  dosesPerUnit?: number;

  // true = consommé pendant un service (FLUX A, doses) ; false = vendu tel quel (FLUX B,
  // retail). Un produit peut être les deux à la fois (ex. cire vendue ET utilisée en service).
  @Prop({ default: false })
  isConsumable: boolean;

  // Surcharge du seuil global `Salon.lossControl.varianceThresholdPct` pour CE produit.
  // Absent = le seuil global s'applique.
  @Prop({ min: 0, max: 100 })
  varianceThresholdPct?: number;

  // LC-5 (Prompt 3) : date du dernier comptage physique (StockMove kind:'inventory').
  // Absent = jamais inventorié. Réservé à un futur rappel (cadence à la demande, aucune
  // contrainte système posée ici).
  @Prop()
  lastInventoryAt?: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ salonId: 1, active: 1 });
