import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LossAlert, LossAlertDocument, LossAlertKind, LossAlertSeverity } from './schemas/loss-alert.schema';
import { DoseLogDocument } from './schemas/dose-log.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { LossControlAnalyticsService } from './loss-control-analytics.service';
import { NotificationsGateway, roleRoom } from '../notifications/notifications.gateway';
import { SOCKET_EVENTS } from '../common/socket-events';
import { getTenantContext } from '../common/tenant/tenant-context';
import { startOfDayInTz, endOfDayInTz, isoDateInTz } from '../common/time/tz-day.util';

interface EmitInput {
  kind: LossAlertKind;
  severity: LossAlertSeverity;
  productId?: string;
  stylistId?: string;
  appointmentId?: string;
  expected: number;
  declared: number;
  actual?: number;
  variancePct: number;
  thresholdPct: number;
  period?: { from: Date; to: Date };
  /** Clé de dédup — mêmes champs que le filtre "cible identique" de la stratégie anti-spam. */
  dedupFilter: Record<string, unknown>;
}

/**
 * LC-6/LC-7/LC-10 (SKILL_loss_control_doses.md, Prompt 5) — émission des alertes.
 *
 * ⚠️ HIÉRARCHIE DE SÉVÉRITÉ — appliquée ICI, pas laissée à l'appelant :
 *   `stock_variance` (Calc 2, preuve physique) peut être 'critical'.
 *   `staff_honesty`/`extreme_usage` (Calc 1/3, signaux déclaratifs gameables) sont TOUJOURS
 *   'warning', jamais 'critical' — un staff malhonnête qui déclare pile le théorique reste
 *   invisible à ces deux calculs, ils ne peuvent donc jamais porter le même poids qu'un
 *   comptage physique.
 *
 * Stratégie anti-spam retenue (rapportée, pas un champ dédié type "dedupKey") : avant de
 * créer une alerte, on cherche une alerte NON LUE de MÊME kind + MÊME cible (productId /
 * stylistId+period.from / appointmentId+productId selon le kind) — si elle existe, on
 * n'émet rien. Une alerte marquée lue (`POST .../read`) rouvre la fenêtre : la condition
 * peut se re-signaler. Pas de fenêtre temporelle glissante séparée — "non lue" EST la
 * fenêtre, ce qui correspond à l'usage réel (l'owner accuse réception, le compteur repart).
 */
@Injectable()
export class LossAlertService {
  private readonly logger = new Logger(LossAlertService.name);

  constructor(
    @InjectModel(LossAlert.name) private readonly alertModel: Model<LossAlertDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    private readonly analytics: LossControlAnalyticsService,
    private readonly gateway: NotificationsGateway,
  ) {}

  private async lossControlSettings(): Promise<{ enabled: boolean; varianceThresholdPct: number; extremeUsageFactor: number }> {
    const salon = await this.salonModel.findById(getTenantContext().tenantId).select('lossControl').lean();
    return {
      enabled: salon?.lossControl?.alertsEnabled ?? false,
      varianceThresholdPct: salon?.lossControl?.varianceThresholdPct ?? 15,
      extremeUsageFactor: salon?.lossControl?.extremeUsageFactor ?? 2,
    };
  }

  /**
   * Calc 2 — appelée après un comptage physique (`StockService.declareInventoryCount()`),
   * le seul moment où une NOUVELLE paire baseline/réel devient disponible. `severity:'critical'`
   * — c'est le détecteur non contournable.
   * ⚠️ [2] SANS baseline (`hasBaseline:false`), on ne sait rien : AUCUNE alerte, jamais.
   */
  async checkStockVariance(productId: string): Promise<LossAlertDocument | null> {
    const settings = await this.lossControlSettings();
    if (!settings.enabled) return null;

    const result = await this.analytics.variance(productId);
    if (!result.hasBaseline) return null; // [2] — on ne mesure rien, on n'alerte sur rien

    const product = await this.productModel.findById(productId).select('varianceThresholdPct').lean();
    const thresholdPct = product?.varianceThresholdPct ?? settings.varianceThresholdPct; // [3] LC-T10 : le seuil produit prime
    if (Math.abs(result.variancePct!) <= thresholdPct) return null;

    return this.emit({
      kind: 'stock_variance',
      severity: 'critical',
      productId,
      expected: result.stockTheoretical!,
      declared: result.stockReal!,
      variancePct: result.variancePct!,
      thresholdPct,
      dedupFilter: { kind: 'stock_variance', productId },
    });
  }

  /**
   * Calc 3 — appelée juste après l'upsert d'un `DoseLog` (`DoseLogService`). Évaluation PAR
   * ENTRÉE, pas agrégée — c'est ce qui la rend investigable via `appointmentId` (LC-9).
   * `severity` toujours 'warning' — jamais 'critical' (signal déclaratif).
   */
  async checkExtremeUsage(log: DoseLogDocument): Promise<LossAlertDocument | null> {
    const settings = await this.lossControlSettings();
    if (!settings.enabled) return null;
    if (log.dosesDeclared <= log.dosesExpected * settings.extremeUsageFactor) return null;

    return this.emit({
      kind: 'extreme_usage',
      severity: 'warning',
      productId: log.productId,
      stylistId: log.stylistId,
      appointmentId: log.appointmentId,
      expected: log.dosesExpected,
      declared: log.dosesDeclared,
      variancePct: log.variancePct,
      thresholdPct: settings.extremeUsageFactor * 100,
      dedupFilter: { kind: 'extreme_usage', appointmentId: log.appointmentId, productId: log.productId },
    });
  }

  /**
   * Calc 1 — appelée après l'upsert d'un `DoseLog`, agrégée sur le staff déclarant, fenêtre
   * glissante du mois calendaire courant (Africa/Tunis). `severity` toujours 'warning'.
   */
  async checkStaffHonesty(stylistId: string): Promise<LossAlertDocument | null> {
    const settings = await this.lossControlSettings();
    if (!settings.enabled) return null;

    const { byStaff } = await this.analytics.staffHonesty('month', stylistId);
    const row = byStaff[0];
    if (!row || row.expected === 0) return null;
    if (Math.abs(row.variancePct) <= settings.varianceThresholdPct) return null;

    const monthStart = `${isoDateInTz(new Date()).slice(0, 7)}-01`;
    const period = { from: startOfDayInTz(monthStart), to: endOfDayInTz(isoDateInTz(new Date())) };

    return this.emit({
      kind: 'staff_honesty',
      severity: 'warning',
      stylistId,
      expected: row.expected,
      declared: row.declared,
      variancePct: row.variancePct,
      thresholdPct: settings.varianceThresholdPct,
      period,
      dedupFilter: { kind: 'staff_honesty', stylistId, 'period.from': period.from },
    });
  }

  /** Persist-then-emit (LC-10) : jamais l'inverse. Room scopée tenant via `roleRoom()` partagé. */
  private async emit(input: EmitInput): Promise<LossAlertDocument | null> {
    const tenantId = getTenantContext().tenantId;

    const existing = await this.alertModel.findOne({ ...input.dedupFilter, read: false }).lean();
    if (existing) return null; // anti-spam : une alerte identique non lue existe déjà

    const alert = await this.alertModel.create({
      salonId: tenantId,
      kind: input.kind,
      severity: input.severity,
      productId: input.productId,
      stylistId: input.stylistId,
      appointmentId: input.appointmentId,
      expected: input.expected,
      declared: input.declared,
      actual: input.actual,
      variancePct: input.variancePct,
      thresholdPct: input.thresholdPct,
      period: input.period,
      read: false,
    });

    this.gateway.emitToRoom(roleRoom(tenantId, 'owner'), SOCKET_EVENTS.LOSS_ALERT, alert);
    this.logger.log(`LossAlert emitted: ${input.kind}/${input.severity} for tenant ${tenantId}.`);
    return alert;
  }
}
