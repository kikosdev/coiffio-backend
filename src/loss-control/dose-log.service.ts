import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { DoseLog, DoseLogDocument } from './schemas/dose-log.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { DeclareDoseLineDto } from './dto/dose-log.dto';
import { getTenantContext } from '../common/tenant/tenant-context';
import { LossAlertService } from './loss-alert.service';

interface ExpectedLine {
  serviceId: string;
  doses: number;
}

export interface DoseLogList {
  locked: boolean;
  expected: { productId: string; serviceId: string; doses: number }[];
  declared: DoseLogDocument[];
}

@Injectable()
export class DoseLogService {
  constructor(
    @InjectModel(DoseLog.name) private readonly doseLogModel: Model<DoseLogDocument>,
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    private readonly lossAlertService: LossAlertService,
  ) {}

  /**
   * LC-6/LC-10 (Prompt 5) : Calc 1 (staff) + Calc 3 (extrême) évalués APRÈS écriture durable
   * des `DoseLog` — jamais depuis l'intérieur d'une transaction en cours (`declareInSession()`,
   * Prompt 3-bis) : `LossControlAnalyticsService` relit sans session, un check lancé avant
   * commit verrait un état pré-écriture. Appelée par `declare()` (immédiat, pas de txn) et par
   * `FinanceService.createWalkinSale()` (après que sa transaction ait commité).
   */
  async runAlertChecks(logs: DoseLogDocument[]): Promise<void> {
    const stylistIds = new Set(logs.map((l) => l.stylistId));
    await Promise.all([
      ...logs.map((l) => this.lossAlertService.checkExtremeUsage(l)),
      ...[...stylistIds].map((sid) => this.lossAlertService.checkStaffHonesty(sid)),
    ]);
  }

  /**
   * Théorique attendu par produit pour CET appointment — somme des `doseConfig` de tous ses
   * services. Si deux services de ce RDV référencent le même produit, `serviceId` retient le
   * PREMIER (ordre de `appointment.services[]`) : simplification documentée, un DoseLog porte
   * un `serviceId` singulier (schéma du skill) — cas rare (même produit consommé par 2
   * prestations du même RDV), à revisiter au calcul d'écart (Prompt 4) si ça s'avère fréquent.
   */
  private async resolveExpected(appt: AppointmentDocument, session?: ClientSession): Promise<Map<string, ExpectedLine>> {
    const docs = await this.serviceModel
      .find({ _id: { $in: appt.services } })
      .select('name doseConfig')
      .session(session ?? null)
      .lean();

    const expected = new Map<string, ExpectedLine>();
    for (const svc of docs) {
      for (const entry of svc.doseConfig ?? []) {
        const existing = expected.get(entry.productId);
        if (existing) {
          existing.doses += entry.doses;
        } else {
          expected.set(entry.productId, { serviceId: svc._id.toString(), doses: entry.doses });
        }
      }
    }
    return expected;
  }

  /**
   * Cœur de la déclaration — factorisé pour être appelé SOUS une transaction déjà ouverte
   * (Prompt 3-bis, `FinanceService.createWalkinSale()` : doses inline dans le ticket walk-in,
   * créées entre `createWalkin()` et `createPaymentInSession()` dans la MÊME transaction) ET
   * depuis `declare()` (chemin POS standalone, RDV déjà existant). Ni lookup d'appointment ni
   * check de verrouillage ici — la responsabilité de l'appelant (un walk-in tout juste créé
   * est TOUJOURS 'booked', jamais besoin du check ; `declare()` le fait avant d'appeler ceci).
   */
  private async declareForAppointment(
    appt: AppointmentDocument,
    stylistId: string,
    lines: DeclareDoseLineDto[],
    session?: ClientSession,
  ): Promise<DoseLogDocument[]> {
    const expected = await this.resolveExpected(appt, session);
    const now = new Date();
    const results: DoseLogDocument[] = [];

    for (const line of lines) {
      const exp = expected.get(line.productId);
      if (!exp || exp.doses <= 0) {
        throw new BadRequestException(`Produit non attendu pour ce rendez-vous : ${line.productId}.`);
      }
      const variancePct = ((line.dosesDeclared - exp.doses) / exp.doses) * 100;
      const appointmentId = (appt._id as { toString(): string }).toString();
      const doc = await this.doseLogModel.findOneAndUpdate(
        { appointmentId, productId: line.productId },
        {
          $set: {
            stylistId,
            serviceId: exp.serviceId,
            dosesDeclared: line.dosesDeclared,
            dosesExpected: exp.doses,
            variancePct,
            declaredAt: now,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session: session ?? null },
      );
      results.push(doc!);
    }
    return results;
  }

  /** Point d'entrée POS public (session-less) — session-aware pour Prompt 3-bis via `declareInSession`. */
  async declare(appointmentId: string, stylistId: string, lines: DeclareDoseLineDto[]): Promise<DoseLogDocument[]> {
    const appt = await this.apptModel.findOne({ _id: appointmentId });
    if (!appt) throw new NotFoundException('Appointment not found.');
    // LC-4 : verrouillé dès la clôture — `markAppointmentCompleted()` est le seul chemin vers
    // 'completed' (confirmé Prompt 0-bis), donc ce check EST le verrou, pas une approximation.
    if (appt.status === 'completed') {
      throw new ConflictException('Ce rendez-vous est déjà clôturé — déclaration verrouillée.');
    }
    const results = await this.declareForAppointment(appt, stylistId, lines);
    // Attendu (pas fire-and-forget) : la preuve [6] (anti-spam) et l'isolation [7] dépendent
    // d'une alerte DÉJÀ persistée au retour de l'appel, pas d'un best-effort en arrière-plan.
    await this.runAlertChecks(results);
    return results;
  }

  /**
   * Prompt 3-bis (SKILL_loss_control_doses.md) : doses inline du ticket walk-in, appelée par
   * `FinanceService.createWalkinSale()` DANS sa transaction, juste après `createWalkin()`. Pas
   * de check de verrouillage — l'appointment vient d'être créé, toujours 'booked'.
   */
  async declareInSession(
    appt: AppointmentDocument,
    stylistId: string,
    lines: DeclareDoseLineDto[],
    session: ClientSession | null,
  ): Promise<DoseLogDocument[]> {
    return this.declareForAppointment(appt, stylistId, lines, session ?? undefined);
  }

  async list(appointmentId: string): Promise<DoseLogList> {
    const appt = await this.apptModel.findOne({ _id: appointmentId });
    if (!appt) throw new NotFoundException('Appointment not found.');

    const [expectedMap, declared] = await Promise.all([
      this.resolveExpected(appt),
      this.doseLogModel.find({ appointmentId }).sort({ declaredAt: -1 }),
    ]);

    return {
      locked: appt.status === 'completed',
      expected: [...expectedMap.entries()].map(([productId, v]) => ({ productId, serviceId: v.serviceId, doses: v.doses })),
      declared,
    };
  }

  /** Message actionnable partagé par `assertDeclaredIfRequired()` et `assertDeclaredForWalkin()`. */
  private buildUndeclaredMessage(dosableServices: { name: string; doseConfig?: { doses: number }[] }[]): string {
    const detail = dosableServices
      .map((s) => {
        const totalDoses = (s.doseConfig ?? []).reduce((sum, e) => sum + e.doses, 0);
        return `${s.name} : ${totalDoses} dose${totalDoses > 1 ? 's' : ''} attendue${totalDoses > 1 ? 's' : ''}`;
      })
      .join(', ');
    return `Déclarez les doses utilisées avant d'encaisser (${detail}).`;
  }

  /**
   * A4 (SKILL_loss_control_doses.md, Prompt 3, arbitrage validé) : bloque la clôture d'un RDV
   * SI ET SEULEMENT SI les 3 conditions sont réunies :
   *   1. `Salon.lossControl.alertsEnabled === true` (opt-in explicite owner)
   *   2. au moins un service du RDV a un `doseConfig` non vide
   *   3. aucun `DoseLog` n'existe pour ce RDV
   * Message ACTIONNABLE (nom du service + doses attendues) — un 409 opaque au comptoir ferait
   * désactiver le module. Appelée depuis `payAppointment()` (RDV planifié). Le walk-in
   * (`createWalkinSale()`, Prompt 3-bis) utilise `assertDeclaredForWalkin()` — le trou ouvert
   * au Prompt 3 (aucune fenêtre entre création et clôture d'un walk-in) est refermé par les
   * doses inline du ticket, pas par cette méthode.
   *
   * `session` optionnel : aligne le RDV planifié classique sur le pattern walk-in atomique
   * (1 appel, `FinanceService.payAppointmentWithDoses()`) — appelée APRÈS `declareInSession()`
   * DANS la même transaction encore non commitée, un `countDocuments` scopé à cette session
   * voit le DoseLog que `declareInSession()` vient d'y écrire (lecture causale intra-session
   * Mongo), sans qu'aucune condition de garde n'ait besoin de changer. Le flux 2-appels
   * standalone (`POST /doses` puis `POST /pay` sans `doses`) continue de fonctionner à
   * l'identique : `session` reste `undefined`, `countDocuments` lit alors l'état déjà commité.
   */
  async assertDeclaredIfRequired(appointmentId: string, session?: ClientSession | null): Promise<void> {
    const salon = await this.salonModel
      .findById(getTenantContext().tenantId)
      .select('lossControl')
      .session(session ?? null)
      .lean();
    if (!salon?.lossControl?.alertsEnabled) return; // condition 1

    const appt = await this.apptModel
      .findOne({ _id: appointmentId })
      .select('services')
      .session(session ?? null)
      .lean();
    if (!appt) return; // 404 laissé au chemin appelant, pas notre rôle ici

    const services = await this.serviceModel
      .find({ _id: { $in: appt.services } })
      .select('name doseConfig')
      .session(session ?? null)
      .lean();
    const dosableServices = services.filter((s) => (s.doseConfig ?? []).length > 0);
    if (dosableServices.length === 0) return; // condition 2

    const declaredCount = await this.doseLogModel.countDocuments({ appointmentId }).session(session ?? null);
    if (declaredCount > 0) return; // condition 3

    throw new ConflictException(this.buildUndeclaredMessage(dosableServices));
  }

  /**
   * Prompt 3-bis : variante walk-in de `assertDeclaredIfRequired()`, appelée AVANT la
   * transaction de `createWalkinSale()`. Même 3 conditions, mais condition 3 se lit sur le
   * DTO (`doses` non vide), PAS sur `DoseLog` en base — l'Appointment/les DoseLog n'existent
   * pas encore à cet instant, rien à compter.
   */
  async assertDeclaredForWalkin(serviceIds: string[], doses?: DeclareDoseLineDto[]): Promise<void> {
    const salon = await this.salonModel.findById(getTenantContext().tenantId).select('lossControl').lean();
    if (!salon?.lossControl?.alertsEnabled) return; // condition 1

    const services = await this.serviceModel
      .find({ _id: { $in: serviceIds } })
      .select('name doseConfig')
      .lean();
    const dosableServices = services.filter((s) => (s.doseConfig ?? []).length > 0);
    if (dosableServices.length === 0) return; // condition 2

    if (doses && doses.length > 0) return; // condition 3

    throw new ConflictException(this.buildUndeclaredMessage(dosableServices));
  }

  /** Owner-only, réservée aux déclarations déjà verrouillées (LC-4) — sinon la déclaration
   *  standard (`declare()`) reste le bon chemin tant que le RDV est ouvert. */
  async correct(id: string, correctedBy: string, dosesDeclared: number, correctionNote: string): Promise<DoseLogDocument> {
    const log = await this.doseLogModel.findOne({ _id: id });
    if (!log) throw new NotFoundException('Dose log not found.');
    if (!log.lockedAt) {
      throw new BadRequestException(
        'Correction réservée aux déclarations verrouillées — le RDV est encore ouvert, redéclarer normalement.',
      );
    }
    log.dosesDeclared = dosesDeclared;
    log.variancePct = log.dosesExpected > 0 ? ((dosesDeclared - log.dosesExpected) / log.dosesExpected) * 100 : 0;
    log.correctedBy = correctedBy;
    log.correctionNote = correctionNote;
    await log.save();
    return log;
  }
}
