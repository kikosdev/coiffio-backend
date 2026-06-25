import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;
export type OrderStatus = 'pending' | 'confirmed' | 'ready' | 'picked_up' | 'cancelled';

export interface OrderLine {
  productId: Types.ObjectId;
  name: string;
  qty: number;
  unitPrice: number;
}

/** Commande pickup-only (#5). Order→Sale uniquement à `picked_up`. trackToken = magic-link (#12). */
@Schema({ timestamps: true })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', index: true })
  clientId?: Types.ObjectId;

  @Prop()
  cartToken?: string;

  @Prop({
    type: [
      {
        productId: { type: Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, default: '' },
        qty: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
      },
    ],
    default: [],
  })
  items: OrderLine[];

  @Prop({ default: false })
  delivery: boolean;

  @Prop({ default: 0 })
  deliveryFee: number;

  @Prop({ required: true })
  total: number;

  @Prop({ type: String, enum: ['pending', 'confirmed', 'ready', 'picked_up', 'cancelled'], default: 'pending', index: true })
  status: OrderStatus;

  @Prop()
  pickupAt?: Date;

  @Prop({ required: true, unique: true, index: true })
  trackToken: string;

  @Prop({ required: true, index: true })
  date: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
