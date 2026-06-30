import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CartDocument = Cart & Document;

export interface CartLine {
  productId: Types.ObjectId;
  qty: number;
  unitPrice: number;
}

@Schema({ timestamps: true })
export class Cart {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ index: true })
  cartToken?: string; // invité (cookie httpOnly)

  @Prop({ type: Types.ObjectId, ref: 'Client', index: true })
  clientId?: Types.ObjectId; // authentifié

  @Prop({
    type: [
      {
        productId: { type: Types.ObjectId, ref: 'Product', required: true },
        qty: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
      },
    ],
    default: [],
  })
  items: CartLine[];

  @Prop({ required: true })
  expiresAt: Date; // TTL 7j pour invités
}

export const CartSchema = SchemaFactory.createForClass(Cart);
CartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
