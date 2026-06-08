import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { Order, OrderDocument, OrderStatus, PaymentStatus, FulfillmentType } from './schemas/order.schema';
import { Product, ProductDocument } from '../schemas/product.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderFiltersDto } from './dto/order-filters.dto';
import { assertTransition, DECREMENTED_STATUSES } from './orders.state-machine';
import { NotificationsService } from '../notifications/notifications.service';
import { NotifType } from '../notifications/notification.schema';

interface AuthUser {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name)   private orderModel: Model<OrderDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectConnection()        private connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateOrderDto, user?: AuthUser): Promise<Order> {
    if (!user && !dto.guest) {
      throw new BadRequestException('Guest info required for unauthenticated orders');
    }

    const productIds = dto.items.map(i => new Types.ObjectId(i.productId));
    const products = await this.productModel
      .find({ _id: { $in: productIds }, isPublic: true, isActive: true })
      .lean();

    const items = dto.items.map(i => {
      const p = products.find(x => x._id.toString() === i.productId);
      if (!p) throw new BadRequestException(`Product ${i.productId} not available`);
      if (p.stockQuantity < i.quantity)
        throw new ConflictException(`Stock insuffisant pour ${p.name}`);
      return {
        productId:   new Types.ObjectId(i.productId),
        productName: p.name,
        unitPrice:   p.priceEur,
        quantity:    i.quantity,
        lineTotal:   p.priceEur * i.quantity,
      };
    });

    const subtotal    = items.reduce((s, it) => s + it.lineTotal, 0);
    const shippingFee = dto.fulfillmentType === FulfillmentType.DELIVERY ? 5 : 0;
    const totalAmount = subtotal + shippingFee;
    const orderNumber = await this.generateOrderNumber();

    const order = await this.orderModel.create({
      orderNumber,
      userId:          user ? new Types.ObjectId(user.sub) : undefined,
      guest:           !user ? dto.guest : undefined,
      items,
      subtotal,
      shippingFee,
      totalAmount,
      paymentMethod:   dto.paymentMethod,
      fulfillmentType: dto.fulfillmentType,
      shippingAddress: dto.shippingAddress,
      notes:           dto.notes,
      statusHistory:   [{ status: OrderStatus.PENDING, at: new Date() }],
    });

    await this.notifications.pushToManagers(
      NotifType.ORDER_CREATED,
      'Nouvelle commande',
      `${orderNumber} · ${totalAmount.toFixed(2)} €`,
      { orderId: order._id?.toString() },
    );

    if (user) {
      await this.notifications.push(
        user.sub,
        NotifType.ORDER_CREATED,
        'Commande reçue',
        `Votre commande ${orderNumber} est en attente de validation.`,
        { orderId: order._id?.toString() },
      );
    }

    return order;
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(filters: OrderFiltersDto) {
    const query: Record<string, unknown> = {};
    if (filters.status) query.status = filters.status;
    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from) (query.createdAt as Record<string, unknown>)['$gte'] = new Date(filters.from);
      if (filters.to)   (query.createdAt as Record<string, unknown>)['$lte'] = new Date(filters.to);
    }
    if (filters.search) {
      query['$or'] = [
        { orderNumber: { $regex: filters.search, $options: 'i' } },
        { 'guest.fullName': { $regex: filters.search, $options: 'i' } },
        { 'guest.email': { $regex: filters.search, $options: 'i' } },
      ];
    }

    const page  = filters.page  ?? 0;
    const limit = filters.limit ?? 20;
    const skip  = page * limit;

    const [items, total] = await Promise.all([
      this.orderModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.orderModel.countDocuments(query),
    ]);

    return { items, total, page, limit };
  }

  async findOne(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async findByOrderNumber(orderNumber: string, email?: string): Promise<OrderDocument> {
    const order = await this.orderModel.findOne({ orderNumber });
    if (!order) throw new NotFoundException('Order not found');
    if (email) {
      const guestEmail  = (order.guest as { email?: string } | undefined)?.email;
      const matchesGuest = guestEmail?.toLowerCase() === email.toLowerCase();
      if (!matchesGuest) throw new NotFoundException('Order not found');
    }
    return order;
  }

  async findByUser(userId: string) {
    return this.orderModel.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean();
  }

  // ─── Status transitions ────────────────────────────────────────────────────

  async updateStatus(id: string, next: OrderStatus, user: AuthUser, note?: string) {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const order = await this.orderModel.findById(id).session(session);
        if (!order) throw new NotFoundException('Order not found');

        assertTransition(order.status, next);

        // Decrement stock on confirmation
        if (next === OrderStatus.CONFIRMED) {
          for (const it of order.items) {
            const res = await this.productModel.updateOne(
              { _id: it.productId, stockQuantity: { $gte: it.quantity } },
              { $inc: { stockQuantity: -it.quantity, salesCount: it.quantity } },
              { session },
            );
            if (res.modifiedCount === 0) {
              throw new ConflictException(`Stock épuisé pour ${it.productName}`);
            }
          }
        }

        // Return stock on cancellation/refund if already decremented
        const wasDecremented = DECREMENTED_STATUSES.includes(order.status);
        if ((next === OrderStatus.CANCELLED || next === OrderStatus.REFUNDED) && wasDecremented) {
          for (const it of order.items) {
            await this.productModel.updateOne(
              { _id: it.productId },
              { $inc: { stockQuantity: it.quantity, salesCount: -it.quantity } },
              { session },
            );
          }
        }

        // Auto-mark as paid on delivery (COD)
        if (next === OrderStatus.DELIVERED) {
          order.paymentStatus = PaymentStatus.PAID;
        }

        order.status = next;
        order.statusHistory.push({
          status:    next,
          at:        new Date(),
          byUserId:  new Types.ObjectId(user.sub),
          note,
        });
        await order.save({ session });

        await this.notifyStatusChange(order, next);
        return order;
      });
    } finally {
      await session.endSession();
    }
  }

  async cancelByUser(id: string, userId: string) {
    const order = await this.orderModel.findOne({ _id: id, userId: new Types.ObjectId(userId) });
    if (!order) throw new NotFoundException('Order not found');
    if (![OrderStatus.PENDING, OrderStatus.CONFIRMED].includes(order.status)) {
      throw new BadRequestException('Cette commande ne peut plus être annulée');
    }
    return this.updateStatus(id, OrderStatus.CANCELLED, { sub: userId, email: '', role: 'client' });
  }

  async updatePaymentStatus(id: string, paymentStatus: string) {
    const order = await this.orderModel.findByIdAndUpdate(
      id,
      { paymentStatus },
      { new: true },
    );
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async updateNotes(id: string, internalNotes: string) {
    const order = await this.orderModel.findByIdAndUpdate(
      id,
      { internalNotes },
      { new: true },
    );
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const today      = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow   = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const [total, todayCount, pending, byStatus, revenue] = await Promise.all([
      this.orderModel.countDocuments(),
      this.orderModel.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      this.orderModel.countDocuments({ status: OrderStatus.PENDING }),
      this.orderModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.orderModel.aggregate([
        { $match: { status: OrderStatus.DELIVERED } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const revenueData  = revenue[0] ?? { total: 0, count: 0 };
    const statusCounts = Object.fromEntries(byStatus.map(s => [s._id, s.count]));

    return {
      total,
      todayCount,
      pending,
      statusCounts,
      totalRevenue:  revenueData.total,
      avgCartValue:  revenueData.count > 0 ? revenueData.total / revenueData.count : 0,
      deliveredCount: revenueData.count,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async generateOrderNumber(): Promise<string> {
    const year  = new Date().getFullYear();
    const count = await this.orderModel.countDocuments();
    const seq   = String(count + 1).padStart(6, '0');
    return `ORD-${year}-${seq}`;
  }

  private async notifyStatusChange(order: OrderDocument, next: OrderStatus) {
    const typeMap: Record<OrderStatus, NotifType | null> = {
      [OrderStatus.CONFIRMED]: NotifType.ORDER_CONFIRMED,
      [OrderStatus.PREPARING]: NotifType.ORDER_PREPARING,
      [OrderStatus.READY]:     NotifType.ORDER_READY,
      [OrderStatus.SHIPPED]:   NotifType.ORDER_SHIPPED,
      [OrderStatus.DELIVERED]: NotifType.ORDER_DELIVERED,
      [OrderStatus.CANCELLED]: NotifType.ORDER_CANCELLED,
      [OrderStatus.REFUNDED]:  NotifType.ORDER_REFUNDED,
      [OrderStatus.PENDING]:   null,
    };

    const notifType = typeMap[next];
    if (!notifType) return;

    const labelMap: Record<string, string> = {
      [OrderStatus.CONFIRMED]: 'Commande confirmée',
      [OrderStatus.PREPARING]: 'Commande en préparation',
      [OrderStatus.READY]:     'Commande prête',
      [OrderStatus.SHIPPED]:   'Commande expédiée',
      [OrderStatus.DELIVERED]: 'Commande livrée',
      [OrderStatus.CANCELLED]: 'Commande annulée',
      [OrderStatus.REFUNDED]:  'Commande remboursée',
    };

    const body = `${order.orderNumber} — ${labelMap[next] ?? next}`;

    if (order.userId) {
      await this.notifications.push(order.userId.toString(), notifType, labelMap[next], body, {
        orderId: order._id?.toString(),
      });
    }

    if (next === OrderStatus.DELIVERED || next === OrderStatus.CANCELLED || next === OrderStatus.REFUNDED) {
      await this.notifications.pushToManagers(notifType, labelMap[next], body, {
        orderId: order._id?.toString(),
      });
    }
  }
}
