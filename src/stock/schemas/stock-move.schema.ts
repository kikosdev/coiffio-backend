import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type StockMoveDocument = StockMove & Document;
export type MoveType = 'in' | 'out';
// LC-5 (SKILL_loss_control_doses.md, Prompt 3). Catégorie fine, orthogonale à `type` (qui ne
// porte que la direction in/out, conservée pour compat avec les mouvements déjà existants —
// vente POS `checkoutWithStock`, `restock()`, `adjustStock()`, ni retouchés ni migrés ici).
// Absent = mouvement antérieur à LC-5 ou posé par un chemin owner backoffice existant.
export type StockMoveKind = 'refill' | 'adjustment' | 'loss' | 'inventory';

@Schema({ timestamps: true })
export class StockMove {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED (Prompt 3). Optionnel : absent des documents existants tant que le
  // backfill (Prompt 6) n'a pas tourné, injecté automatiquement par le plugin en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, index: true })
  productId: Types.ObjectId;

  @Prop({ type: String, enum: ['in', 'out'], required: true })
  type: MoveType;

  /**
   * Magnitude (jamais signée — `type` porte le signe) pour `refill`/`adjustment`/`loss`, comme
   * pour les mouvements existants. ⚠️ Pour `kind:'inventory'` UNIQUEMENT : `qty` porte le stock
   * RÉEL CONSTATÉ (valeur ABSOLUE, pas un delta) — `previousStock`/`variance` portent l'écart.
   */
  @Prop({ required: true, min: 0 })
  qty: number;

  @Prop({ required: true, index: true })
  date: Date;

  /** Réutilisé comme `reason` (LC-5) — même champ, pas de doublon sémantique. */
  @Prop({ default: '' })
  note: string;

  /** Réutilisé comme `declaredBy` (LC-5) — même champ, qui a posé le mouvement. */
  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;

  @Prop({ type: String, enum: ['refill', 'adjustment', 'loss', 'inventory'] })
  kind?: StockMoveKind;

  // Équivalent doses de la magnitude du mouvement (`|delta|` ou `|variance|` pour inventory),
  // dérivé via `Product.dosesPerUnit` au moment du mouvement. Absent si produit non dosable.
  @Prop({ min: 0 })
  doses?: number;

  // 'inventory' uniquement : `Product.stock` juste AVANT le comptage — fige le théorique
  // pour que l'écart reste lisible sans recalcul a posteriori.
  @Prop({ min: 0 })
  previousStock?: number;

  // 'inventory' uniquement : countedStock − previousStock. Négatif = stock manquant (vol/perte
  // non tracée) ; c'est la jambe non contournable du loss control (Calc 2, Prompt 4).
  @Prop()
  variance?: number;
}

export const StockMoveSchema = SchemaFactory.createForClass(StockMove);
StockMoveSchema.index({ salonId: 1, productId: 1, date: 1 });
