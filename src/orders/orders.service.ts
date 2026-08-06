import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, FilterQuery, Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Cart, CartDocument } from './schemas/cart.schema';
import { Order, OrderDocument, OrderStatus } from './schemas/order.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { StockMove, StockMoveDocument } from '../stock/schemas/stock-move.schema';
import { Sale, SaleDocument } from '../finance/schemas/sale.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { CheckoutDto } from './dto/orders.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { ClientProfileService } from '../identity/client-profile.service';
import { getTenantContext, runWithTenant, TenantContext } from '../common/tenant/tenant-context';

const CART_TTL_DAYS = 7;
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['ready', 'cancelled'],
  ready: ['picked_up', 'cancelled'],
  picked_up: [],
  cancelled: [],
};

export interface CartCtx {
  clientId?: string;
  cartToken?: string;
}

/**
 * Contexte système synthétique pour une lecture `clients` interne bornée — même principe
 * que `systemReadContext` dans `client-profile.service.ts` / `booking.service.ts`. `checkout()`
 * tourne sous `runAsGuest` (route publique) et `clients` est délibérément hors
 * `GUEST_READABLE` (durcissement post-Sprint-1-v2 Partie 1) — le dédup merge-on-phone de
 * `resolveClient()` ci-dessous reste une lecture interne, jamais exposée telle quelle.
 */
function systemReadContext(tenantId: string): TenantContext {
  return { tenantId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
    private readonly clientProfiles: ClientProfileService,
  ) {}

  async shopProducts(): Promise<ProductDocument[]> {
    return this.productModel.find({ active: true }).sort({ category: 1, name: 1 });
  }

  private expiry(): Date {
    return new Date(Date.now() + CART_TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  private cartFilter(ctx: CartCtx): FilterQuery<CartDocument> | null {
    if (ctx.clientId) return { clientId: new Types.ObjectId(ctx.clientId) };
    if (ctx.cartToken) return { cartToken: ctx.cartToken };
    return null;
  }

  /** Renvoie le panier courant + un nouveau cartToken si un panier invité vient d'être créé. */
  async getCart(ctx: CartCtx, create = false): Promise<{ cart: CartDocument | null; newToken?: string }> {
    const filter = this.cartFilter(ctx);
    let cart = filter ? await this.cartModel.findOne(filter) : null;
    if (!cart && create) {
      if (ctx.clientId) {
        cart = await this.cartModel.create({ clientId: new Types.ObjectId(ctx.clientId), items: [], expiresAt: this.expiry() });
        return { cart };
      }
      const newToken = randomBytes(18).toString('hex');
      cart = await this.cartModel.create({ cartToken: newToken, items: [], expiresAt: this.expiry() });
      return { cart, newToken };
    }
    return { cart };
  }

  async addItem(ctx: CartCtx, productId: string, qty: number): Promise<{ cart: CartDocument; newToken?: string }> {
    const product = await this.productModel.findOne({ _id: productId, active: true });
    if (!product) throw new BadRequestException('Product not found.');
    const { cart, newToken } = await this.getCart(ctx, true);
    const line = cart!.items.find((i) => i.productId.toString() === productId);
    if (line) line.qty += qty;
    else cart!.items.push({ productId: product._id as Types.ObjectId, qty, unitPrice: product.price });
    cart!.expiresAt = this.expiry();
    await cart!.save();
    return { cart: cart!, newToken };
  }

  async updateItemQty(ctx: CartCtx, productId: string, qty: number): Promise<CartDocument> {
    if (qty === 0) return this.removeItem(ctx, productId);
    const { cart } = await this.getCart(ctx);
    if (!cart) throw new NotFoundException('Cart not found.');
    const line = cart.items.find((i) => i.productId.toString() === productId);
    if (!line) throw new NotFoundException('Item not in cart.');
    line.qty = qty;
    await cart.save();
    return cart;
  }

  async removeItem(ctx: CartCtx, productId: string): Promise<CartDocument> {
    const { cart } = await this.getCart(ctx);
    if (!cart) throw new NotFoundException('Cart not found.');
    cart.items = cart.items.filter((i) => i.productId.toString() !== productId);
    await cart.save();
    return cart;
  }

  /** Fusionne le panier invité (cartToken) dans le panier client au login (#10). */
  async merge(clientId: string, cartToken?: string): Promise<CartDocument> {
    const { cart: clientCart } = await this.getCart({ clientId }, true);
    if (!cartToken) return clientCart!;
    const guest = await this.cartModel.findOne({ cartToken });
    if (guest) {
      for (const gl of guest.items) {
        const line = clientCart!.items.find((i) => i.productId.toString() === gl.productId.toString());
        if (line) line.qty += gl.qty;
        else clientCart!.items.push(gl);
      }
      await clientCart!.save();
      await guest.deleteOne();
    }
    return clientCart!;
  }

  // ─── Checkout pickup-only (#5) + décrément transactionnel (#6) ────────────────

  async checkout(ctx: CartCtx, dto: CheckoutDto): Promise<OrderDocument> {
    const { cart } = await this.getCart(ctx);
    if (!cart || cart.items.length === 0) throw new BadRequestException('Cart is empty.');

    const products = await this.productModel.find({ _id: { $in: cart.items.map((i) => i.productId) } });
    const nameOf = new Map(products.map((p) => [p._id.toString(), p.name]));
    const lines = cart.items.map((i) => ({
      productId: i.productId,
      name: nameOf.get(i.productId.toString()) ?? '',
      qty: i.qty,
      unitPrice: i.unitPrice,
    }));
    const deliveryFee = dto.delivery ? 7 : 0;
    const total = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) + deliveryFee;

    const clientId = await this.resolveClient(ctx, dto);
    const trackToken = randomBytes(24).toString('hex');
    const salonId = getTenantContext().tenantId;

    const place = async (session: ClientSession | null): Promise<OrderDocument> => {
      for (const l of lines) {
        const res = await this.productModel.updateOne(
          { _id: l.productId, stock: { $gte: l.qty } },
          { $inc: { stock: -l.qty } },
          session ? { session } : {},
        );
        if (res.modifiedCount === 0) throw new ConflictException(`Rupture de stock : ${l.name}.`);
        await this.moveModel.create(
          [{ productId: l.productId, type: 'out', qty: l.qty, date: new Date(), note: 'Order' }],
          session ? { session } : {},
        );
        const prod = await this.productModel.findById(l.productId).session(session ?? null);
        if (prod && prod.stock <= prod.lowStockAt) {
          void this.notifications.dispatch({
            salonId,
            role: 'owner',
            type: SOCKET_EVENTS.STOCK_LOW,
            payload: { productId: prod._id.toString(), name: prod.name, stock: prod.stock },
          });
        }
      }
      const docs = await this.orderModel.create(
        [
          {
            clientId,
            cartToken: ctx.cartToken,
            items: lines,
            delivery: dto.delivery ?? false,
            deliveryFee,
            total,
            status: 'pending',
            pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : undefined,
            trackToken,
            date: new Date(),
          },
        ],
        session ? { session } : {},
      );
      return docs[0];
    };

    let order: OrderDocument;
    const session = await this.connection.startSession();
    try {
      let created: OrderDocument | null = null;
      await session.withTransaction(async () => {
        created = await place(session);
      });
      order = created!;
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions unsupported — fallback checkout.');
        order = await place(null);
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    cart.items = [];
    await cart.save();
    void this.notifications.dispatch({
      salonId,
      role: 'owner',
      type: SOCKET_EVENTS.ORDER_CREATED,
      payload: { orderId: order._id.toString(), total: order.total },
    });
    return order;
  }

  private async resolveClient(ctx: CartCtx, dto: CheckoutDto): Promise<Types.ObjectId | undefined> {
    if (ctx.clientId) return new Types.ObjectId(ctx.clientId);
    const tenantId = getTenantContext().tenantId;
    // Invité : merge-on-phone (#10). Sous contexte interne scopé (voir docstring de
    // `systemReadContext`), pas le contexte guest ambiant de `checkout()`.
    return runWithTenant(systemReadContext(tenantId), async () => {
      const existing = await this.clientModel.findOne({ phone: dto.phone }).exec();
      if (existing) {
        if (dto.email && !existing.email) {
          existing.email = dto.email;
          await existing.save();
        }
        return existing._id as Types.ObjectId;
      }
      const created = await this.clientModel.create({
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        commsConsent: true,
        preferredChannel: 'email',
        registered: false,
        notes: '',
        history: [],
      });
      await this.clientProfiles.attachProfile(tenantId, (created._id as Types.ObjectId).toString(), created.phone, {
        name: created.name,
        email: created.email,
      });
      return created._id as Types.ObjectId;
    });
  }

  private isTxnUnsupported(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Transaction numbers are only allowed on a replica set|Transactions are not supported|replica set/i.test(msg);
  }

  // ─── Backoffice ──────────────────────────────────────────────────────────────

  async list(): Promise<OrderDocument[]> {
    return this.orderModel.find({}).sort({ date: -1 });
  }

  async updateStatus(id: string, status: OrderStatus): Promise<OrderDocument> {
    const order = await this.orderModel.findOne({ _id: id });
    if (!order) throw new NotFoundException('Order not found.');
    if (!TRANSITIONS[order.status].includes(status)) {
      throw new BadRequestException(`Invalid transition ${order.status} → ${status}.`);
    }
    order.status = status;
    await order.save();
    // Order→Sale À LA REMISE (picked_up), jamais à l'achat.
    if (status === 'picked_up') {
      await this.saleModel.create({
        source: 'order',
        items: order.items.map((i) => ({ refId: i.productId.toString(), name: i.name, qty: i.qty, unitPrice: i.unitPrice })),
        total: order.total,
        orderId: order._id,
        date: new Date(),
      });
    }
    return order;
  }

  async track(trackToken: string): Promise<OrderDocument> {
    const order = await this.orderModel.findOne({ trackToken });
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }
}
