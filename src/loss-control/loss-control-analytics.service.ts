import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { DoseLog, DoseLogDocument } from './schemas/dose-log.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { StockMove, StockMoveDocument } from '../stock/schemas/stock-move.schema';
import { Sale, SaleDocument } from '../finance/schemas/sale.schema';
import { Payment, PaymentDocument } from '../finance/schemas/payment.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { AnalyticsPeriod } from './dto/loss-control-analytics.dto';
import { startOfDayInTz, endOfDayInTz, isoDateInTz, shiftIsoDate } from '../common/time/tz-day.util';
import { getTenantContext } from '../common/tenant/tenant-context';

export interface StaffHonestyRow {
  stylistId: string;
  expected: number;
  declared: number;
  variancePct: number;
  byProduct: { productId: string; expected: number; declared: number; variancePct: number }[];
}

export interface VarianceResult {
  productId: string;
  hasBaseline: boolean;
  baselineDate?: string;
  stockTheoretical?: number;
  stockReal?: number;
  variance?: number;
  variancePct?: number;
  breakdown?: { refill: number; loss: number; adjustment: number; sold: number; consumedUnits: number };
}

export interface ExtremeUsageRow {
  doseLogId: string;
  appointmentId: string;
  stylistId: string;
  productId: string;
  dosesDeclared: number;
  dosesExpected: number;
  variancePct: number;
  extremeUsageFactor: number;
}

export interface InvestigationDoseRow {
  productId: string;
  productName: string;
  dosesDeclared: number;
  dosesExpected: number;
  variancePct: number;
  lockedAt: string | null;
  correctedBy?: string;
  correctionNote?: string;
}

export interface InvestigationResult {
  appointment: {
    id: string;
    status: string;
    source: string;
    start: string;
    client: { name: string; phone: string };
    stylist: { id: string; name: string };
    services: { id: string; name: string; price: number; durationMin: number }[];
  };
  doses: InvestigationDoseRow[];
  payment: {
    id: string;
    amount: number;
    method: string;
    commission: number;
    productCommission: number;
  } | null;
}

/**
 * LC-6 (SKILL_loss_control_doses.md, Prompt 4) — les trois calculs d'écart. Purement lecture,
 * aucune écriture ici. Hiérarchie à respecter dans toute UI qui consomme ceci : Calc 2
 * (`variance()`) est le SEUL détecteur non contournable (compare le stock RÉEL constaté, pas
 * une déclaration) ; Calc 1 (`staffHonesty()`) et Calc 3 (`extremeUsage()`) reposent sur la
 * déclaration du staff — un vol camouflé en déclarant pile le théorique y est invisible.
 */
@Injectable()
export class LossControlAnalyticsService {
  constructor(
    @InjectModel(DoseLog.name) private readonly doseLogModel: Model<DoseLogDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Appointment.name) private readonly appointmentModel: Model<AppointmentDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
  ) {}

  private periodRange(period: AnalyticsPeriod, ref = new Date()): { from: Date; to: Date } {
    const refDay = isoDateInTz(ref);
    const to = endOfDayInTz(refDay);
    let fromDay = refDay;
    if (period === 'week') fromDay = shiftIsoDate(refDay, -6);
    if (period === 'month') fromDay = `${refDay.slice(0, 7)}-01`;
    return { from: startOfDayInTz(fromDay), to };
  }

  /**
   * Calc 1 (LC-6.1) — écart d'honnêteté par staff : déclaré vs théorique SNAPSHOTÉ
   * (`DoseLog.dosesExpected`, jamais recalculé depuis le `doseConfig` actuel — un changement
   * de config après coup ne doit jamais réécrire un écart passé). `expected === 0` → pas de
   * division, `variancePct = 0` (rien à mesurer, pas "aucun écart" au sens propre).
   */
  async staffHonesty(period?: AnalyticsPeriod, stylistId?: string): Promise<{ byStaff: StaffHonestyRow[] }> {
    const filter: FilterQuery<DoseLogDocument> = {};
    if (stylistId) filter.stylistId = stylistId;
    if (period) {
      const { from, to } = this.periodRange(period);
      filter.declaredAt = { $gte: from, $lte: to };
    }
    const logs = await this.doseLogModel
      .find(filter)
      .select('stylistId productId dosesDeclared dosesExpected')
      .lean();

    const pct = (declared: number, expected: number) => (expected > 0 ? ((declared - expected) / expected) * 100 : 0);

    const byStaffMap = new Map<
      string,
      { expected: number; declared: number; byProduct: Map<string, { expected: number; declared: number }> }
    >();
    for (const log of logs) {
      const staffAgg = byStaffMap.get(log.stylistId) ?? { expected: 0, declared: 0, byProduct: new Map() };
      staffAgg.expected += log.dosesExpected;
      staffAgg.declared += log.dosesDeclared;
      const productAgg = staffAgg.byProduct.get(log.productId) ?? { expected: 0, declared: 0 };
      productAgg.expected += log.dosesExpected;
      productAgg.declared += log.dosesDeclared;
      staffAgg.byProduct.set(log.productId, productAgg);
      byStaffMap.set(log.stylistId, staffAgg);
    }

    const byStaff: StaffHonestyRow[] = [...byStaffMap.entries()].map(([sid, agg]) => ({
      stylistId: sid,
      expected: agg.expected,
      declared: agg.declared,
      variancePct: pct(agg.declared, agg.expected),
      byProduct: [...agg.byProduct.entries()].map(([pid, p]) => ({
        productId: pid,
        expected: p.expected,
        declared: p.declared,
        variancePct: pct(p.declared, p.expected),
      })),
    }));

    return { byStaff };
  }

  /**
   * Calc 2 (LC-6.2) — LE détecteur non contournable. Point de départ : le dernier comptage
   * physique (`StockMove kind:'inventory'`) — sans lui, `hasBaseline:false` explicite, JAMAIS
   * un 0 % trompeur (comparer du théorique à du théorique ne prouve rien).
   *
   * ⚠️ Sélection baseline/réel : les DEUX inventaires les plus récents (≤ `windowTo`) servent
   * de paire — le plus ANCIEN des deux est la baseline ("depuis notre dernier comptage avant
   * celui-ci"), le plus RÉCENT est "le prochain inventaire" qui fait foi sur le réel. Avec un
   * seul inventaire jamais posé, il est à la fois la baseline ET il n'y a pas de "prochain" —
   * le réel retombe alors sur `Product.stock` (l'état courant). Une lecture purement "dernier
   * inventaire = le plus récent" rendrait la clause "ou le prochain inventaire s'il existe" du
   * skill structurellement inatteignable (rien ne peut jamais être postérieur au plus récent) ;
   * cette sélection par paire est celle qui satisfait le jeu de données connu du Prompt 4
   * (baseline 10 → mouvements → prochain inventaire 9, écart −3, −25 %).
   *
   * ⚠️ Convention de signe : `variance = stockRéel − stockThéorique` (négatif = stock manquant)
   * — cohérente avec `StockMove.variance` (Prompt 3, `countedStock − previousStock`), PAS avec
   * le texte brut du skill (`théorique − réel`). Les deux ne peuvent pas être simultanément
   * vraies ; celle-ci est celle que le jeu de données connu du Prompt 4 valide à la main.
   */
  async variance(productId: string, period?: AnalyticsPeriod): Promise<VarianceResult> {
    const product = await this.productModel.findOne({ _id: productId }).lean();
    if (!product) throw new NotFoundException('Product not found.');

    const windowTo = period ? this.periodRange(period).to : new Date();

    const lastTwoInventories = await this.moveModel
      .find({ productId: new Types.ObjectId(productId), kind: 'inventory', date: { $lte: windowTo } })
      .sort({ date: -1 })
      .limit(2)
      .lean();
    if (lastTwoInventories.length === 0) {
      return { productId, hasBaseline: false };
    }
    const nextInventory = lastTwoInventories.length >= 2 ? lastTwoInventories[0] : null;
    const baseline = lastTwoInventories.length >= 2 ? lastTwoInventories[1] : lastTwoInventories[0];

    const windowFrom = baseline.date;

    const moves = await this.moveModel
      .find({ productId: new Types.ObjectId(productId), date: { $gt: windowFrom, $lte: windowTo } })
      .lean();
    const refillSum = moves.filter((m) => m.kind === 'refill').reduce((s, m) => s + m.qty, 0);
    const lossSum = moves.filter((m) => m.kind === 'loss').reduce((s, m) => s + m.qty, 0);
    const adjustmentSum = moves
      .filter((m) => m.kind === 'adjustment')
      .reduce((s, m) => s + (m.type === 'in' ? m.qty : -m.qty), 0);

    const sales = await this.saleModel
      .find({ 'items.refId': productId, date: { $gt: windowFrom, $lte: windowTo } })
      .select('items')
      .lean();
    const soldSum = sales.reduce(
      (s, sale) => s + sale.items.filter((i) => i.refId === productId).reduce((a, i) => a + i.qty, 0),
      0,
    );

    const doseLogs = await this.doseLogModel
      .find({ productId, declaredAt: { $gt: windowFrom, $lte: windowTo } })
      .select('dosesDeclared')
      .lean();
    const dosesSum = doseLogs.reduce((s, d) => s + d.dosesDeclared, 0);
    const consumedUnits = product.dosesPerUnit ? dosesSum / product.dosesPerUnit : 0;

    const stockTheoretical = baseline.qty + refillSum - lossSum + adjustmentSum - soldSum - consumedUnits;

    // "ou le prochain inventaire s'il existe" — le second comptage de la paire fait foi sur le
    // réel plutôt que `Product.stock`, qui a pu bouger depuis pour d'autres raisons.
    const stockReal = nextInventory ? nextInventory.qty : product.stock;

    const variance = stockReal - stockTheoretical;
    const variancePct = stockTheoretical !== 0 ? (variance / stockTheoretical) * 100 : 0;

    return {
      productId,
      hasBaseline: true,
      baselineDate: baseline.date.toISOString(),
      stockTheoretical,
      stockReal,
      variance,
      variancePct,
      breakdown: { refill: refillSum, loss: lossSum, adjustment: adjustmentSum, sold: soldSum, consumedUnits },
    };
  }

  /**
   * Calc 3 (LC-6.3) — usage extrême par déclaration. `extremeUsageFactor` lu sur
   * `Salon.lossControl` (défaut schéma 2) — l'émission d'alerte reste le Prompt 5, ceci ne fait
   * que calculer/lister les candidats.
   */
  async extremeUsage(period?: AnalyticsPeriod): Promise<ExtremeUsageRow[]> {
    const salon = await this.salonModel.findById(getTenantContext().tenantId).select('lossControl').lean();
    const factor = salon?.lossControl?.extremeUsageFactor ?? 2;

    const filter: FilterQuery<DoseLogDocument> = {};
    if (period) {
      const { from, to } = this.periodRange(period);
      filter.declaredAt = { $gte: from, $lte: to };
    }
    const logs = await this.doseLogModel.find(filter).lean();

    return logs
      .filter((l) => l.dosesDeclared > l.dosesExpected * factor)
      .map((l) => ({
        doseLogId: (l._id as Types.ObjectId).toString(),
        appointmentId: l.appointmentId,
        stylistId: l.stylistId,
        productId: l.productId,
        dosesDeclared: l.dosesDeclared,
        dosesExpected: l.dosesExpected,
        variancePct: l.variancePct,
        extremeUsageFactor: factor,
      }));
  }

  /**
   * LC-9 (SKILL_loss_control_doses.md, Prompt 7) — détail d'investigation d'un RDV : ouvert
   * depuis une alerte `extreme_usage` (porte déjà `appointmentId`) OU depuis la Caisse (via
   * `CaisseEntry.appointmentId`, Prompt 7). Un RDV sans DoseLog (service non dosable, ou
   * déclaration jamais faite) renvoie une structure valide avec `doses:[]` — jamais une erreur,
   * l'absence de déclaration EST une information pour l'owner, pas un état cassé.
   */
  async investigateAppointment(appointmentId: string): Promise<InvestigationResult> {
    const appt = await this.appointmentModel.findOne({ _id: appointmentId }).lean();
    if (!appt) throw new NotFoundException('Appointment not found.');

    const [client, stylist, services, doseLogs, payment] = await Promise.all([
      this.clientModel.findById(appt.clientId).select('name phone').lean(),
      this.staffModel.findById(appt.stylistId).select('name').lean(),
      this.serviceModel.find({ _id: { $in: appt.services } }).select('name price durationMin').lean(),
      this.doseLogModel.find({ appointmentId }).sort({ productId: 1 }).lean(),
      this.paymentModel.findOne({ appointmentId: new Types.ObjectId(appointmentId) }).lean(),
    ]);

    const productIds = [...new Set(doseLogs.map((d) => d.productId))];
    const products = productIds.length
      ? await this.productModel.find({ _id: { $in: productIds } }).select('name').lean()
      : [];
    const productNameOf = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p.name]));

    return {
      appointment: {
        id: (appt._id as Types.ObjectId).toString(),
        status: appt.status,
        source: appt.source,
        start: appt.start.toISOString(),
        client: { name: client?.name ?? '—', phone: client?.phone ?? '' },
        stylist: { id: appt.stylistId.toString(), name: stylist?.name ?? '—' },
        services: services.map((s) => ({
          id: (s._id as Types.ObjectId).toString(),
          name: s.name,
          price: s.price,
          durationMin: s.durationMin,
        })),
      },
      doses: doseLogs.map((d) => ({
        productId: d.productId,
        productName: productNameOf.get(d.productId) ?? '—',
        dosesDeclared: d.dosesDeclared,
        dosesExpected: d.dosesExpected,
        variancePct: d.variancePct,
        lockedAt: d.lockedAt ? d.lockedAt.toISOString() : null,
        correctedBy: d.correctedBy,
        correctionNote: d.correctionNote || undefined,
      })),
      payment: payment
        ? {
            id: (payment._id as Types.ObjectId).toString(),
            amount: payment.amount,
            method: payment.method,
            commission: payment.commission,
            productCommission: payment.productCommission,
          }
        : null,
    };
  }
}
