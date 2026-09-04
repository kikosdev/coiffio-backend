import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { SalaryAdvance, SalaryAdvanceDocument } from './schemas/salary-advance.schema';
import { SalaryPayment, SalaryPaymentDocument } from './schemas/salary-payment.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Payment, PaymentDocument } from '../finance/schemas/payment.schema';
import { CreatePayrollDto } from './dto/payroll.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { getTenantContext } from '../common/tenant/tenant-context';
import { startOfDayInTz, endOfDayInTz } from '../common/time/tz-day.util';

export interface PayrollPreview {
  baseSalary: number;
  commissionTotal: number;
  openAdvances: { id: string; amount: number; reason?: string; createdAt: Date }[];
  // Volontairement NON clampée à 0 (contrairement à netPaid persisté, P15) : la mobile UI
  // (Prompt 6) a besoin du signe réel pour désactiver le CTA "Payer" et afficher le message.
  suggestedNet: number;
}

/** E11000 — même forme de test que `booking.service.ts`/`caisse.service.ts`/`auth.service.ts`. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    @InjectModel(SalaryAdvance.name) private readonly advanceModel: Model<SalaryAdvanceDocument>,
    @InjectModel(SalaryPayment.name) private readonly salaryPaymentModel: Model<SalaryPaymentDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `staffs` est TENANT_SCOPED — le plugin filtre déjà cette lecture sur `ctx.tenantId`.
   * Sans cette garde, un owner du salon B pourrait déclencher un `preview`/`pay` avec le
   * `staffId` d'un staff du salon A : rien ne fuiterait (chaque modèle reste scopé), mais un
   * payslip fantôme (baseSalary=0, commission=0) serait créé sous le mauvais salon plutôt que
   * refusé — 404 explicite au lieu de laisser filer un enregistrement dénué de sens.
   */
  private async assertStaffInTenant(staffId: string, session?: ClientSession | null): Promise<void> {
    const staff = await this.staffModel.findOne({ _id: staffId }).session(session ?? null);
    if (!staff) throw new NotFoundException('Staff not found in this salon.');
  }

  /** Bornes Africa/Tunis (P10) d'un mois calendaire `year`-`month` (1..12). */
  private monthRange(year: number, month: number): { start: Date; end: Date } {
    const mm = String(month).padStart(2, '0');
    const startDate = `${year}-${mm}-01`;
    // Truc calendaire pur (aucune conversion TZ ici) : Date.UTC prend un mois 0-indexé, donc
    // passer `month` (1-indexé) tel quel désigne déjà "le mois suivant" — jour 0 = dernier
    // jour de `month`. Juste de l'arithmétique de calendrier, pas un Instant.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
    return { start: startOfDayInTz(startDate), end: endOfDayInTz(endDate) };
  }

  /**
   * Commission d'un staff sur la période (P4/décision P0) : somme `Payment.commission` +
   * `Payment.productCommission`, PAS un recalcul depuis `Sale` (aucune fonction réutilisable
   * de ce type n'existe réellement — cf. audit Prompt 0). `locationId: { $in: ctx.locationIds }`
   * explicite : Payment est LOCATION_SCOPED, le plugin n'injecterait que la location ACTIVE du
   * token sinon — la paie doit couvrir tout le salon (TENANT_SCOPED, décision P0), donc toutes
   * les locations auxquelles l'appelant a accès. Pour un owner, `ctx.locationIds` = TOUTES les
   * locations du salon (`TenantContextMiddleware`), jamais un sous-ensemble.
   */
  private async commissionForPeriod(staffId: string, start: Date, end: Date, session?: ClientSession | null): Promise<number> {
    const ctx = getTenantContext();
    const result = await this.paymentModel
      .aggregate([
        {
          $match: {
            locationId: { $in: ctx.locationIds },
            stylistId: new Types.ObjectId(staffId),
            date: { $gte: start, $lte: end },
            refunded: false,
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $add: ['$commission', { $ifNull: ['$productCommission', 0] }] } },
          },
        },
      ])
      .session(session ?? null);
    // Invariant 3-décimales (P9) — même arrondi que `productCommission` ailleurs dans finance.
    return Math.round((result[0]?.total ?? 0) * 1000) / 1000;
  }

  /** `StaffProfile.userId` est un `Types.ObjectId` (ref `Staff`) — cast explicite requis
   *  (même convention que partout ailleurs dans le codebase, ex. `finance.service.ts`) ;
   *  un `findOne` sur un champ ObjectId avec une string brute ne matche rien ici. */
  private async profileForStaff(staffId: string, session?: ClientSession | null): Promise<StaffProfileDocument | null> {
    return this.profileModel.findOne({ userId: new Types.ObjectId(staffId) }).session(session ?? null);
  }

  async preview(query: { staffId: string; year: number; month: number }): Promise<PayrollPreview> {
    await this.assertStaffInTenant(query.staffId);
    const { start, end } = this.monthRange(query.year, query.month);
    const profile = await this.profileForStaff(query.staffId);
    const baseSalary = profile?.baseSalary ?? 0;
    const commissionTotal = await this.commissionForPeriod(query.staffId, start, end);
    const openAdvances = await this.advanceModel
      .find({ status: 'approved', staffId: query.staffId, createdAt: { $lte: end } })
      .sort({ createdAt: 1 })
      .lean();
    const openAdvancesTotal = openAdvances.reduce((sum, a) => sum + a.amount, 0);
    return {
      baseSalary,
      commissionTotal,
      openAdvances: openAdvances.map((a) => ({
        id: a._id.toString(),
        amount: a.amount,
        reason: a.reason,
        createdAt: (a as unknown as { createdAt: Date }).createdAt,
      })),
      suggestedNet: baseSalary + commissionTotal - openAdvancesTotal,
    };
  }

  /** P7 : une seule transaction Mongo. Pattern copié de `finance.service.ts` `createPayment()`. */
  async pay(user: AuthUser, dto: CreatePayrollDto): Promise<SalaryPaymentDocument> {
    const session = await this.connection.startSession();
    try {
      let created: SalaryPaymentDocument | null = null;
      await session.withTransaction(async () => {
        created = await this.payInSession(session, user, dto);
      });
      await this.emitSalaryPaid(created!);
      return created!;
    } catch (err) {
      // Rejet métier (période déjà payée, avance invalide, net négatif...) : jamais retenté
      // en fallback non-atomique, jamais un 500 nu (P0 §9) — remonte tel quel.
      if (err instanceof HttpException) throw err;
      if (isDuplicateKeyError(err)) {
        throw new ConflictException('A payslip already exists for this staff member and period.');
      }
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions unsupported — payroll payout non-atomique (Mongo standalone).');
        const created = await this.payInSession(null, user, dto);
        await this.emitSalaryPaid(created);
        return created;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private async payInSession(session: ClientSession | null, user: AuthUser, dto: CreatePayrollDto): Promise<SalaryPaymentDocument> {
    // 0. Le staff ciblé doit appartenir à CE salon (voir docstring d'assertStaffInTenant).
    await this.assertStaffInTenant(dto.staffId, session);

    // 1. Doublon période — vérif applicative en amont ; l'index unique reste le filet de
    //    sécurité final contre une course concurrente (catché comme E11000 par l'appelant).
    const existing = await this.salaryPaymentModel
      .findOne({ staffId: dto.staffId, 'period.year': dto.year, 'period.month': dto.month })
      .session(session ?? null);
    if (existing) throw new ConflictException('A payslip already exists for this staff member and period.');

    // 2. Jamais confiance au client (P7) : base + commission recalculés serveur.
    const { start, end } = this.monthRange(dto.year, dto.month);
    const profile = await this.profileForStaff(dto.staffId, session);
    const baseSalary = profile?.baseSalary ?? 0;
    const commissionTotal = await this.commissionForPeriod(dto.staffId, start, end, session);

    // 3. Avances sélectionnées : approved, appartenant à ce staff, jamais déjà settled.
    const settleIds = dto.settleAdvanceIds ?? [];
    let advancesDeducted: { advanceId: string; amount: number }[] = [];
    let advancesTotal = 0;
    if (settleIds.length > 0) {
      const advances = await this.advanceModel.find({ _id: { $in: settleIds } }).session(session ?? null);
      if (advances.length !== settleIds.length) {
        throw new BadRequestException('One or more selected advances were not found.');
      }
      for (const adv of advances) {
        if (adv.staffId !== dto.staffId) {
          throw new BadRequestException(`Advance ${adv._id.toString()} does not belong to this staff member.`);
        }
        if (adv.status !== 'approved') {
          throw new BadRequestException(`Advance ${adv._id.toString()} is not approved (status: ${adv.status}).`);
        }
      }
      advancesDeducted = advances.map((a) => ({ advanceId: a._id.toString(), amount: a.amount }));
      advancesTotal = advances.reduce((sum, a) => sum + a.amount, 0);
    }

    // 4. Jamais de net négatif persisté (P15).
    const bonus = dto.bonus ?? 0;
    const deductions = dto.deductions ?? 0;
    const netPaid = baseSalary + commissionTotal + bonus - advancesTotal - deductions;
    if (netPaid < 0) {
      throw new BadRequestException('Advances exceed what is due for this period — uncheck some advances before paying.');
    }

    // 5. Créer la fiche de paie (snapshots figés, P5).
    const payload: Record<string, unknown> = {
      staffId: dto.staffId,
      period: { year: dto.year, month: dto.month },
      baseSalary,
      commissionTotal,
      advancesDeducted,
      bonus,
      deductions,
      netPaid,
      method: 'cash' as const,
      note: dto.note ?? '',
      paidBy: user.sub,
      paidAt: new Date(),
    };
    const createdRaw = (await this.salaryPaymentModel.create(session ? [payload] : payload, session ? { session } : {})) as
      | SalaryPaymentDocument
      | SalaryPaymentDocument[];
    const created = Array.isArray(createdRaw) ? createdRaw[0] : createdRaw;

    // 6. Settle les avances absorbées (P6) — jamais avant l'étape 5, jamais hors transaction.
    if (advancesDeducted.length > 0) {
      await this.advanceModel.updateMany(
        { _id: { $in: advancesDeducted.map((a) => a.advanceId) } },
        { $set: { status: 'settled', settledInPayrollId: created._id.toString() } },
        session ? { session } : {},
      );
    }

    return created;
  }

  private async emitSalaryPaid(payment: SalaryPaymentDocument): Promise<void> {
    const salonId = getTenantContext().tenantId;
    const payload = {
      salaryPaymentId: payment._id.toString(),
      staffId: payment.staffId,
      period: payment.period,
      netPaid: payment.netPaid,
    };
    // Persist-then-emit (P12), hors transaction (après commit) — staff concerné + owner.
    void this.notifications.dispatch({ salonId, staffId: payment.staffId, type: SOCKET_EVENTS.SALARY_PAID, payload });
    void this.notifications.dispatch({ salonId, role: 'owner', type: SOCKET_EVENTS.SALARY_PAID, payload });
  }

  /** Owner only — agrégat par staff pour un mois (masse salariale dérivée côté appelant). */
  /**
   * `year`+`month` ensemble → overview salon du mois (Prompt 7 mobile), tri par netPaid.
   * `staffId` seul (sans période) → historique complet d'un staff, toutes périodes
   * (Prompt 6 mobile, StaffPayrollTab "Historique"), tri chronologique décroissant.
   */
  async listForOwner(query: { year?: number; month?: number; staffId?: string }): Promise<SalaryPaymentDocument[]> {
    if (query.staffId) {
      return this.salaryPaymentModel
        .find({ staffId: query.staffId })
        .sort({ 'period.year': -1, 'period.month': -1 })
        .exec();
    }
    return this.salaryPaymentModel
      .find({ 'period.year': query.year, 'period.month': query.month })
      .sort({ netPaid: -1 })
      .exec();
  }

  /** #9 — le staff ne voit strictement que ses propres fiches de paie, toutes périodes. */
  async listForStaff(user: AuthUser): Promise<SalaryPaymentDocument[]> {
    if (!user.staffId) return [];
    return this.salaryPaymentModel
      .find({ staffId: user.staffId })
      .sort({ 'period.year': -1, 'period.month': -1 })
      .exec();
  }

  private isTxnUnsupported(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Transaction numbers are only allowed on a replica set|Transactions are not supported|replica set/i.test(msg);
  }
}
