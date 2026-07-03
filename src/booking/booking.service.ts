import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Appointment, AppointmentDocument } from './schemas/appointment.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import {
  AvailabilityQueryDto,
  AvailabilityTimelineQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  CreateWalkinDto,
} from './dto/booking.dto';
import { SalonScope } from '../common/scope/salon-scope';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { signAppointment, verifyAppointmentToken } from './signed-link.util';
import { SOCKET_EVENTS } from '../common/socket-events';
import { NotificationsService } from '../notifications/notifications.service';
import {
  addDaysIso,
  computeSlots,
  dateAtMin,
  effectiveWindow,
  Interval,
  minToHhmm,
  todayIso,
  weekdayName,
} from './availability.util';

const ACTIVE_STATUSES = ['booked', 'confirmed'];
const MS_PER_MIN = 60_000;
const DEFAULT_TIMELINE_DAYS = 7;

export interface SlotOption {
  time: string; // "HH:mm"
  start: string; // ISO
}
export interface StylistAvailability {
  stylistId: string;
  stylistName: string;
  level?: string;
  slots: SlotOption[];
}
export interface TimelineDay {
  date: string; // "YYYY-MM-DD"
  dayOfWeek: string;
  isClosed: boolean; // aucun stylist n'a de fenêtre de travail ce jour-là
  stylists: StylistAvailability[];
}

interface ResolveClientInput {
  clientId?: string;
  clientName?: string;
  clientPhone?: string;
  clientEmail?: string;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Schedule.name) private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Services helper ──────────────────────────────────────────────────────

  private async loadServices(scope: SalonScope, ids: string[]): Promise<ServiceDocument[]> {
    const services = await this.serviceModel.find({
      _id: { $in: ids },
      salonId: scope.salonId,
      active: true,
    });
    if (services.length !== ids.length) {
      throw new BadRequestException('One or more services are invalid or inactive.');
    }
    // Conserve l'ordre demandé (services chaînés contigus — #3).
    return ids.map((id) => services.find((s) => s._id.toString() === id)!);
  }

  /** Besoin total = somme(durationMin + bufferMin) ; prix = somme des prix (#2, #3). */
  private totals(services: ServiceDocument[]): { need: number; price: number } {
    return services.reduce(
      (acc, s) => ({ need: acc.need + s.durationMin + s.bufferMin, price: acc.price + s.price }),
      { need: 0, price: 0 },
    );
  }

  /**
   * Capacité (#2 du SKILL booking) : un stylist peut exécuter un service si son StaffProfile
   * liste le serviceId OU le gender du service ('men'|'women'|'universal'). Un service
   * 'universal' est exécutable par tous. Sans profil (ou capabilities vides) → universel
   * (rétro-compat avec d'anciennes données). Il doit pouvoir faire TOUS les services demandés.
   */
  private canPerform(profile: StaffProfileDocument | undefined, service: ServiceDocument): boolean {
    if (service.gender === 'universal') return true;
    if (!profile || !profile.capabilities || profile.capabilities.length === 0) return true;
    const caps = profile.capabilities;
    return caps.includes(service._id.toString()) || caps.includes(service.gender);
  }

  /** Catalogue public (storefront Book a Visit) : services actifs, filtrables par genre. */
  async catalog(scope: SalonScope, gender?: string): Promise<ServiceDocument[]> {
    const filter: FilterQuery<ServiceDocument> = { salonId: scope.salonId, active: true };
    if (gender) filter.gender = gender;
    return this.serviceModel.find(filter).sort({ category: 1, name: 1 });
  }

  // ─── Availability (recalculée à chaque requête — Décision #1) ───────────────

  /** Charge la liste de stylists scopée + leurs StaffProfile/Schedule, pour un ou plusieurs jours. */
  private async loadStylistContext(
    scope: SalonScope,
    stylistId?: string,
  ): Promise<{
    stylists: StaffDocument[];
    profileByUser: Map<string, StaffProfileDocument>;
    scheduleByStylist: Map<string, ScheduleDocument>;
  }> {
    const stylistFilter: FilterQuery<StaffDocument> = {
      salonId: scope.salonId,
      role: { $in: ['stylist', 'colorist'] },
      isActive: true,
      // $ne (not === true): pre-existing Staff docs stored before this field existed have no
      // value at all for it — Mongoose's schema default only applies to new/hydrated docs, not
      // to raw query matching, so `acceptingBookings: true` would silently exclude them all.
      acceptingBookings: { $ne: false },
    };
    if (stylistId) stylistFilter._id = stylistId;
    const stylists = await this.staffModel.find(stylistFilter).sort({ name: 1 });

    const profiles = await this.profileModel.find({ salonId: scope.salonId });
    const profileByUser = new Map(profiles.map((p) => [p.userId.toString(), p]));

    const schedules = await this.scheduleModel.find({
      salonId: scope.salonId,
      stylistId: { $in: stylists.map((s) => s._id) },
    });
    const scheduleByStylist = new Map(schedules.map((s) => [s.stylistId.toString(), s]));

    return { stylists, profileByUser, scheduleByStylist };
  }

  /**
   * Disponibilité d'un jour donné, pour la liste de stylists/profils/schedules déjà chargés.
   * `anyWindow` = au moins un stylist (de la liste, indépendamment de sa capability pour ce
   * service) a une fenêtre de travail ce jour-là — sert à détecter un jour fermé (#timeline).
   */
  private async dayAvailability(
    scope: SalonScope,
    date: string,
    services: ServiceDocument[],
    need: number,
    stylists: StaffDocument[],
    profileByUser: Map<string, StaffProfileDocument>,
    scheduleByStylist: Map<string, ScheduleDocument>,
  ): Promise<{ stylists: StylistAvailability[]; anyWindow: boolean }> {
    const dayStart = dateAtMin(date, 0);
    const dayEnd = dateAtMin(date, 24 * 60);

    let anyWindow = false;
    const out: StylistAvailability[] = [];
    for (const stylist of stylists) {
      const schedule = scheduleByStylist.get(stylist._id.toString());
      // Staff.week is the primary store (cf. ScheduleService) — Schedule.weekly is only a
      // synced copy written by setWeekly(). Staff created without going through that editor
      // (seed, direct writes) never get a Schedule doc, which would otherwise make every day
      // look closed. Fall back to Staff.week so availability doesn't silently die in that case.
      const weekly = schedule?.weekly?.length ? schedule.weekly : stylist.week;
      if (!weekly?.length) continue;
      const window = effectiveWindow(weekly, schedule?.overrides ?? [], date);
      if (!window) continue;
      anyWindow = true;

      const profile = profileByUser.get(stylist._id.toString());
      // Filtre capability (#2) : ne garder que les stylists capables de TOUS les services.
      const capable = services.every((s) => this.canPerform(profile, s));
      if (!capable) continue;

      const appts = await this.apptModel.find({
        salonId: scope.salonId,
        stylistId: stylist._id,
        status: { $in: ACTIVE_STATUSES },
        start: { $lt: dayEnd },
        end: { $gt: dayStart },
      });
      const busy: Interval[] = appts.map((a) => ({
        start: Math.round((a.start.getTime() - dayStart.getTime()) / MS_PER_MIN),
        end: Math.round((a.end.getTime() - dayStart.getTime()) / MS_PER_MIN),
      }));

      const slots = computeSlots(window, need, busy).map((min) => ({
        time: minToHhmm(min),
        start: dateAtMin(date, min).toISOString(),
      }));
      out.push({
        stylistId: stylist._id.toString(),
        stylistName: stylist.name,
        level: profile?.level,
        slots,
      });
    }
    return { stylists: out, anyWindow };
  }

  async availability(scope: SalonScope, dto: AvailabilityQueryDto): Promise<StylistAvailability[]> {
    const ids = dto.serviceIds && dto.serviceIds.length ? dto.serviceIds : dto.serviceId ? [dto.serviceId] : [];
    if (ids.length === 0) throw new BadRequestException('Provide serviceId or serviceIds.');
    const services = await this.loadServices(scope, ids);
    const { need } = this.totals(services);

    const { stylists, profileByUser, scheduleByStylist } = await this.loadStylistContext(scope, dto.stylistId);
    const { stylists: result } = await this.dayAvailability(
      scope,
      dto.date,
      services,
      need,
      stylists,
      profileByUser,
      scheduleByStylist,
    );
    return result;
  }

  /**
   * Timeline multi-jours (SKILL booking_timeline_stylist_selector) : recalculée live jour
   * par jour, en réutilisant le même moteur que `availability()` (#1). `isClosed` = aucun
   * stylist n'a de fenêtre de travail ce jour-là (jour de fermeture salon/équipe).
   */
  async availabilityTimeline(scope: SalonScope, dto: AvailabilityTimelineQueryDto): Promise<TimelineDay[]> {
    const ids = dto.serviceIds && dto.serviceIds.length ? dto.serviceIds : dto.serviceId ? [dto.serviceId] : [];
    if (ids.length === 0) throw new BadRequestException('Provide serviceId or serviceIds.');
    const services = await this.loadServices(scope, ids);
    const { need } = this.totals(services);

    const { stylists, profileByUser, scheduleByStylist } = await this.loadStylistContext(scope, dto.stylistId);
    // A specific stylistId that doesn't currently qualify (barber-first path) isn't a client
    // error — it's a clean "no availability", same as any other closed day. Only a genuinely
    // staff-less salon (no stylistId filter) is worth surfacing as a hard error.
    if (stylists.length === 0 && !dto.stylistId) {
      throw new BadRequestException('No stylists available in this salon.');
    }

    const startDate = dto.startDate ?? todayIso();
    const days = dto.days ?? DEFAULT_TIMELINE_DAYS;

    const out: TimelineDay[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDaysIso(startDate, i);
      const { stylists: dayStylists, anyWindow } = await this.dayAvailability(
        scope,
        date,
        services,
        need,
        stylists,
        profileByUser,
        scheduleByStylist,
      );
      out.push({ date, dayOfWeek: weekdayName(date), isClosed: !anyWindow, stylists: dayStylists });
    }
    return out;
  }

  // ─── Client resolution (merge-on-phone #10, email mandatoire #11) ───────────

  private async resolveClient(scope: SalonScope, input: ResolveClientInput, requireEmail: boolean): Promise<Types.ObjectId> {
    if (input.clientId) {
      const c = await this.clientModel.findOne({ _id: input.clientId, salonId: scope.salonId });
      if (!c) throw new BadRequestException('Client not found.');
      return c._id as Types.ObjectId;
    }
    if (!input.clientName || !input.clientPhone) {
      throw new BadRequestException('Provide clientId, or clientName + clientPhone.');
    }
    if (requireEmail && !input.clientEmail) {
      throw new BadRequestException('Email is required for an online booking.');
    }
    // merge-on-phone (#10) : un seul Client par phone dans le salon.
    const existing = await this.clientModel.findOne({ salonId: scope.salonId, phone: input.clientPhone });
    if (existing) {
      if (input.clientEmail && !existing.email) {
        existing.email = input.clientEmail;
        await existing.save();
      }
      return existing._id as Types.ObjectId;
    }
    const created = await this.clientModel.create({
      salonId: scope.salonId,
      name: input.clientName,
      phone: input.clientPhone,
      email: input.clientEmail ?? '',
      commsConsent: true,
      preferredChannel: 'email',
      registered: false,
      notes: '',
      history: [],
    });
    return created._id as Types.ObjectId;
  }

  private async assertStylist(scope: SalonScope, stylistId: string): Promise<StaffDocument> {
    const stylist = await this.staffModel.findOne({
      _id: stylistId,
      salonId: scope.salonId,
      role: { $in: ['stylist', 'colorist'] },
      isActive: true,
    });
    if (!stylist) throw new BadRequestException('Stylist not found.');
    return stylist;
  }

  // ─── Booking write (lock transactionnel — convention #6) ────────────────────

  async createAppointment(
    scope: SalonScope,
    dto: CreateAppointmentDto,
    user?: AuthUser,
  ): Promise<Record<string, unknown>> {
    const source = dto.source ?? 'online';
    // 'phone' réservé au staff ; le public ne peut booker qu'en 'online'.
    const isStaff = !!user && ['owner', 'manager', 'stylist', 'colorist'].includes(user.role);
    if (source === 'phone' && !isStaff) {
      throw new ForbiddenException('Phone bookings are staff-only.');
    }

    const services = await this.loadServices(scope, dto.serviceIds);
    const { need, price } = this.totals(services);

    const start = new Date(dto.start);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start datetime.');
    const end = new Date(start.getTime() + need * MS_PER_MIN);

    const stylist = await this.assertStylist(scope, dto.stylistId);
    const clientId = await this.resolveClient(scope, dto, source === 'online');
    const groupId = randomUUID();
    const serviceIds = services.map((s) => s._id as Types.ObjectId);

    const insertDoc = {
      salonId: scope.salonId,
      stylistId: stylist._id,
      clientId,
      groupId,
      services: serviceIds,
      start,
      end,
      status: 'booked' as const,
      source,
      price,
    };

    const conflictFilter = (): FilterQuery<AppointmentDocument> => ({
      salonId: scope.salonId,
      stylistId: stylist._id,
      status: { $in: ACTIVE_STATUSES },
      start: { $lt: end },
      end: { $gt: start },
    });

    const appt = await this.insertWithLock(conflictFilter, insertDoc);

    // Point d'appel notification BOOKING_CREATED (branché réellement au Sprint 8).
    if (source === 'online') {
      const client = await this.clientModel.findById(clientId).select('name').lean();
      void this.emitBookingCreated(appt, {
        clientName: client?.name ?? 'Client',
        serviceName: services.map((s) => s.name).join(', '),
      });
    }

    // Lien signé de suivi/annulation (#12) renvoyé au parcours public (BookSummary).
    const manageToken = signAppointment(appt._id.toString());
    return { ...appt.toObject(), manageToken };
  }

  /** Walk-in : source 'walkin', SANS check de dispo (peut chevaucher — décision design). */
  async createWalkin(scope: SalonScope, dto: CreateWalkinDto): Promise<AppointmentDocument> {
    const services = await this.loadServices(scope, dto.serviceIds);
    const { need, price } = this.totals(services);

    const start = dto.start ? new Date(dto.start) : new Date();
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start datetime.');
    const end = new Date(start.getTime() + need * MS_PER_MIN);

    const stylist = await this.assertStylist(scope, dto.stylistId);
    const clientId = await this.resolveClient(scope, dto, false);

    return this.apptModel.create({
      salonId: scope.salonId,
      stylistId: stylist._id,
      clientId,
      groupId: randomUUID(),
      services: services.map((s) => s._id as Types.ObjectId),
      start,
      end,
      status: 'booked',
      source: 'walkin',
      price,
    });
  }

  /**
   * Insert sous transaction MongoDB (check-and-insert). La lecture d'availability est
   * advisory ; ce re-check transactionnel est l'autorité qui tue la course au double-book
   * (convention #6). Repli gracieux en check+insert non transactionnel si la topologie ne
   * supporte pas les transactions (mongo standalone).
   */
  private async insertWithLock(
    conflictFilter: () => FilterQuery<AppointmentDocument>,
    insertDoc: Record<string, unknown>,
  ): Promise<AppointmentDocument> {
    const session = await this.connection.startSession();
    try {
      let created: AppointmentDocument | null = null;
      await session.withTransaction(async () => {
        const clash = await this.apptModel.findOne(conflictFilter()).session(session);
        if (clash) throw new ConflictException('This slot was just taken. Pick another time.');
        const docs = await this.apptModel.create([insertDoc], { session });
        created = docs[0];
      });
      return created!;
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (this.isTxnUnsupported(err)) {
        this.logger.warn('Transactions unsupported (standalone Mongo) — falling back to check+insert.');
        const clash = await this.apptModel.findOne(conflictFilter());
        if (clash) throw new ConflictException('This slot was just taken. Pick another time.');
        return this.apptModel.create(insertDoc);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private isTxnUnsupported(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Transaction numbers are only allowed on a replica set|Transactions are not supported|replica set/i.test(msg);
  }

  /**
   * Hook notification (#4 scoping) — préparé pour le Sprint 8. À l'insert d'un RDV online,
   * on émettra `BOOKING_CREATED` vers `user:{stylistId}` + badge Schedule owner/manager.
   * Ici : seul le POINT D'APPEL est posé (persist-then-emit réel au Sprint 8).
   */
  private emitBookingCreated(appt: AppointmentDocument, meta: { clientName: string; serviceName: string }): void {
    // Persist-then-emit (#7) + scoping (#4) : stylist concerné + owner salon-wide.
    const payload = { appointmentId: appt._id.toString(), start: appt.start, stylistId: appt.stylistId.toString(), groupId: appt.groupId };
    void this.notifications.dispatch({ salonId: appt.salonId, userId: appt.stylistId, type: SOCKET_EVENTS.APPOINTMENT_CREATED, payload });
    void this.notifications.dispatch({ salonId: appt.salonId, role: 'owner', type: SOCKET_EVENTS.APPOINTMENT_CREATED, payload });
    // Broadcast too (SKILL_fix_pos_board_notifications) — the POS kiosk isn't signed in as
    // any specific user/role that the two dispatches above would reach (bb_pos_token has
    // neither `sub` nor `role`), so it must join `salon:{id}` directly to see this at all.
    // Deduplicated by groupId (SKILL_fix_pos_board_notifs_FINAL) — one booking, one notif,
    // even if createAppointment is ever called more than once for the same groupId.
    // appt.start is stored UTC-labeled-as-Tunis (dateAtMin convention) — read UTC components
    // directly, no offset, to match the wall-clock time it actually represents.
    const hh = String(appt.start.getUTCHours()).padStart(2, '0');
    const mm = String(appt.start.getUTCMinutes()).padStart(2, '0');
    void this.notifications.dispatchOnce({
      salonId: appt.salonId,
      groupId: appt.groupId,
      type: SOCKET_EVENTS.APPOINTMENT_CREATED,
      title: 'New appointment',
      body: `${meta.clientName} — ${meta.serviceName} at ${hh}:${mm}`,
      payload,
    });
  }

  // ─── Read / cancel ──────────────────────────────────────────────────────────

  /**
   * Appointments for the currently logged-in client, CROSS-SALON (SKILL_client_appointments_dynamic
   * BK.1). A client identity (`Client.userId`) can hold one `Client` doc per salon they've ever
   * booked at — collect them all rather than scoping to a single salon.
   */
  async listMine(user: AuthUser, scope: 'upcoming' | 'history'): Promise<Record<string, unknown>[]> {
    const clientIds = await this.clientModel.find({ userId: user.sub }).distinct('_id');
    if (!clientIds.length) return [];

    const now = new Date();
    const filter: FilterQuery<AppointmentDocument> =
      scope === 'upcoming'
        ? { clientId: { $in: clientIds }, status: { $in: ACTIVE_STATUSES }, start: { $gte: now } }
        : {
            clientId: { $in: clientIds },
            $or: [
              { status: { $in: ['completed', 'cancelled', 'noshow'] } },
              { status: { $in: ACTIVE_STATUSES }, start: { $lt: now } },
            ],
          };

    const appts: any[] = await this.apptModel
      .find(filter)
      .sort({ start: scope === 'upcoming' ? 1 : -1 })
      .populate('services', 'name price')
      .populate('stylistId', 'name')
      .lean();

    // Join StaffProfile (publicTitle / seniorityTag) — clé réelle = staff._id (cf public.service.ts).
    const staffIds = appts.map((a) => a.stylistId?._id).filter(Boolean);
    const profiles = await this.profileModel
      .find({ userId: { $in: staffIds } })
      .select('userId publicTitle seniorityTag')
      .lean();
    const profileByStaffId = new Map(profiles.map((p) => [p.userId.toString(), p]));

    // Join Salon name (appointments peuvent venir de salons différents).
    const salonIds = [...new Set(appts.map((a) => a.salonId.toString()))].map((id) => new Types.ObjectId(id));
    const salons = await this.salonModel.find({ _id: { $in: salonIds } }).select('name').lean();
    const salonById = new Map(salons.map((s) => [s._id.toString(), s]));

    return appts.map((a) => {
      const staff = a.stylistId as { _id: Types.ObjectId; name: string } | null;
      const profile = staff ? profileByStaffId.get(staff._id.toString()) : undefined;
      return {
        id: a._id.toString(),
        salonId: a.salonId.toString(),
        salonName: salonById.get(a.salonId.toString())?.name ?? null,
        barber: {
          id: staff?._id?.toString() ?? null,
          name: staff?.name ?? 'Barber',
          title: profile?.publicTitle || null,
          isPro: profile?.seniorityTag === 'Master',
          initials: (staff?.name ?? 'B').split(' ').map((w: string) => w[0] ?? '').join('').slice(0, 2).toUpperCase(),
        },
        services: (a.services ?? []).map((s: any) => ({ id: s._id.toString(), name: s.name, price: s.price })),
        start: a.start,
        end: a.end,
        price: a.price,
        status: a.status as string,
      };
    });
  }

  async list(scope: SalonScope, date?: string, stylistId?: string): Promise<AppointmentDocument[]> {
    const filter: FilterQuery<AppointmentDocument> = { salonId: scope.salonId };
    if (stylistId) filter.stylistId = stylistId;
    if (date) {
      filter.start = { $lt: dateAtMin(date, 24 * 60) };
      filter.end = { $gt: dateAtMin(date, 0) };
    }
    return this.apptModel.find(filter).sort({ start: 1 }).exec();
  }

  /** Bloc chaîné (#3) — tous les RDV partageant un groupId. */
  async listGroup(scope: SalonScope, groupId: string): Promise<AppointmentDocument[]> {
    return this.apptModel.find({ salonId: scope.salonId, groupId }).sort({ start: 1 }).exec();
  }

  /** Détail d'un RDV — alimente le modal de détails (click depuis le planning ou une notification). */
  async getOne(scope: SalonScope, id: string): Promise<AppointmentDocument> {
    const appt = await this.apptModel.findOne({ _id: id, salonId: scope.salonId });
    if (!appt) throw new NotFoundException('Appointment not found.');
    return appt;
  }

  /**
   * Annulation : autorisée au staff (JWT, même salon), au client via lien signé (#12),
   * OU au client propriétaire via son propre JWT (SKILL_client_appointments_dynamic BK.2 —
   * salon dérivé de l'appointment, pas de getSalonScope : le client peut posséder des RDV
   * dans plusieurs salons).
   */
  async cancel(scope: SalonScope | null, id: string, opts: { user?: AuthUser; dto?: CancelAppointmentDto }): Promise<AppointmentDocument> {
    const appt = await this.apptModel.findOne({ _id: id });
    if (!appt) throw new NotFoundException('Appointment not found.');

    const isStaff =
      !!opts.user &&
      ['owner', 'manager', 'stylist', 'colorist'].includes(opts.user.role) &&
      !!scope &&
      appt.salonId.toString() === scope.salonId; // isolation multi-tenant : même salon requis
    const tokenOk = !!opts.dto?.token && verifyAppointmentToken(id, opts.dto.token);

    let isOwnerClient = false;
    if (!isStaff && !tokenOk && opts.user?.role === 'client') {
      const ownClientIds = await this.clientModel.find({ userId: opts.user.sub }).distinct('_id');
      isOwnerClient = ownClientIds.some((cid) => cid.toString() === appt.clientId.toString());
    }

    if (!isStaff && !tokenOk && !isOwnerClient) {
      throw new ForbiddenException('Not allowed to cancel this appointment.');
    }
    if (!ACTIVE_STATUSES.includes(appt.status)) {
      throw new BadRequestException('Appointment already completed or cancelled.');
    }
    // Un client ne peut annuler qu'un RDV à venir (pas de "cancel" rétroactif sur son propre historique).
    if (isOwnerClient && !isStaff && !tokenOk && appt.start < new Date()) {
      throw new BadRequestException('This appointment is in the past.');
    }

    appt.status = 'cancelled';
    await appt.save();
    void this.notifications.dispatch({
      salonId: appt.salonId,
      userId: appt.stylistId,
      type: SOCKET_EVENTS.APPOINTMENT_CANCELLED,
      payload: { appointmentId: appt._id.toString() },
    });
    return appt;
  }
}
