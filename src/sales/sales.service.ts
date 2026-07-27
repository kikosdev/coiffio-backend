import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../finance/schemas/sale.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { StockMove, StockMoveDocument } from '../stock/schemas/stock-move.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { SalonScope } from '../common/scope/salon-scope';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { BestSellersQueryDto, CreateSaleDto, SalesQueryDto } from './dto/create-sale.dto';

export interface BestSeller {
  refId: string;
  name: string;
  qty: number;
  revenue: number;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  private periodRange(period: 'day' | 'week' | 'month', ref = new Date()): { from: Date; to: Date } {
    const to = new Date(ref);
    const from = new Date(ref);
    from.setUTCHours(0, 0, 0, 0);
    to.setUTCHours(23, 59, 59, 999);
    if (period === 'week') from.setUTCDate(from.getUTCDate() - 6);
    if (period === 'month') from.setUTCDate(1);
    return { from, to };
  }

  private buildDateFilter(q: SalesQueryDto): { from: Date; to: Date } {
    if (q.from || q.to) {
      return {
        from: q.from ? new Date(q.from) : new Date(0),
        to: q.to ? new Date(q.to) : new Date(),
      };
    }
    return this.periodRange(q.period ?? 'day');
  }

  private isTxnUnsupported(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Transaction numbers are only allowed on a replica set|Transactions are not supported|replica set/i.test(msg);
  }

  // ─── Création vente retail POS ────────────────────────────────────────────

  async create(scope: SalonScope, dto: CreateSaleDto, user: AuthUser): Promise<SaleDocument> {
    const session = await this.connection.startSession();
    let created: SaleDocument | null = null;
    let productIds: string[] = [];

    const run = async () => {
      const date = new Date();

      // Résolution des produits et décrément stock atomique
      const resolvedItems: { refId: string; name: string; qty: number; unitPrice: number }[] = [];

      for (const item of dto.items) {
        const res = await this.productModel.updateOne(
          { _id: item.refId, salonId: scope.salonId, stock: { $gte: item.qty } },
          { $inc: { stock: -item.qty, salesCount: item.qty } },
          session ? { session } : {},
        );

        if (res.modifiedCount === 0) {
          const p = await this.productModel.findOne({ _id: item.refId, salonId: scope.salonId }).session(session ?? null);
          const name = p?.name ?? item.refId;
          throw new ConflictException(`Stock insuffisant: ${name}`);
        }

        const product = await this.productModel.findById(item.refId).session(session ?? null);
        if (!product) throw new NotFoundException(`Produit introuvable: ${item.refId}`);

        resolvedItems.push({
          refId: item.refId,
          name: product.name,
          qty: item.qty,
          unitPrice: product.price,
        });

        await this.moveModel.create(
          [
            {
              salonId: scope.salonId,
              productId: new Types.ObjectId(item.refId),
              type: 'out',
              qty: item.qty,
              date,
              note: 'Vente retail POS',
              createdBy: new Types.ObjectId(user.sub),
            },
          ],
          session ? { session } : {},
        );
      }

      const subtotal = resolvedItems.reduce((a, i) => a + i.qty * i.unitPrice, 0);
      let discountComputed = 0;
      if (dto.discount) {
        discountComputed =
          dto.discount.type === 'pct'
            ? (subtotal * dto.discount.value) / 100
            : dto.discount.value;
      }
      const total = Math.max(0, subtotal - discountComputed);

      const [sale] = await this.saleModel.create(
        [
          {
            salonId: scope.salonId,
            source: 'pos',
            items: resolvedItems,
            subtotal,
            discount: dto.discount
              ? { type: dto.discount.type, value: dto.discount.value, computed: discountComputed }
              : undefined,
            total,
            method: dto.method,
            stylistId: new Types.ObjectId(user.staffId ?? user.sub),
            date,
            voided: false,
            stockRestored: false,
          },
        ],
        session ? { session } : {},
      );

      created = sale;
      productIds = resolvedItems.map((i) => i.refId);
    };

    try {
      await session.withTransaction(run);
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions non supportées — décrément non-atomique (fallback).');
        await run();
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    // Post-commit : notifs persist-then-emit
    const sale = created!;
    void this.notifications.dispatch({
      salonId: scope.salonId,
      role: 'manager',
      type: SOCKET_EVENTS.SALE_RECORDED,
      payload: {
        saleId: (sale._id as Types.ObjectId).toString(),
        total: sale.total,
        stylistName: user.name ?? user.sub,
      },
    });

    for (const id of productIds) {
      const p = await this.productModel.findById(id);
      if (!p) continue;
      if (p.stock === 0) {
        void this.notifications.dispatch({
          salonId: scope.salonId,
          role: 'manager',
          type: SOCKET_EVENTS.STOCK_OUT,
          payload: { productId: id, name: p.name },
        });
      } else if (p.stock <= p.lowStockAt) {
        void this.notifications.dispatch({
          salonId: scope.salonId,
          role: 'manager',
          type: SOCKET_EVENTS.STOCK_LOW,
          payload: { productId: id, name: p.name, stock: p.stock },
        });
      }
    }

    return sale;
  }

  // ─── Historique ──────────────────────────────────────────────────────────

  async findAll(scope: SalonScope, q: SalesQueryDto): Promise<SaleDocument[]> {
    const { from, to } = this.buildDateFilter(q);
    return this.saleModel
      .find({ salonId: scope.salonId, source: 'pos', voided: { $ne: true }, date: { $gte: from, $lte: to } })
      .sort({ date: -1 });
  }

  async findMine(user: AuthUser, scope: SalonScope, q: SalesQueryDto): Promise<SaleDocument[]> {
    const { from, to } = this.buildDateFilter(q);
    return this.saleModel
      .find({
        salonId: scope.salonId,
        source: 'pos',
        stylistId: new Types.ObjectId(user.staffId ?? user.sub),
        voided: { $ne: true },
        date: { $gte: from, $lte: to },
      })
      .sort({ date: -1 });
  }

  async findOne(id: string, user: AuthUser, scope: SalonScope): Promise<SaleDocument> {
    const sale = await this.saleModel.findOne({ _id: id, salonId: scope.salonId, source: 'pos' });
    if (!sale) throw new NotFoundException('Vente introuvable.');
    if (user.role === 'stylist' && sale.stylistId?.toString() !== (user.staffId ?? user.sub)) {
      throw new ForbiddenException('Accès refusé.');
    }
    return sale;
  }

  // ─── Best-sellers ─────────────────────────────────────────────────────────

  async bestSellers(scope: SalonScope, q: BestSellersQueryDto): Promise<BestSeller[]> {
    const { from, to } = this.periodRange(q.period ?? 'month');
    const limit = q.limit ?? 10;

    return this.saleModel.aggregate<BestSeller>([
      {
        $match: {
          salonId: scope.salonId,
          source: 'pos',
          voided: { $ne: true },
          date: { $gte: from, $lte: to },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.refId',
          name: { $first: '$items.name' },
          qty: { $sum: '$items.qty' },
          revenue: { $sum: { $multiply: ['$items.qty', '$items.unitPrice'] } },
        },
      },
      { $sort: { qty: -1 } },
      { $limit: limit },
      { $project: { _id: 0, refId: '$_id', name: 1, qty: 1, revenue: 1 } },
    ]);
  }

  // ─── Void (owner-only #8) ─────────────────────────────────────────────────

  async voidSale(id: string, restock: boolean, user: AuthUser, scope: SalonScope): Promise<SaleDocument> {
    const sale = await this.saleModel.findOne({ _id: id, salonId: scope.salonId, source: 'pos' });
    if (!sale) throw new NotFoundException('Vente introuvable.');
    if (sale.voided) throw new ConflictException('Vente déjà annulée.');

    if (!restock) {
      sale.voided = true;
      sale.voidedBy = new Types.ObjectId(user.sub);
      sale.voidedAt = new Date();
      await sale.save();
      return sale;
    }

    // Avec restock : ré-incrément en transaction
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const item of sale.items) {
          await this.productModel.updateOne(
            { _id: item.refId, salonId: scope.salonId },
            { $inc: { stock: item.qty, salesCount: -item.qty } },
            { session },
          );
          await this.moveModel.create(
            [
              {
                salonId: scope.salonId,
                productId: new Types.ObjectId(item.refId),
                type: 'in',
                qty: item.qty,
                date: new Date(),
                note: 'Annulation vente POS — restitution stock',
                createdBy: new Types.ObjectId(user.sub),
              },
            ],
            { session },
          );
        }
        sale.voided = true;
        sale.voidedBy = new Types.ObjectId(user.sub);
        sale.voidedAt = new Date();
        sale.stockRestored = true;
        await sale.save({ session });
      });
    } catch (err) {
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions non supportées — restock non-atomique (fallback).');
        for (const item of sale.items) {
          await this.productModel.updateOne(
            { _id: item.refId, salonId: scope.salonId },
            { $inc: { stock: item.qty, salesCount: -item.qty } },
          );
        }
        sale.voided = true;
        sale.voidedBy = new Types.ObjectId(user.sub);
        sale.voidedAt = new Date();
        sale.stockRestored = true;
        await sale.save();
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    return sale;
  }
}
