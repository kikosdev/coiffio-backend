import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CashSessionDocument = CashSession & Document;
export type CashSessionStatus = 'open' | 'closed';

/**
 * Journée de caisse physique (Caisse Journal). UNE session par jour calendaire
 * Africa/Tunis et par location — `day` est la clé métier, pas `openedAt` : une caisse
 * ouverte à 09h02 et une autre à 09h03 le même jour sont la MÊME journée de caisse
 * (l'index unique ci-dessous rend le double-open structurellement impossible, même en
 * course entre deux postes).
 *
 * `expectedTotal`/`variance` sont un SNAPSHOT figé à la clôture, pas un calcul relu :
 * c'est la pièce auditable de la journée. Le total théorique reste recalculable en
 * direct (`CaisseService.computeTotals`) — un écart entre le live et le snapshot signale
 * qu'un encaissement est arrivé après la clôture, et doit rester visible.
 */
@Schema({ timestamps: true })
export class CashSession {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // LOCATION_SCOPED : injecté automatiquement par le plugin tenant en écriture.
  @Prop({ type: String, index: true })
  locationId?: string;

  /** 'YYYY-MM-DD' en heure réelle Africa/Tunis (jamais UTC) — cf. `isoDateInTz`. */
  @Prop({ type: String, required: true, index: true })
  day: string;

  @Prop({ type: String, enum: ['open', 'closed'], default: 'open', index: true })
  status: CashSessionStatus;

  /** Fond de caisse déposé à l'ouverture. */
  @Prop({ required: true, min: 0 })
  openingFloat: number;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  openedBy: Types.ObjectId;

  @Prop({ required: true })
  openedAt: Date;

  /** Espèces réellement comptées à la clôture. */
  @Prop({ min: 0 })
  countedTotal?: number;

  /** Théorique figé à la clôture : fond + ventes cash − remboursements cash + entrées − sorties. */
  @Prop()
  expectedTotal?: number;

  /** `countedTotal − expectedTotal`. Négatif = manquant, positif = excédent. */
  @Prop()
  variance?: number;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  closedBy?: Types.ObjectId;

  @Prop()
  closedAt?: Date;

  /** Note saisie à l'OUVERTURE. Séparée de `closingNote` : les deux apparaissent sur des
   *  lignes distinctes du journal, un champ unique ferait afficher l'explication de l'écart
   *  sur la ligne d'ouverture. */
  @Prop({ default: '' })
  note: string;

  /** Note saisie à la clôture — typiquement l'explication de l'écart. */
  @Prop({ default: '' })
  closingNote: string;
}

export const CashSessionSchema = SchemaFactory.createForClass(CashSession);
CashSessionSchema.index({ salonId: 1, locationId: 1, day: 1 }, { unique: true });
CashSessionSchema.index({ salonId: 1, day: -1 });
