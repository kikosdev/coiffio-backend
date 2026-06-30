import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, FilterQuery, Model, Types } from 'mongoose';
import { Payment, PaymentDocument, PaymentLine } from './schemas/payment.schema';
import { Expense, ExpenseDocument } from './schemas/expense.schema';
import { Sale, SaleDocument } from './schemas/sale.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { StockMove, StockMoveDocument } from '../stock/schemas/stock-move.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { CreatePaymentDto, CreateExpenseDto, UpdateExpenseDto } from './dto/finance.dto';
import { SalonScope } from '../common/scope/salon-scope';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';

export type Period = 'day' | 'week' | 'month';

export interface CaisseTotals {
  count: number;
  gross: number;
  tips: number;
  commission: number;
  byMethod: { cash: number; card: number };
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Expense.name) private readonly expenseModel: Model<ExpenseDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
    @InjectModel(Appointment.name) private readonly appointmentModel: Model<AppointmentDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  private lineTotal(items: PaymentLine[], kind?: 'service' | 'product'): number {
    return items.filter((i) => !kind || i.kind === kind).reduce((a, i) => a + i.qty * i.unitPrice, 0);
  }

  private periodRange(period: Period, ref = new Date()): { from: Date; to: Date } {
    const to = new Date(ref);
    const from = new Date(ref);
    from.setUTCHours(0, 0, 0, 0);
    to.setUTCHours(23, 59, 59, 999);
    if (period === 'week') from.setUTCDate(from.getUTCDate() - 6);
    if (period === 'month') from.setUTCDate(1);
    return { from, to };
  }

  // ─── Encaissement (décrément stock transactionnel #6 si lignes produit) ───────

  async createPayment(scope: SalonScope, dto: CreatePaymentDto): Promise<PaymentDocument> {
    const stylist = await this.staffModel.findOne({ _id: dto.stylistId, salonId: scope.salonId });
    if (!stylist) throw new BadRequestException('Stylist not found.');
    const items = dto.items.map((i) => ({ ...i }));
    const amount = this.lineTotal(items);
    const tip = dto.tip ?? 0;
    const servicesTotal = this.lineTotal(items, 'service');
    const profile = await this.profileModel.findOne({ salonId: scope.salonId, userId: stylist._id });
    const commission = Math.round((servicesTotal * (profile?.commissionPct ?? 0)) / 100);
    const date = new Date();
    const productLines = items.filter((i) => i.kind === 'product' && i.refId);

    const buildPayment = {
      salonId: scope.salonId,
      appointmentId: dto.appointmentId ? new Types.ObjectId(dto.appointmentId) : undefined,
      stylistId: stylist._id,
      items,
      amount,
      tip,
      commission,
      method: dto.method,
      date,
      refunded: false,
    };
    const buildSale = (paymentId: Types.ObjectId) => ({
      salonId: scope.salonId,
      source: 'pos' as const,
      items: items.map((i) => ({ refId: i.refId, name: i.name, qty: i.qty, unitPrice: i.unitPrice })),
      total: amount,
      stylistId: stylist._id,
      paymentId,
      date,
    });

    // Sans ligne produit : pas de transaction nécessaire.
    if (productLines.length === 0) {
      const payment = await this.paymentModel.create(buildPayment);
      await this.saleModel.create(buildSale(payment._id as Types.ObjectId));
      if (dto.appointmentId) await this.markAppointmentCompleted(scope, dto.appointmentId);
      return payment;
    }

    // Avec produits : décrément transactionnel (#6) — survente concurrente → 409.
    const session = await this.connection.startSession();
    try {
      let created: PaymentDocument | null = null;
      await session.withTransaction(async () => {
        created = await this.checkoutWithStock(scope, session, buildPayment, buildSale, productLines, dto.stylistId);
      });
      if (dto.appointmentId) await this.markAppointmentCompleted(scope, dto.appointmentId);
      return created!;
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions unsupported — fallback check+decrement (non-atomique).');
        const created = await this.checkoutWithStock(scope, null, buildPayment, buildSale, productLines, dto.stylistId);
        if (dto.appointmentId) await this.markAppointmentCompleted(scope, dto.appointmentId);
        return created;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  // Un encaissement lié à un RDV en clôt le cycle de vie — le paiement est la seule
  // confirmation métier que le service a été rendu (aucune autre action ne le fait).
  private async markAppointmentCompleted(scope: SalonScope, appointmentId: string): Promise<void> {
    await this.appointmentModel.updateOne(
      { _id: appointmentId, salonId: scope.salonId, status: { $ne: 'cancelled' } },
      { status: 'completed' },
    );
  }

  private async checkoutWithStock(
    scope: SalonScope,
    session: ClientSession | null,
    buildPayment: Record<string, unknown>,
    buildSale: (paymentId: Types.ObjectId) => Record<string, unknown>,
    productLines: PaymentLine[],
    userId: string,
  ): Promise<PaymentDocument> {
    for (const line of productLines) {
      const res = await this.productModel.updateOne(
        { _id: line.refId, salonId: scope.salonId, stock: { $gte: line.qty } },
        { $inc: { stock: -line.qty } },
        session ? { session } : {},
      );
      if (res.modifiedCount === 0) {
        throw new ConflictException(`Rupture de stock : ${line.name}.`);
      }
      await this.moveModel.create(
        [
          {
            salonId: scope.salonId,
            productId: new Types.ObjectId(line.refId),
            type: 'out',
            qty: line.qty,
            date: new Date(),
            note: 'Retail POS',
            createdBy: new Types.ObjectId(userId),
          },
        ],
        session ? { session } : {},
      );
      // Hook notification stock.low (branché au Sprint 8).
      const p = await this.productModel.findById(line.refId).session(session ?? null);
      if (p && p.stock <= p.lowStockAt) {
        void this.notifications.dispatch({
          salonId: scope.salonId,
          role: 'owner',
          type: SOCKET_EVENTS.STOCK_LOW,
          payload: { productId: p._id.toString(), name: p.name, stock: p.stock },
        });
      }
    }
    const payment = (await this.paymentModel.create(session ? [buildPayment] : buildPayment, session ? { session } : {})) as
      | PaymentDocument
      | PaymentDocument[];
    const created = Array.isArray(payment) ? payment[0] : payment;
    await this.saleModel.create(
      session ? [buildSale(created._id as Types.ObjectId)] : buildSale(created._id as Types.ObjectId),
      session ? { session } : {},
    );
    return created;
  }

  private isTxnUnsupported(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Transaction numbers are only allowed on a replica set|Transactions are not supported|replica set/i.test(msg);
  }

  // ─── Vue split ───────────────────────────────────────────────────────────────

  private totals(payments: PaymentDocument[]): CaisseTotals {
    const active = payments.filter((p) => !p.refunded);
    return {
      count: active.length,
      gross: active.reduce((a, p) => a + p.amount, 0),
      tips: active.reduce((a, p) => a + p.tip, 0),
      commission: active.reduce((a, p) => a + p.commission, 0),
      byMethod: {
        cash: active.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0),
        card: active.filter((p) => p.method === 'card').reduce((a, p) => a + p.amount, 0),
      },
    };
  }

  async myCaisse(scope: SalonScope, user: AuthUser): Promise<{ payments: PaymentDocument[]; totals: CaisseTotals }> {
    const { from, to } = this.periodRange('day');
    const payments = await this.paymentModel
      .find({ salonId: scope.salonId, stylistId: new Types.ObjectId(user.staffId ?? user.sub), date: { $gte: from, $lte: to } })
      .sort({ date: -1 });
    return { payments, totals: this.totals(payments) };
  }

  async overview(scope: SalonScope): Promise<{
    totals: CaisseTotals;
    byStylist: { stylistId: string; name: string; gross: number; tips: number; commission: number }[];
    payments: PaymentDocument[];
  }> {
    const { from, to } = this.periodRange('day');
    const payments = await this.paymentModel.find({ salonId: scope.salonId, date: { $gte: from, $lte: to } });
    const stylists = await this.staffModel.find({ salonId: scope.salonId, role: { $in: ['owner', 'manager', 'stylist'] } });
    const nameOf = new Map(stylists.map((s) => [s._id.toString(), s.name]));
    const groups = new Map<string, { gross: number; tips: number; commission: number }>();
    for (const p of payments.filter((x) => !x.refunded)) {
      const id = p.stylistId.toString();
      const g = groups.get(id) ?? { gross: 0, tips: 0, commission: 0 };
      g.gross += p.amount;
      g.tips += p.tip;
      g.commission += p.commission;
      groups.set(id, g);
    }
    const byStylist = [...groups.entries()].map(([stylistId, g]) => ({
      stylistId,
      name: nameOf.get(stylistId) ?? '—',
      ...g,
    }));
    return { totals: this.totals(payments), byStylist, payments };
  }

  // ─── Refund owner-only (#8) ──────────────────────────────────────────────────

  async refund(scope: SalonScope, user: AuthUser, id: string): Promise<PaymentDocument> {
    const payment = await this.paymentModel.findOne({ _id: id, salonId: scope.salonId });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.refunded) throw new BadRequestException('Payment already refunded.');
    payment.refunded = true;
    payment.refundedBy = new Types.ObjectId(user.sub);
    payment.refundedAt = new Date();
    await payment.save();
    await this.saleModel.create({
      salonId: scope.salonId,
      source: 'pos',
      items: payment.items.map((i) => ({ refId: i.refId, name: i.name, qty: i.qty, unitPrice: -i.unitPrice })),
      total: -payment.amount,
      stylistId: payment.stylistId,
      paymentId: payment._id,
      date: new Date(),
    });
    return payment;
  }

  // ─── Dépenses ────────────────────────────────────────────────────────────────

  async listExpenses(scope: SalonScope): Promise<ExpenseDocument[]> {
    return this.expenseModel.find({ salonId: scope.salonId }).sort({ date: -1 });
  }

  async createExpense(scope: SalonScope, user: AuthUser, dto: CreateExpenseDto): Promise<ExpenseDocument> {
    return this.expenseModel.create({
      salonId: scope.salonId,
      category: dto.category,
      amount: dto.amount,
      date: dto.date ? new Date(`${dto.date}T00:00:00.000Z`) : new Date(),
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(user.sub),
    });
  }

  async updateExpense(scope: SalonScope, id: string, dto: UpdateExpenseDto): Promise<ExpenseDocument> {
    const e = await this.expenseModel.findOne({ _id: id, salonId: scope.salonId });
    if (!e) throw new NotFoundException('Expense not found.');
    if (dto.category !== undefined) e.category = dto.category;
    if (dto.amount !== undefined) e.amount = dto.amount;
    if (dto.date !== undefined) e.date = new Date(`${dto.date}T00:00:00.000Z`);
    if (dto.note !== undefined) e.note = dto.note;
    await e.save();
    return e;
  }

  async deleteExpense(scope: SalonScope, id: string): Promise<{ id: string }> {
    const e = await this.expenseModel.findOneAndDelete({ _id: id, salonId: scope.salonId });
    if (!e) throw new NotFoundException('Expense not found.');
    return { id };
  }

  // ─── Rapports + CSV ────────────────────────────────────────────────────────────

  async report(scope: SalonScope, period: Period): Promise<{
    period: Period;
    revenue: number;
    tips: number;
    expenses: number;
    net: number;
    salesCount: number;
  }> {
    const { from, to } = this.periodRange(period);
    const sales = await this.saleModel.find({ salonId: scope.salonId, date: { $gte: from, $lte: to } });
    const payments = await this.paymentModel.find({
      salonId: scope.salonId,
      date: { $gte: from, $lte: to },
      refunded: false,
    });
    const expenses = await this.expenseModel.find({ salonId: scope.salonId, date: { $gte: from, $lte: to } });
    const revenue = sales.reduce((a, s) => a + s.total, 0);
    const tips = payments.reduce((a, p) => a + p.tip, 0);
    const exp = expenses.reduce((a, e) => a + e.amount, 0);
    return { period, revenue, tips, expenses: exp, net: revenue + tips - exp, salesCount: sales.length };
  }

  async exportCsv(scope: SalonScope, period: Period): Promise<string> {
    const { from, to } = this.periodRange(period);
    const sales = await this.saleModel.find({ salonId: scope.salonId, date: { $gte: from, $lte: to } }).sort({ date: 1 });
    const rows: string[][] = [['date', 'source', 'total', 'stylistId', 'items']];
    for (const s of sales) {
      rows.push([
        s.date.toISOString(),
        s.source,
        String(s.total),
        s.stylistId?.toString() ?? '',
        s.items.map((i) => `${i.name} x${i.qty}`).join('; '),
      ]);
    }
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
}
