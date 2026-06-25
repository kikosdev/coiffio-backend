import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SaleDocument = Sale & Document;
export type SaleSource = 'pos' | 'order';

export interface SaleLine {
  refId: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface SaleDiscount {
  type: 'amount' | 'pct';
  value: number;
  computed: number;
}

/**
 * Sale = entité de consolidation financière (PARTAGÉE Sprints 5/6/7).
 * Généré à l'encaissement (POS, Sprint 5) ou à la remise/pickup (order, Sprint 7) —
 * JAMAIS à l'achat. Source de vérité des rapports.
 */
@Schema({ timestamps: true })
export class Sale {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: String, enum: ['pos', 'order'], required: true, index: true })
  source: SaleSource;

  @Prop({
    type: [
      {
        refId: { type: String, default: '' },
        name: { type: String, default: '' },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
      },
    ],
    default: [],
  })
  items: SaleLine[];

  @Prop({ default: 0 })
  subtotal: number;

  @Prop({
    type: {
      type: { type: String, enum: ['amount', 'pct'] },
      value: { type: Number },
      computed: { type: Number },
    },
  })
  discount?: SaleDiscount;

  @Prop({ required: true })
  total: number; // peut être négatif (contre-passation d'un refund #8)

  @Prop({ type: String, enum: ['cash', 'card'] })
  method?: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  stylistId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  paymentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop({ required: true, index: true })
  date: Date;

  @Prop({ default: false })
  voided: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  voidedBy?: Types.ObjectId;

  @Prop()
  voidedAt?: Date;

  @Prop({ default: false })
  stockRestored: boolean;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);
SaleSchema.index({ salonId: 1, source: 1, date: 1 });
SaleSchema.index({ salonId: 1, date: -1 });
SaleSchema.index({ salonId: 1, 'items.refId': 1 });
