import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

export enum OrderStatus {
  PENDING   = 'pending',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  READY     = 'ready',
  SHIPPED   = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  REFUNDED  = 'refunded',
}

export enum PaymentStatus {
  UNPAID   = 'unpaid',
  PAID     = 'paid',
  REFUNDED = 'refunded',
}

export enum PaymentMethod {
  COD    = 'cod',
  CARD   = 'card',
  ONLINE = 'online',
}

export enum FulfillmentType {
  PICKUP   = 'pickup',
  DELIVERY = 'delivery',
}

@Schema({ _id: false })
class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true })
  unitPrice: number;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true })
  lineTotal: number;
}

@Schema({ _id: false })
class ShippingAddress {
  @Prop() fullName: string;
  @Prop() phone: string;
  @Prop() addressLine1: string;
  @Prop() addressLine2?: string;
  @Prop() city: string;
  @Prop() postalCode?: string;
  @Prop() country: string;
  @Prop() notes?: string;
}

@Schema({ _id: false })
class StatusHistoryEntry {
  @Prop({ type: String, enum: OrderStatus }) status: OrderStatus;
  @Prop() at: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) byUserId?: Types.ObjectId;
  @Prop() note?: string;
}

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true, unique: true })
  orderNumber: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ type: Object })
  guest?: { fullName: string; email: string; phone: string };

  @Prop({ type: [OrderItem], required: true })
  items: OrderItem[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ default: 0 })
  discountAmount: number;

  @Prop({ default: 0 })
  shippingFee: number;

  @Prop({ default: 0 })
  taxAmount: number;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.PENDING, index: true })
  status: OrderStatus;

  @Prop({ type: String, enum: PaymentStatus, default: PaymentStatus.UNPAID })
  paymentStatus: PaymentStatus;

  @Prop({ type: String, enum: PaymentMethod, required: true })
  paymentMethod: PaymentMethod;

  @Prop({ type: String, enum: FulfillmentType, required: true })
  fulfillmentType: FulfillmentType;

  @Prop({ type: ShippingAddress })
  shippingAddress?: ShippingAddress;

  @Prop()
  notes?: string;

  @Prop()
  internalNotes?: string;

  @Prop()
  cancellationReason?: string;

  @Prop({ type: [StatusHistoryEntry], default: [] })
  statusHistory: StatusHistoryEntry[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ orderNumber: 1 });
OrderSchema.index({ userId: 1, createdAt: -1 });
