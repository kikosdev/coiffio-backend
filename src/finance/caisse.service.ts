import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Payment, PaymentDocument } from './schemas/payment.schema';
import { Sale, SaleDocument } from './schemas/sale.schema';
import { CashSession, CashSessionDocument } from './schemas/cash-session.schema';
import { CashMovement, CashMovementDocument } from './schemas/cash-movement.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { CloseSessionDto, CreateCashMovementDto, OpenSessionDto } from './dto/caisse.dto';
import { PosUser } from '../common/guards/pos-scope.guard';
import { endOfDayInTz, startOfDayInTz, todayIsoInTz } from '../common/time/tz-day.util';

export type CaisseEntryKind = 'opening' | 'sale' | 'refund' | 'movement' | 'closing';

export interface CaisseEntry {
  id: string;
  at: Date;
  kind: CaisseEntryKind;
  label: string;
  method?: 'cash' | 'card';
  /** Signé : positif = entrée, négatif = sortie. */
  amount: number;
  /** `false` pour les lignes carte : présentes au journal, hors théorique tiroir. */
  affectsDrawer: boolean;
  staffName: string;
  note?: string;
}

export interface CaisseTotalsDay {
  openingFloat: number;
  cashSales: number;
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
  /** fond + ventes cash − remboursements cash + entrées − sorties. */
  expectedCash: number;
  cardSales: number;
  /** Informatif : NON compté dans `expectedCash` (cf. docstring `computeTotals`). */
  cashTips: number;
  ticketCount: number;
}

export interface CaisseDay {
  day: string;
  session: CashSessionDocument | null;
  totals: CaisseTotalsDay;
  entries: CaisseEntry[];
  /** Le client n'a pas à décoder le JWT pour savoir s'il peut clôturer — le serveur tranche. */
  canClose: boolean;
}

@Injectable()
export class CaisseService {
  constructor(
    @InjectModel(CashSession.name) private readonly sessionModel: Model<CashSessionDocument>,
    @InjectModel(CashMovement.name) private readonly movementModel: Model<CashMovementDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
  ) {}

  /** Seul un owner/manager (JWT régulier) clôture — un token PIN staff a `scope: 'pos'`. */
  private isManager(posUser: PosUser): boolean {
    return posUser.scope === 'owner';
  }

  private round(n: number): number {
    return Math.round(n * 1000) / 1000; // TND = 3 décimales (millimes)
  }

  private async nameMap(ids: (Types.ObjectId | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is Types.ObjectId => !!id).map((id) => id.toString()))];
    if (unique.length === 0) return new Map();
    const staff = await this.staffModel.find({ _id: { $in: unique } }).select('name').lean();
    return new Map(staff.map((s) => [s._id.toString(), s.name]));
  }

  /** Pourboire et rendu de monnaie sur une même ligne — ce qu'un contrôle de tiroir
   *  cherche à reconstituer quand un ticket ne tombe pas juste. */
  private paymentNote(p: PaymentDocument): string | undefined {
    const parts: string[] = [];
    if (p.tip > 0) parts.push(`Pourboire ${this.round(p.tip)}`);
    if (p.cashReceived !== undefined) {
      parts.push(`Reçu ${this.round(p.cashReceived)} · rendu ${this.round(p.changeGiven ?? 0)}`);
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  private async findSession(day: string): Promise<CashSessionDocument | null> {
    return this.sessionModel.findOne({ day });
  }

  // ─── Lecture ───────────────────────────────────────────────────────────────

  /**
   * Sources d'espèces de la journée, sans double comptage — il existe DEUX chemins
   * d'encaissement qui écrivent tous deux un `Sale` :
   *   - `FinanceService.createPayment` (prestations + produits) → `Payment` + `Sale` lié
   *     par `paymentId`. Le `method` est porté par le `Payment`.
   *   - `SalesService.create` (vente retail comptoir) → `Sale` SEUL, sans `paymentId`,
   *     qui porte lui-même son `method`.
   * On lit donc les `Payment` d'un côté et UNIQUEMENT les `Sale` orphelins de l'autre.
   *
   * Un paiement compte pour le jour de SA date même s'il a été remboursé plus tard : le
   * cash était bien dans le tiroir ce jour-là. Le remboursement est une ligne distincte,
   * imputée au jour de `refundedAt`.
   *
   * Les pourboires espèces sont remontés à part et NON ajoutés au théorique : par défaut
   * ils vont au staff, pas au tiroir. Si le salon les encaisse, il faudra les basculer ici
   * (une seule ligne) plutôt que de vivre avec un écart positif systématique.
   */
  private async computeTotals(day: string, session: CashSessionDocument | null): Promise<{
    totals: CaisseTotalsDay;
    payments: PaymentDocument[];
    refunds: PaymentDocument[];
    retailSales: SaleDocument[];
    movements: CashMovementDocument[];
  }> {
    const from = startOfDayInTz(day);
    const to = endOfDayInTz(day);

    const [payments, refunds, retailSales, movements] = await Promise.all([
      this.paymentModel.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 }),
      this.paymentModel.find({ refunded: true, refundedAt: { $gte: from, $lte: to } }).sort({ refundedAt: 1 }),
      this.saleModel
        .find({ source: 'pos', paymentId: { $exists: false }, voided: { $ne: true }, date: { $gte: from, $lte: to } })
        .sort({ date: 1 }),
      session
        ? this.movementModel.find({ sessionId: session._id }).sort({ date: 1 })
        : Promise.resolve([] as CashMovementDocument[]),
    ]);

    const cashPayments = payments.filter((p) => p.method === 'cash');
    const cashRetail = retailSales.filter((s) => s.method === 'cash');

    const openingFloat = session?.openingFloat ?? 0;
    const cashSales =
      cashPayments.reduce((a, p) => a + p.amount, 0) + cashRetail.reduce((a, s) => a + s.total, 0);
    const cashRefunds = refunds.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
    const cashIn = movements.filter((m) => m.type === 'in').reduce((a, m) => a + m.amount, 0);
    const cashOut = movements.filter((m) => m.type === 'out').reduce((a, m) => a + m.amount, 0);
    const cardSales =
      payments.filter((p) => p.method === 'card').reduce((a, p) => a + p.amount, 0) +
      retailSales.filter((s) => s.method === 'card').reduce((a, s) => a + s.total, 0);

    return {
      totals: {
        openingFloat: this.round(openingFloat),
        cashSales: this.round(cashSales),
        cashRefunds: this.round(cashRefunds),
        cashIn: this.round(cashIn),
        cashOut: this.round(cashOut),
        expectedCash: this.round(openingFloat + cashSales - cashRefunds + cashIn - cashOut),
        cardSales: this.round(cardSales),
        cashTips: this.round(cashPayments.reduce((a, p) => a + p.tip, 0)),
        ticketCount: payments.length + retailSales.length,
      },
      payments,
      refunds,
      retailSales,
      movements,
    };
  }

  async getDay(posUser: PosUser, date?: string): Promise<CaisseDay> {
    const day = date ?? todayIsoInTz();
    const session = await this.findSession(day);
    const { totals, payments, refunds, retailSales, movements } = await this.computeTotals(day, session);

    const names = await this.nameMap([
      session?.openedBy,
      session?.closedBy,
      ...payments.map((p) => p.stylistId),
      ...refunds.map((p) => p.stylistId),
      ...retailSales.map((s) => s.stylistId),
      ...movements.map((m) => m.createdBy),
    ]);
    const nameOf = (id?: Types.ObjectId) => (id ? names.get(id.toString()) ?? '—' : '—');

    const entries: CaisseEntry[] = [];

    if (session) {
      entries.push({
        id: `${session._id}-open`,
        at: session.openedAt,
        kind: 'opening',
        label: 'Ouverture de caisse',
        amount: session.openingFloat,
        affectsDrawer: true,
        staffName: nameOf(session.openedBy),
        note: session.note || undefined,
      });
    }

    for (const p of payments) {
      const method = p.method === 'card' ? ('card' as const) : ('cash' as const);
      entries.push({
        id: (p._id as Types.ObjectId).toString(),
        at: p.date,
        kind: 'sale',
        label: p.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || 'Encaissement',
        method,
        amount: p.amount,
        affectsDrawer: method === 'cash',
        staffName: nameOf(p.stylistId),
        note: this.paymentNote(p),
      });
    }

    for (const s of retailSales) {
      const method = s.method === 'card' ? ('card' as const) : ('cash' as const);
      entries.push({
        id: (s._id as Types.ObjectId).toString(),
        at: s.date,
        kind: 'sale',
        label: s.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || 'Vente retail',
        method,
        amount: s.total,
        affectsDrawer: method === 'cash',
        staffName: nameOf(s.stylistId),
      });
    }

    for (const p of refunds) {
      const method = p.method === 'card' ? ('card' as const) : ('cash' as const);
      entries.push({
        id: `${p._id}-refund`,
        at: p.refundedAt!,
        kind: 'refund',
        label: 'Remboursement',
        method,
        amount: -p.amount,
        affectsDrawer: method === 'cash',
        staffName: nameOf(p.refundedBy ?? p.stylistId),
      });
    }

    for (const m of movements) {
      entries.push({
        id: (m._id as Types.ObjectId).toString(),
        at: m.date,
        kind: 'movement',
        label: m.type === 'in' ? `Entrée — ${m.reason}` : `Sortie — ${m.reason}`,
        amount: m.type === 'in' ? m.amount : -m.amount,
        affectsDrawer: true,
        staffName: nameOf(m.createdBy),
        note: m.note || undefined,
      });
    }

    if (session?.status === 'closed' && session.closedAt) {
      entries.push({
        id: `${session._id}-close`,
        at: session.closedAt,
        kind: 'closing',
        label: 'Clôture de caisse',
        amount: session.countedTotal ?? 0,
        affectsDrawer: false,
        staffName: nameOf(session.closedBy),
        note: session.closingNote || undefined,
      });
    }

    entries.sort((a, b) => a.at.getTime() - b.at.getTime());

    return { day, session, totals, entries, canClose: this.isManager(posUser) };
  }

  /**
   * Refuse TOUT encaissement comptoir tant que la journée de caisse n'est pas ouverte
   * (espèces comme carte — décision explicite : le comptoir ne vend pas hors session, sinon
   * le journal du jour raconte une histoire incomplète et l'écart de la première clôture est
   * faux sans que personne sache pourquoi).
   *
   * Le code d'erreur est lu par le POS, qui affiche « Caisse fermée » et renvoie vers l'écran
   * Caisse plutôt que de laisser l'opérateur devant un message d'erreur brut.
   *
   * Portée : routes POS uniquement. Un encaissement backoffice (`POST /payments`) n'est pas
   * gêné — il ne passe pas par le tiroir du comptoir.
   */
  async assertOpenForSale(): Promise<void> {
    const session = await this.findSession(todayIsoInTz());
    if (!session) {
      throw new ConflictException({
        code: 'CAISSE_NOT_OPEN',
        message: 'Caisse fermée — ouvrez la caisse avant d\'encaisser.',
      });
    }
    if (session.status === 'closed') {
      throw new ConflictException({
        code: 'CAISSE_CLOSED',
        message: 'La caisse du jour est clôturée — plus aucun encaissement possible.',
      });
    }
  }

  async history(posUser: PosUser, limit = 30): Promise<CashSessionDocument[]> {
    if (!this.isManager(posUser)) {
      throw new ForbiddenException("L'historique de caisse est réservé au manager ou au propriétaire.");
    }
    return this.sessionModel.find({}).sort({ day: -1 }).limit(limit);
  }

  // ─── Écritures ─────────────────────────────────────────────────────────────

  async open(posUser: PosUser, dto: OpenSessionDto): Promise<CashSessionDocument> {
    const day = todayIsoInTz();
    const existing = await this.findSession(day);
    if (existing) {
      throw new ConflictException(
        existing.status === 'open' ? 'La caisse est déjà ouverte pour aujourd\'hui.' : 'La caisse du jour est déjà clôturée.',
      );
    }
    try {
      return await this.sessionModel.create({
        day,
        status: 'open',
        openingFloat: dto.openingFloat,
        openedBy: new Types.ObjectId(posUser.staffId),
        openedAt: new Date(),
        note: dto.note ?? '',
      });
    } catch (err) {
      // Course entre deux postes : l'index unique {salonId, locationId, day} tranche.
      if (this.isDuplicateKey(err)) throw new ConflictException('La caisse est déjà ouverte pour aujourd\'hui.');
      throw err;
    }
  }

  private isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }

  async addMovement(posUser: PosUser, dto: CreateCashMovementDto): Promise<CashMovementDocument> {
    const day = todayIsoInTz();
    const session = await this.findSession(day);
    if (!session) throw new ConflictException('Ouvrez la caisse avant de saisir un mouvement.');
    if (session.status === 'closed') throw new ConflictException('La caisse du jour est clôturée.');

    return this.movementModel.create({
      sessionId: session._id,
      type: dto.type,
      amount: dto.amount,
      reason: dto.reason ?? 'autre',
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(posUser.staffId),
      date: new Date(),
    });
  }

  async close(posUser: PosUser, dto: CloseSessionDto): Promise<CashSessionDocument> {
    if (!this.isManager(posUser)) {
      throw new ForbiddenException('Seul un manager ou le propriétaire peut clôturer la caisse.');
    }
    const day = todayIsoInTz();
    const session = await this.findSession(day);
    if (!session) throw new NotFoundException('Aucune caisse ouverte pour aujourd\'hui.');
    if (session.status === 'closed') throw new ConflictException('La caisse du jour est déjà clôturée.');

    const { totals } = await this.computeTotals(day, session);
    session.status = 'closed';
    session.countedTotal = dto.countedTotal;
    session.expectedTotal = totals.expectedCash;
    session.variance = this.round(dto.countedTotal - totals.expectedCash);
    session.closedBy = new Types.ObjectId(posUser.staffId);
    session.closedAt = new Date();
    session.closingNote = dto.note ?? '';
    await session.save();
    return session;
  }
}
