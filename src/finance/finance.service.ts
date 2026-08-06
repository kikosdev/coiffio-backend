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
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { startOfDayInTz, endOfDayInTz, isoDateInTz, isoMonthInTz, shiftIsoDate } from '../common/time/tz-day.util';
import { getTenantContext } from '../common/tenant/tenant-context';

export type Period = 'day' | 'week' | 'month';
export type EarningsPeriod = 'week' | 'month' | 'year';

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
    const refDay = isoDateInTz(ref);
    const to = endOfDayInTz(refDay);
    let fromDay = refDay;
    if (period === 'week') fromDay = shiftIsoDate(refDay, -6);
    if (period === 'month') fromDay = `${refDay.slice(0, 7)}-01`;
    return { from: startOfDayInTz(fromDay), to };
  }

  // ─── Encaissement (décrément stock transactionnel #6 si lignes produit) ───────

  async createPayment(dto: CreatePaymentDto): Promise<PaymentDocument> {
    const stylist = await this.staffModel.findOne({ _id: dto.stylistId });
    if (!stylist) throw new BadRequestException('Stylist not found.');
    const items = dto.items.map((i) => ({ ...i }));
    const amount = this.lineTotal(items);
    const tip = dto.tip ?? 0;
    const servicesTotal = this.lineTotal(items, 'service');
    const profile = await this.profileModel.findOne({ userId: stylist._id });
    const commission = Math.round((servicesTotal * (profile?.commissionPct ?? 0)) / 100);
    const date = new Date();
    const productLines = items.filter((i) => i.kind === 'product' && i.refId);

    const buildPayment = {
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
      if (dto.appointmentId) await this.markAppointmentCompleted(dto.appointmentId);
      return payment;
    }

    // Avec produits : décrément transactionnel (#6) — survente concurrente → 409.
    const session = await this.connection.startSession();
    try {
      let created: PaymentDocument | null = null;
      await session.withTransaction(async () => {
        created = await this.checkoutWithStock(session, buildPayment, buildSale, productLines, dto.stylistId);
      });
      if (dto.appointmentId) await this.markAppointmentCompleted(dto.appointmentId);
      return created!;
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions unsupported — fallback check+decrement (non-atomique).');
        const created = await this.checkoutWithStock(null, buildPayment, buildSale, productLines, dto.stylistId);
        if (dto.appointmentId) await this.markAppointmentCompleted(dto.appointmentId);
        return created;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  // Un encaissement lié à un RDV en clôt le cycle de vie — le paiement est la seule
  // confirmation métier que le service a été rendu (aucune autre action ne le fait).
  private async markAppointmentCompleted(appointmentId: string): Promise<void> {
    await this.appointmentModel.updateOne(
      { _id: appointmentId, status: { $ne: 'cancelled' } },
      { status: 'completed' },
    );
  }

  private async checkoutWithStock(
    session: ClientSession | null,
    buildPayment: Record<string, unknown>,
    buildSale: (paymentId: Types.ObjectId) => Record<string, unknown>,
    productLines: PaymentLine[],
    userId: string,
  ): Promise<PaymentDocument> {
    const salonId = getTenantContext().tenantId;
    for (const line of productLines) {
      const res = await this.productModel.updateOne(
        { _id: line.refId, stock: { $gte: line.qty } },
        { $inc: { stock: -line.qty } },
        session ? { session } : {},
      );
      if (res.modifiedCount === 0) {
        throw new ConflictException(`Rupture de stock : ${line.name}.`);
      }
      await this.moveModel.create(
        [
          {
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
          salonId,
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

  // ─── Earnings (staff self-service — GET /finance/earnings/me) ─────────────────

  /** Same-length range immediately preceding `range`, for the period-over-period changePct. */
  private priorRange(range: { from: Date; to: Date }): { from: Date; to: Date } {
    const spanMs = range.to.getTime() - range.from.getTime();
    return { from: new Date(range.from.getTime() - spanMs - 1), to: new Date(range.from.getTime() - 1) };
  }

  private earningsRange(period: EarningsPeriod, ref = new Date()): { from: Date; to: Date } {
    const refDay = isoDateInTz(ref);
    const to = endOfDayInTz(refDay);
    let fromDay = refDay;
    if (period === 'week') fromDay = shiftIsoDate(refDay, -6);
    if (period === 'month') fromDay = `${refDay.slice(0, 7)}-01`;
    if (period === 'year') fromDay = `${refDay.slice(0, 4)}-01-01`;
    return { from: startOfDayInTz(fromDay), to };
  }

  private bucketKey(period: EarningsPeriod, date: Date): string {
    if (period === 'year') return isoMonthInTz(date); // 'YYYY-MM'
    if (period === 'month') {
      const dayOfMonth = Number(isoDateInTz(date).slice(8, 10));
      return `W${Math.ceil(dayOfMonth / 7)}`; // 'W1'..'W5'
    }
    return isoDateInTz(date); // 'YYYY-MM-DD'
  }

  async myEarnings(user: AuthUser, period: EarningsPeriod): Promise<{
    period: EarningsPeriod;
    totalTnd: number;
    changePct: number;
    byService: { service: string; totalTnd: number; count: number; pct: number }[];
    chartBars: { bucket: string; valueTnd: number }[];
  }> {
    const range = this.earningsRange(period);
    const prior = this.priorRange(range);
    const stylistId = new Types.ObjectId(user.staffId ?? user.sub);

    const [payments, priorPayments] = await Promise.all([
      this.paymentModel.find({ stylistId, refunded: false, date: { $gte: range.from, $lte: range.to } }),
      this.paymentModel.find({ stylistId, refunded: false, date: { $gte: prior.from, $lte: prior.to } }),
    ]);

    const totalTnd = payments.reduce((a, p) => a + p.amount, 0);
    const priorTotalTnd = priorPayments.reduce((a, p) => a + p.amount, 0);
    const changePct = priorTotalTnd === 0 ? (totalTnd > 0 ? 100 : 0) : Math.round(((totalTnd - priorTotalTnd) / priorTotalTnd) * 100);

    const byServiceMap = new Map<string, { totalTnd: number; count: number }>();
    for (const p of payments) {
      for (const line of p.items.filter((i) => i.kind === 'service')) {
        const g = byServiceMap.get(line.name) ?? { totalTnd: 0, count: 0 };
        g.totalTnd += line.qty * line.unitPrice;
        g.count += line.qty;
        byServiceMap.set(line.name, g);
      }
    }
    const maxServiceTnd = Math.max(1, ...Array.from(byServiceMap.values()).map((v) => v.totalTnd));
    const byService = Array.from(byServiceMap.entries())
      .map(([service, v]) => ({ service, totalTnd: v.totalTnd, count: v.count, pct: Math.round((v.totalTnd / maxServiceTnd) * 100) }))
      .sort((a, b) => b.totalTnd - a.totalTnd);

    const bucketMap = new Map<string, number>();
    for (const p of payments) {
      const key = this.bucketKey(period, p.date);
      bucketMap.set(key, (bucketMap.get(key) ?? 0) + p.amount);
    }
    const chartBars = Array.from(bucketMap.entries())
      .map(([bucket, valueTnd]) => ({ bucket, valueTnd }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return { period, totalTnd, changePct, byService, chartBars };
  }

  async myCaisse(user: AuthUser): Promise<{ payments: PaymentDocument[]; totals: CaisseTotals }> {
    const { from, to } = this.periodRange('day');
    const payments = await this.paymentModel
      .find({ stylistId: new Types.ObjectId(user.staffId ?? user.sub), date: { $gte: from, $lte: to } })
      .sort({ date: -1 });
    return { payments, totals: this.totals(payments) };
  }

  async overview(): Promise<{
    totals: CaisseTotals;
    byStylist: { stylistId: string; name: string; gross: number; tips: number; commission: number }[];
    payments: PaymentDocument[];
  }> {
    const { from, to } = this.periodRange('day');
    const payments = await this.paymentModel.find({ date: { $gte: from, $lte: to } });
    const stylists = await this.staffModel.find({ role: { $in: ['owner', 'manager', 'stylist'] } });
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

  async refund(user: AuthUser, id: string): Promise<PaymentDocument> {
    const payment = await this.paymentModel.findOne({ _id: id });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.refunded) throw new BadRequestException('Payment already refunded.');
    payment.refunded = true;
    payment.refundedBy = new Types.ObjectId(user.sub);
    payment.refundedAt = new Date();
    await payment.save();
    await this.saleModel.create({
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

  async listExpenses(): Promise<ExpenseDocument[]> {
    return this.expenseModel.find({}).sort({ date: -1 });
  }

  async createExpense(user: AuthUser, dto: CreateExpenseDto): Promise<ExpenseDocument> {
    return this.expenseModel.create({
      category: dto.category,
      amount: dto.amount,
      date: dto.date ? new Date(`${dto.date}T00:00:00.000Z`) : new Date(),
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(user.sub),
    });
  }

  async updateExpense(id: string, dto: UpdateExpenseDto): Promise<ExpenseDocument> {
    const e = await this.expenseModel.findOne({ _id: id });
    if (!e) throw new NotFoundException('Expense not found.');
    if (dto.category !== undefined) e.category = dto.category;
    if (dto.amount !== undefined) e.amount = dto.amount;
    if (dto.date !== undefined) e.date = new Date(`${dto.date}T00:00:00.000Z`);
    if (dto.note !== undefined) e.note = dto.note;
    await e.save();
    return e;
  }

  async deleteExpense(id: string): Promise<{ id: string }> {
    const e = await this.expenseModel.findOneAndDelete({ _id: id });
    if (!e) throw new NotFoundException('Expense not found.');
    return { id };
  }

  // ─── Rapports + CSV ────────────────────────────────────────────────────────────

  async report(period: Period): Promise<{
    period: Period;
    revenue: number;
    revenueChangePct: number;
    tips: number;
    expenses: number;
    net: number;
    salesCount: number;
    byStylist: { stylistId: string; name: string; revenue: number }[];
  }> {
    const { from, to } = this.periodRange(period);
    const sales = await this.saleModel.find({ date: { $gte: from, $lte: to } });
    const payments = await this.paymentModel.find({
      date: { $gte: from, $lte: to },
      refunded: false,
    });
    const expenses = await this.expenseModel.find({ date: { $gte: from, $lte: to } });
    const revenue = sales.reduce((a, s) => a + s.total, 0);
    const tips = payments.reduce((a, p) => a + p.tip, 0);
    const exp = expenses.reduce((a, e) => a + e.amount, 0);

    const prior = this.priorRange({ from, to });
    const priorSales = await this.saleModel.find({ date: { $gte: prior.from, $lte: prior.to } });
    const priorRevenue = priorSales.reduce((a, s) => a + s.total, 0);
    const revenueChangePct = priorRevenue === 0 ? (revenue > 0 ? 100 : 0) : Math.round(((revenue - priorRevenue) / priorRevenue) * 100);

    const stylists = await this.staffModel.find({ role: { $in: ['owner', 'manager', 'stylist', 'colorist'] } });
    const nameOf = new Map(stylists.map((s) => [s._id.toString(), s.name]));
    const revByStylist = new Map<string, number>();
    for (const s of sales) {
      if (!s.stylistId) continue;
      const id = s.stylistId.toString();
      revByStylist.set(id, (revByStylist.get(id) ?? 0) + s.total);
    }
    const byStylist = [...revByStylist.entries()]
      .map(([stylistId, revenue]) => ({ stylistId, name: nameOf.get(stylistId) ?? '—', revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    return { period, revenue, revenueChangePct, tips, expenses: exp, net: revenue + tips - exp, salesCount: sales.length, byStylist };
  }

  async exportCsv(period: Period): Promise<string> {
    const { from, to } = this.periodRange(period);
    const sales = await this.saleModel.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 });
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
