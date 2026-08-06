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
import { randomInt, randomUUID } from 'crypto';
import { Appointment, AppointmentDocument } from './schemas/appointment.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { ClientProfileService } from '../identity/client-profile.service';
import { MembershipService } from '../identity/membership.service';
import { LocationService } from '../locations/location.service';
import {
  AvailabilityQueryDto,
  AvailabilityTimelineQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  CreateWalkinDto,
} from './dto/booking.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { getTenantContext, runWithTenant, tenantStorage, TenantContext } from '../common/tenant/tenant-context';
import { mapWithConcurrencyLimit } from '../common/utils/concurrency-limit.util';
import { normalizeIdentifier } from '../auth/identifier.util';
import { signAppointment, verifyAppointmentToken } from './signed-link.util';
import { SOCKET_EVENTS } from '../common/socket-events';
import { NotificationsService } from '../notifications/notifications.service';
import { EntitlementsService } from '../common/entitlements/entitlements.service';
import { startOfDayInTz, todayIsoInTz } from '../common/time/tz-day.util';
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
const MAX_CONCURRENT_TENANTS = 5;

/**
 * Contexte système synthétique pour des lectures internes BORNÉES qui ne doivent pas
 * dépendre du contexte ambiant — même principe que `systemReadContext` dans
 * `client-profile.service.ts` (Prompt 4). Deux usages :
 *   1. `resolveClient()` : le contexte ambiant peut être un contexte guest restreint par
 *      `GUEST_READABLE` (`clients` en est délibérément exclu, durcissement post-Sprint-1-v2
 *      Partie 1) — le dédup merge-on-phone a besoin d'une lecture `clients` bornée, jamais
 *      exposée à l'appelant, donc via ce contexte interne plutôt que le contexte guest.
 *   2. `listMine()`/`cancel()` (Partie 3) : boucle par tenant sur les salons connus du
 *      client (`ClientProfile.tenantIds`), qui ne sont PAS le tenant du contexte ambiant.
 * Jamais une vraie session — `role`/`plan` sont des placeholders.
 */
function systemReadContext(tenantId: string, locationId = '', locationIds: string[] = []): TenantContext {
  return { tenantId, locationId, locationIds, role: 'owner', plan: 'starter', features: {}, limits: {} };
}

/**
 * Durcissement post-Sprint-1-v2 Partie 2 (trou trouvé au Prompt 9) : `catalog()` exposait
 * le document `Service` complet — `salonId` (ObjectId interne) compris — sur une route
 * publique. Jamais `salonId`, jamais les champs de gestion interne (`bufferMin`,
 * `isFeatured`, `featuredOrder`, `isPublic`, `active` — toujours `true` ici, déjà filtré).
 * Élargi par rapport à `PUBLIC_DISCOVERY_FIELDS.services` (Prompt 5) de `gender` (filtre du
 * storefront lui-même) et `color` (affichage) — réellement consommés par ce parcours,
 * contrairement à la whitelist découverte qui n'en a pas besoin. `_id` reste implicite
 * (jamais exclu par Mongoose sauf `.select('-_id')` explicite) — nécessaire pour booker.
 */
const CATALOG_PUBLIC_FIELDS = 'name category gender price durationMin color';

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

export interface HydratedStaffAppointment {
  id: string;
  date: string;
  start: Date;
  end: Date;
  startTime: string;
  clientId: string;
  clientName: string;
  clientInitials: string;
  phone: string;
  services: { id: string; name: string; durationMin: number; priceTnd: number }[];
  durationMin: number;
  totalTnd: number;
  status: string;
  state: 'waiting' | 'in_chair' | 'done';
  note?: string;
  visitCount: number;
  checkInCode?: string | null;
}

export interface StaffScheduleWeek {
  weekDates: string[];
  dayWindows: Record<string, { start: string; end: string } | null>;
  slots: HydratedStaffAppointment[];
}

interface ResolveClientInput {
  clientId?: string;
  clientName?: string;
  clientPhone?: string;
  clientEmail?: string;
  userId?: string;
}

function initials(name: string): string {
  return name.split(' ').map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
}

function staffState(status: string): 'waiting' | 'in_chair' | 'done' {
  return status === 'completed' ? 'done' : 'waiting';
}

function normalizedPhone(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  return normalizeIdentifier(value).value;
}

function flexiblePhoneRegex(value: string): RegExp | undefined {
  const normalized = normalizedPhone(value);
  if (!normalized) return undefined;
  const digits = normalized.replace(/\D/g, '').replace(/^216/, '');
  if (!digits) return undefined;
  const sep = '[\\s\\-().]*';
  return new RegExp(`^(?:\\+?216|00216)?${sep}${digits.split('').join(sep)}$`);
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
    private readonly clientProfiles: ClientProfileService,
    private readonly locations: LocationService,
    private readonly entitlements: EntitlementsService,
    private readonly memberships: MembershipService,
  ) {}

  /**
   * Résout la location à filtrer pour la disponibilité (Prompt 6, Partie C) : le paramètre
   * explicite gagne ; sinon la location primaire du tenant ; si aucune primaire n'existe
   * encore (migration Prompt 1 pas encore passée en prod), on retourne `null` — pas de
   * filtrage plutôt qu'une disponibilité cassée pour tout le monde.
   */
  private async resolveLocationId(explicitLocationId?: string): Promise<string | null> {
    if (explicitLocationId) return explicitLocationId;
    try {
      // LocationService garde `scope: SalonScope` en paramètre (exception documentée,
      // requise par le bootstrap du middleware) — on le construit ici depuis le contexte.
      const primary = await this.locations.findPrimary({ salonId: getTenantContext().tenantId });
      return primary._id.toString();
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  // ─── Services helper ──────────────────────────────────────────────────────

  private async loadServices(ids: string[]): Promise<ServiceDocument[]> {
    const services = await this.serviceModel.find({
      _id: { $in: ids },
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

  /** Catalogue public (storefront Book a Visit) : services actifs, filtrables par genre,
   *  projeté sur les champs publics uniquement (voir `CATALOG_PUBLIC_FIELDS`). */
  async catalog(gender?: string): Promise<ServiceDocument[]> {
    const filter: FilterQuery<ServiceDocument> = { active: true };
    if (gender) filter.gender = gender;
    return this.serviceModel.find(filter).select(CATALOG_PUBLIC_FIELDS).sort({ category: 1, name: 1 });
  }

  // ─── Availability (recalculée à chaque requête — Décision #1) ───────────────

  /** Charge la liste de stylists scopée + leurs StaffProfile/Schedule, pour un ou plusieurs jours. */
  private async loadStylistContext(
    stylistId?: string,
    locationId?: string | null,
  ): Promise<{
    stylists: StaffDocument[];
    profileByUser: Map<string, StaffProfileDocument>;
    scheduleByStylist: Map<string, ScheduleDocument>;
  }> {
    const stylistFilter: FilterQuery<StaffDocument> = {
      role: { $in: ['stylist', 'colorist'] },
      isActive: true,
      // $ne (not === true): pre-existing Staff docs stored before this field existed have no
      // value at all for it — Mongoose's schema default only applies to new/hydrated docs, not
      // to raw query matching, so `acceptingBookings: true` would silently exclude them all.
      acceptingBookings: { $ne: false },
    };
    if (stylistId) stylistFilter._id = stylistId;
    if (locationId) {
      // Tolérant seulement pour les docs VRAIMENT jamais migrés : `locationIds` absent du
      // document ($exists:false) — écrits avant que ce champ n'existe (Prompt 6, Partie A,
      // Sprint 1), donc jamais passés par le défaut Mongoose `[]`. Depuis, tout document
      // créé/sauvé via le modèle reçoit `[]` EXPLICITEMENT si non renseigné (confirmé sur
      // `salonos` : les staffs jamais migrés ont `locationIds: undefined`, pas `[]`) — ce qui
      // rend les deux états distinguables. Sprint 2 v2 Prompt 3 : un `[]` EXPLICITE (staff
      // créé par `grant()`, ou locations retirées via `updateLocations([])`) veut dire
      // "délibérément aucune location" → 0 créneau, jamais "disponible partout".
      stylistFilter.$or = [{ locationIds: locationId }, { locationIds: { $exists: false } }];
    }
    // Projection défensive (durcissement post-Sprint-1-v2, même esprit que
    // CATALOG_PUBLIC_FIELDS) : `availability()`/`availabilityTimeline()` sont les 2 SEULS
    // appelants de cette méthode, tous deux guest-reachable. `pinHash`/`pinAttempts`/
    // `pinLockedUntil` ont déjà `select:false` au niveau du schéma (protection structurelle,
    // vérifiée), mais `StaffProfile.baseRate`/`commissionPct` (paie) n'en ont PAS — jusqu'ici
    // non exposés seulement parce que `dayAvailability()` ne les recopie jamais dans la
    // réponse (`StylistAvailability` ne construit que stylistId/stylistName/level/slots).
    // Projection ici = backstop structurel, pas la seule barrière — même principe que le
    // reste du plugin (discovery, catalog).
    const matched = await this.staffModel.find(stylistFilter).select('name week').sort({ name: 1 });

    // Sprint 2 v2 Prompt 3 : ne considérer que les staffs avec un Membership ACTIF sur ce
    // tenant. Tolérant comme le reste de cette méthode : si AUCUN Membership n'existe pour
    // ce staffId (tenant jamais migré — `migrate-create-memberships.ts` refuse `salonos`,
    // qui n'a donc aujourd'hui aucun Membership du tout), on garde le staff (comportement
    // inchangé) ; s'il EN EXISTE un mais avec un statut ≠ 'active' (révoqué, suspendu,
    // invité), on l'exclut — c'est ce qui donne un effet réel à `DELETE /team/:id/access`
    // sur la disponibilité publique (sans ce filtre, révoquer l'accès ne retirerait
    // personne du storefront).
    const tenantMemberships = await this.memberships.findByTenant(getTenantContext().tenantId);
    const membershipStatusByStaffId = new Map(
      tenantMemberships.filter((m) => m.kind === 'staff' && m.staffId).map((m) => [m.staffId!.toString(), m.status]),
    );
    const stylists = matched.filter((s) => {
      const status = membershipStatusByStaffId.get(s._id.toString());
      return status === undefined || status === 'active';
    });

    const profiles = await this.profileModel.find({}).select('userId capabilities level');
    const profileByUser = new Map(profiles.map((p) => [p.userId.toString(), p]));

    const schedules = await this.scheduleModel.find({
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

  async availability(dto: AvailabilityQueryDto): Promise<StylistAvailability[]> {
    const ids = dto.serviceIds && dto.serviceIds.length ? dto.serviceIds : dto.serviceId ? [dto.serviceId] : [];
    if (ids.length === 0) throw new BadRequestException('Provide serviceId or serviceIds.');
    const services = await this.loadServices(ids);
    const { need } = this.totals(services);

    const locationId = await this.resolveLocationId(dto.locationId);
    const { stylists, profileByUser, scheduleByStylist } = await this.loadStylistContext(
      dto.stylistId,
      locationId,
    );
    const { stylists: result } = await this.dayAvailability(
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
  async availabilityTimeline(dto: AvailabilityTimelineQueryDto): Promise<TimelineDay[]> {
    const ids = dto.serviceIds && dto.serviceIds.length ? dto.serviceIds : dto.serviceId ? [dto.serviceId] : [];
    if (ids.length === 0) throw new BadRequestException('Provide serviceId or serviceIds.');
    const services = await this.loadServices(ids);
    const { need } = this.totals(services);

    const locationId = await this.resolveLocationId(dto.locationId);
    const { stylists, profileByUser, scheduleByStylist } = await this.loadStylistContext(
      dto.stylistId,
      locationId,
    );
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

  // ─── Client resolution (merge-on-phone #10) ────────────────────────────────

  /**
   * Toujours exécutée sous `systemReadContext(tenantId)` (voir sa docstring) plutôt que le
   * contexte ambiant : appelée depuis `createAppointment()`/`createWalkin()`, qui tournent
   * eux-mêmes sous `runAsGuest` pour les RDV publics (booking en ligne ou même téléphone,
   * cf. `BookingController` — une seule route guest-scopée pour les deux) — et `clients` est
   * délibérément HORS `GUEST_READABLE` (durcissement post-Sprint-1-v2 Partie 1). Le dédup
   * merge-on-phone reste une lecture interne bornée, jamais exposée telle quelle à
   * l'appelant, donc légitime même si le contexte ambiant ne l'autoriserait pas.
   */
  private async resolveClient(input: ResolveClientInput): Promise<Types.ObjectId> {
    const tenantId = getTenantContext().tenantId;
    return runWithTenant(systemReadContext(tenantId), async () => {
      if (input.clientId) {
        const c = await this.clientModel.findOne({ _id: input.clientId }).exec();
        if (!c) throw new BadRequestException('Client not found.');
        if (input.userId && (!c.userId || c.userId.toString() === input.userId)) {
          c.userId = new Types.ObjectId(input.userId);
        }
        if (input.clientName?.trim()) {
          c.name = input.clientName.trim();
        }
        const phone = normalizedPhone(input.clientPhone);
        if (phone && c.phone !== phone) {
          const duplicate = await this.clientModel.findOne({ _id: { $ne: c._id }, phone }).exec();
          if (!duplicate) c.phone = phone;
        }
        if (input.clientEmail && !c.email) {
          c.email = input.clientEmail.toLowerCase();
        }
        await c.save();
        return c._id as Types.ObjectId;
      }
      if (!input.clientName || !input.clientPhone) {
        throw new BadRequestException('Provide clientId, or clientName + clientPhone.');
      }
      const phone = normalizedPhone(input.clientPhone);
      if (!phone) throw new BadRequestException('Provide a valid clientPhone.');
      // merge-on-phone (#10) : un seul Client par phone dans le salon.
      const existing = await this.clientModel.findOne({ phone }).exec();
      if (existing) {
        if (input.userId && (!existing.userId || existing.userId.toString() === input.userId)) {
          existing.userId = new Types.ObjectId(input.userId);
        }
        if (input.clientEmail && !existing.email) {
          existing.email = input.clientEmail;
        }
        await existing.save();
        return existing._id as Types.ObjectId;
      }
      const created = await this.clientModel.create({
        userId: input.userId ? new Types.ObjectId(input.userId) : null,
        name: input.clientName,
        phone,
        email: input.clientEmail ?? '',
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

  private async assertStylist(stylistId: string): Promise<StaffDocument> {
    const stylist = await this.staffModel.findOne({
      _id: stylistId,
      role: { $in: ['stylist', 'colorist'] },
      isActive: true,
    });
    if (!stylist) throw new BadRequestException('Stylist not found.');
    return stylist;
  }

  // ─── Booking write (lock transactionnel — convention #6) ────────────────────

  async createAppointment(
    dto: CreateAppointmentDto,
    user?: AuthUser,
  ): Promise<Record<string, unknown>> {
    const source = dto.source ?? 'online';
    // 'phone' réservé au staff ; le public ne peut booker qu'en 'online'.
    const isStaff = !!user && ['owner', 'manager', 'stylist', 'colorist'].includes(user.role);
    if (source === 'phone' && !isStaff) {
      throw new ForbiddenException('Phone bookings are staff-only.');
    }

    const services = await this.loadServices(dto.serviceIds);
    const { need, price } = this.totals(services);

    const start = new Date(dto.start);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start datetime.');
    const end = new Date(start.getTime() + need * MS_PER_MIN);
    const startDay = start.toISOString().slice(0, 10);

    const stylist = await this.assertStylist(dto.stylistId);
    const clientInput: ResolveClientInput =
      user?.role === 'client' && user.clientId && !dto.clientId
        ? { ...dto, clientId: user.clientId, userId: user.sub }
        : { ...dto, userId: user?.role === 'client' ? user.sub : undefined };
    const clientId = await this.resolveClient(clientInput);
    const groupId = randomUUID();
    const serviceIds = services.map((s) => s._id as Types.ObjectId);

    const insertDoc = {
      stylistId: stylist._id,
      clientId,
      groupId,
      services: serviceIds,
      start,
      startDay,
      end,
      status: 'booked' as const,
      source,
      price,
    };

    const conflictFilter = (): FilterQuery<AppointmentDocument> => ({
      stylistId: stylist._id,
      status: { $in: ACTIVE_STATUSES },
      start: { $lt: end },
      end: { $gt: start },
    });

    const appt = await this.insertWithLockAndCode(conflictFilter, insertDoc, startDay);

    // Point d'appel notification BOOKING_CREATED (branché réellement au Sprint 8).
    if (source === 'online') {
      // `clients` hors GUEST_READABLE (Partie 1) — même raison que `resolveClient()` :
      // lecture interne bornée (juste le nom, pour le corps de la notif), jamais exposée à
      // l'appelant, sous un contexte interne plutôt que le contexte guest ambiant.
      const client = await runWithTenant(systemReadContext(getTenantContext().tenantId), () =>
        this.clientModel.findById(clientId).select('name').lean().exec(),
      );
      void this.emitBookingCreated(appt, {
        clientName: client?.name ?? 'Client',
        serviceName: services.map((s) => s.name).join(', '),
      });
    }

    // Lien signé de suivi/annulation (#12) renvoyé au parcours public (BookSummary).
    const manageToken = signAppointment(appt._id.toString());
    void this.checkAppointmentsMonthSoftLimit();
    return { ...appt.toObject(), manageToken };
  }

  /**
   * Limite SOFT `appointmentsMonth` (Prompt 7) — ne bloque JAMAIS la création, appelée en
   * fire-and-forget après coup (même style que `emitBookingCreated`). Compte le mois
   * calendaire réel Africa/Tunis (pas UTC — cf. `tz-day.util.ts`, Groupe A). Notifie le
   * salon à 80%/100%, dédupliqué par mois via `dispatchOnce`.
   */
  private async checkAppointmentsMonthSoftLimit(): Promise<void> {
    const ctx = getTenantContext();
    const limit = ctx.limits.appointmentsMonth;
    if (!limit) return;
    const monthStartIso = `${todayIsoInTz().slice(0, 7)}-01`;
    const current = await this.apptModel.countDocuments({
      start: { $gte: startOfDayInTz(monthStartIso) },
      status: { $ne: 'cancelled' },
    });
    await this.entitlements.checkSoftLimit(ctx.tenantId, 'appointmentsMonth', current, limit);
  }

  /** Walk-in : source 'walkin', SANS check de dispo (peut chevaucher — décision design). */
  async createWalkin(dto: CreateWalkinDto): Promise<AppointmentDocument> {
    const services = await this.loadServices(dto.serviceIds);
    const { need, price } = this.totals(services);

    const start = dto.start ? new Date(dto.start) : new Date();
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start datetime.');
    const end = new Date(start.getTime() + need * MS_PER_MIN);
    const startDay = start.toISOString().slice(0, 10);

    const stylist = await this.assertStylist(dto.stylistId);
    const clientId = await this.resolveClient(dto);

    const checkInCode = await this.generateCheckInCode(startDay);
    const appt = await this.apptModel.create({
      stylistId: stylist._id,
      clientId,
      groupId: randomUUID(),
      services: services.map((s) => s._id as Types.ObjectId),
      start,
      startDay,
      end,
      status: 'booked',
      source: 'walkin',
      price,
      checkInCode,
    });
    void this.checkAppointmentsMonthSoftLimit();
    return appt;
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

  private isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;
  }

  private async insertWithLockAndCode(
    conflictFilter: () => FilterQuery<AppointmentDocument>,
    insertDoc: Record<string, unknown>,
    startDay: string,
  ): Promise<AppointmentDocument> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const checkInCode = await this.generateCheckInCode(startDay);
      try {
        return await this.insertWithLock(conflictFilter, { ...insertDoc, checkInCode });
      } catch (err) {
        if (!this.isDuplicateKey(err)) throw err;
      }
    }
    throw new ConflictException('Could not allocate a booking code. Please try again.');
  }

  private async generateCheckInCode(startDay: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = `B${String(randomInt(0, 1000)).padStart(3, '0')}`;
      const exists = await this.apptModel.exists({ startDay, checkInCode: code });
      if (!exists) return code;
    }
    throw new ConflictException('Could not allocate a booking code. Please try again.');
  }

  /**
   * Hook notification (#4 scoping) — préparé pour le Sprint 8. À l'insert d'un RDV online,
   * on émettra `BOOKING_CREATED` vers `user:{stylistId}` + badge Schedule owner/manager.
   * Ici : seul le POINT D'APPEL est posé (persist-then-emit réel au Sprint 8).
   */
  private emitBookingCreated(appt: AppointmentDocument, meta: { clientName: string; serviceName: string }): void {
    // Persist-then-emit (#7) + scoping (#4) : stylist concerné + owner salon-wide.
    const payload = {
      appointmentId: appt._id.toString(),
      start: appt.start,
      stylistId: appt.stylistId.toString(),
      groupId: appt.groupId,
      clientName: meta.clientName,
      serviceName: meta.serviceName,
      checkInCode: appt.checkInCode,
    };
    // appt.start is stored UTC-labeled-as-Tunis (dateAtMin convention) — read UTC components
    // directly, no offset, to match the wall-clock time it actually represents.
    const hh = String(appt.start.getUTCHours()).padStart(2, '0');
    const mm = String(appt.start.getUTCMinutes()).padStart(2, '0');
    void this.notifications.dispatch({
      salonId: appt.salonId,
      staffId: appt.stylistId,
      type: SOCKET_EVENTS.APPOINTMENT_CREATED,
      title: 'New appointment',
      body: `${meta.clientName} booked ${meta.serviceName} at ${hh}:${mm}`,
      payload,
    });
    void this.notifications.dispatch({
      salonId: appt.salonId,
      role: 'owner',
      type: SOCKET_EVENTS.APPOINTMENT_CREATED,
      title: 'New appointment',
      body: `${meta.clientName} booked ${meta.serviceName} at ${hh}:${mm}`,
      payload,
    });
    // Broadcast too (SKILL_fix_pos_board_notifications) — the POS kiosk isn't signed in as
    // any specific user/role that the two dispatches above would reach (bb_pos_token has
    // neither `sub` nor `role`), so it must join `salon:{id}` directly to see this at all.
    // Deduplicated by groupId (SKILL_fix_pos_board_notifs_FINAL) — one booking, one notif,
    // even if createAppointment is ever called more than once for the same groupId.
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

  async staffToday(user: AuthUser, date = todayIso()): Promise<HydratedStaffAppointment[]> {
    if (!user.staffId) throw new BadRequestException('Staff profile is required.');
    return this.hydratedStaffAppointments(user.staffId, date, date);
  }

  async staffScheduleWeek(user: AuthUser, startDate = todayIso()): Promise<StaffScheduleWeek> {
    if (!user.staffId) throw new BadRequestException('Staff profile is required.');
    const weekDates = Array.from({ length: 7 }, (_, i) => addDaysIso(startDate, i));
    const schedule = await this.scheduleModel.findOne({ stylistId: new Types.ObjectId(user.staffId) }).lean();
    const dayWindows: StaffScheduleWeek['dayWindows'] = {};
    for (const date of weekDates) {
      const window = schedule ? effectiveWindow(schedule.weekly, schedule.overrides, date) : null;
      dayWindows[date] = window ? { start: minToHhmm(window.start), end: minToHhmm(window.end) } : null;
    }
    const slots = await this.hydratedStaffAppointments(user.staffId, weekDates[0], weekDates[weekDates.length - 1]);
    return { weekDates, dayWindows, slots };
  }

  async clientHome(user: AuthUser): Promise<{ upcoming: Record<string, unknown>[]; history: Record<string, unknown>[] }> {
    const [upcoming, history] = await Promise.all([
      this.listMine(user, 'upcoming'),
      this.listMine(user, 'history'),
    ]);
    return { upcoming, history };
  }

  private async hydratedStaffAppointments(
    staffId: string,
    startDate: string,
    endDate: string,
  ): Promise<HydratedStaffAppointment[]> {
    const stylistId = new Types.ObjectId(staffId);
    const appts: any[] = await this.apptModel
      .find({
        stylistId,
        start: { $lt: dateAtMin(addDaysIso(endDate, 1), 0) },
        end: { $gt: dateAtMin(startDate, 0) },
      })
      .sort({ start: 1 })
      .populate('clientId', 'name phone notes history')
      .populate('services', 'name price durationMin')
      .lean();

    return appts
      .filter((a) => a.status !== 'cancelled' && a.status !== 'noshow')
      .map((a) => {
        const client = a.clientId as { _id: Types.ObjectId; name?: string; phone?: string; notes?: string; history?: unknown[] } | null;
        const services = (a.services ?? []) as Array<{ _id: Types.ObjectId; name?: string; price?: number; durationMin?: number }>;
        const start = new Date(a.start);
        const end = new Date(a.end);
        const clientName = client?.name ?? 'Client';
        return {
          id: a._id.toString(),
          date: start.toISOString().slice(0, 10),
          start,
          end,
          startTime: start.toISOString().slice(11, 16),
          clientId: client?._id?.toString() ?? a.clientId?.toString?.() ?? '',
          clientName,
          clientInitials: initials(clientName),
          phone: client?.phone ?? '',
          services: services.map((s) => ({
            id: s._id.toString(),
            name: s.name ?? 'Service',
            durationMin: s.durationMin ?? 0,
            priceTnd: s.price ?? 0,
          })),
          durationMin: Math.round((end.getTime() - start.getTime()) / MS_PER_MIN),
          totalTnd: a.price ?? 0,
          status: a.status,
          state: staffState(a.status),
          note: client?.notes || undefined,
          visitCount: client?.history?.length ?? 0,
          checkInCode: a.checkInCode ?? null,
        };
      });
  }

  /**
   * Appointments for the currently logged-in client, CROSS-SALON (SKILL_client_appointments_dynamic
   * BK.1). A client identity (`Client.userId`) can hold one `Client` doc per salon they've ever
   * booked at — collect them all rather than scoping to a single salon.
   *
   * Durcissement post-Sprint-1-v2 Partie 3 (trou trouvé au Prompt 6b) : réécrit sur le
   * pattern DÉJÀ prouvé de `ClientProfileService.getGlobalHistory` (Prompt 4) — résout les
   * tenants connus du client via `ClientProfile.tenantIds[]` (`getTenantIdsForClient`), puis
   * une boucle d'appels SCOPÉS par tenant (`runWithTenant(systemReadContext(...))`,
   * concurrence plafonnée), jamais un nouveau bypass. Avant ce fix, `clientModel.find(...)
   * .distinct('_id')` échappait déjà accidentellement au scope (`.distinct()` n'est pas un
   * hook intercepté par le plugin — dette #Prompt3), mais le filtrage RDV qui suivait
   * (`apptModel.find`, hook réel) restait forcé au seul tenant courant — un client avec des
   * RDV dans 2 salons ne voyait jamais le second.
   */
  async listMine(user: AuthUser, scope: 'upcoming' | 'history'): Promise<Record<string, unknown>[]> {
    const tenantIds = user.clientId
      ? await this.clientProfiles.getTenantIdsForClient(user.salonId, user.clientId)
      : [user.salonId];

    const perTenant = await mapWithConcurrencyLimit(tenantIds, MAX_CONCURRENT_TENANTS, async (tenantId) => {
      try {
        return await this.fetchMineForTenant(tenantId, user, scope);
      } catch (err) {
        this.logger.warn(`listMine: skipping tenant ${tenantId} — ${(err as Error).message}`);
        return [];
      }
    });

    const merged = perTenant.flat();
    merged.sort((a, b) => {
      const ta = new Date(a.start as string | Date).getTime();
      const tb = new Date(b.start as string | Date).getTime();
      return scope === 'upcoming' ? ta - tb : tb - ta;
    });
    return merged;
  }

  /** Un tenant : résout ses locations, boucle dessus (appointments est LOCATION_SCOPED),
   *  puis enrichit (StaffProfile, nom du salon) sous un seul appel scopé au tenant. */
  private async fetchMineForTenant(
    tenantId: string,
    user: AuthUser,
    scope: 'upcoming' | 'history',
  ): Promise<Record<string, unknown>[]> {
    const locations = await runWithTenant(systemReadContext(tenantId), () => this.locations.findAllForTenant({ salonId: tenantId }));
    if (locations.length === 0) return [];
    const salon = await this.salonModel.findById(tenantId).select('name').lean();
    const salonName = salon?.name ?? null;
    const locationIds = locations.map((l) => l._id.toString());

    const perLocation = await Promise.all(
      locationIds.map((locationId) => this.fetchMineAppointmentsForLocation(tenantId, locationId, locationIds, user, scope)),
    );
    const appts = perLocation.flat();
    if (!appts.length) return [];

    return runWithTenant(systemReadContext(tenantId), async () => {
      // Join StaffProfile (publicTitle / seniorityTag) — clé réelle = staff._id (cf public.service.ts).
      const staffIds = appts.map((a) => a.stylistId?._id).filter(Boolean);
      const profiles = await this.profileModel
        .find({ userId: { $in: staffIds } })
        .select('userId publicTitle seniorityTag')
        .lean()
        .exec();
      const profileByStaffId = new Map(profiles.map((p) => [p.userId.toString(), p]));

      return appts.map((a) => {
        const staff = a.stylistId as { _id: Types.ObjectId; name: string } | null;
        const profile = staff ? profileByStaffId.get(staff._id.toString()) : undefined;
        return {
          id: a._id.toString(),
          salonId: tenantId,
          salonName,
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
          checkInCode: a.checkInCode ?? null,
        };
      });
    });
  }

  /** Une location d'un tenant : identité client résolue LOCALEMENT à ce tenant (le
   *  `Client._id` de `user.clientId` n'est valide que dans `user.salonId` — sur les autres
   *  tenants connus du profil, seuls userId/phone identifient la bonne fiche). */
  private async fetchMineAppointmentsForLocation(
    tenantId: string,
    locationId: string,
    locationIds: string[],
    user: AuthUser,
    scope: 'upcoming' | 'history',
  ): Promise<any[]> {
    return runWithTenant(systemReadContext(tenantId, locationId, locationIds), async () => {
      // `new Types.ObjectId(user.sub)`, PAS la string brute : trouvé en écrivant CROSS-01 —
      // un `userId` string non casté à l'intérieur d'un `$or` ne matchait JAMAIS le champ
      // ObjectId réel une fois le filtre reconstruit par `query.setQuery()` dans le plugin
      // (Prompt 3) — bug pré-existant dans l'ancien `listMine()`, jamais exercé avec un vrai
      // userId correspondant avant ce durcissement. Même correctif appliqué à `cancel()`.
      const identity: FilterQuery<ClientDocument>[] = [{ userId: new Types.ObjectId(user.sub) }];
      if (tenantId === user.salonId && user.clientId) identity.push({ _id: user.clientId });
      if (user.phone) {
        identity.push({ phone: user.phone });
        const phone = normalizedPhone(user.phone);
        if (phone && phone !== user.phone) identity.push({ phone });
        const phoneRegex = flexiblePhoneRegex(user.phone);
        if (phoneRegex) identity.push({ phone: phoneRegex });
      }
      const clientDocs = await this.clientModel.find({ $or: identity }).select('_id').exec();
      const clientIds = clientDocs.map((d) => d._id as Types.ObjectId);
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

      return this.apptModel
        .find(filter)
        .populate('services', 'name price')
        .populate('stylistId', 'name')
        .lean()
        .exec();
    });
  }

  async list(date?: string, stylistId?: string): Promise<AppointmentDocument[]> {
    const filter: FilterQuery<AppointmentDocument> = {};
    // Appointment.stylistId is genuinely stored as ObjectId (populated from Staff._id at
    // write time) but the schema's `@Prop({ type: Types.ObjectId })` doesn't get Mongoose to
    // auto-cast query filters for this path — a raw string here silently matches nothing.
    if (stylistId) filter.stylistId = new Types.ObjectId(stylistId);
    if (date) {
      filter.start = { $lt: dateAtMin(date, 24 * 60) };
      filter.end = { $gt: dateAtMin(date, 0) };
    }
    return this.apptModel.find(filter).sort({ start: 1 }).exec();
  }

  /** Bloc chaîné (#3) — tous les RDV partageant un groupId. */
  async listGroup(groupId: string): Promise<AppointmentDocument[]> {
    return this.apptModel.find({ groupId }).sort({ start: 1 }).exec();
  }

  /** Détail d'un RDV — alimente le modal de détails (click depuis le planning ou une notification). */
  async getOne(id: string): Promise<AppointmentDocument> {
    const appt = await this.apptModel.findOne({ _id: id });
    if (!appt) throw new NotFoundException('Appointment not found.');
    return appt;
  }

  /**
   * `appointments` est LOCATION_SCOPED — un `runWithTenant(systemReadContext(tenantId))` SANS
   * locationId ferait injecter `locationId: ''` (défaut du helper) dans le filtre, qui ne
   * matche jamais un vrai RDV. Boucle donc sur CHAQUE location du tenant candidat (comme
   * `fetchMineForTenant`), pas un seul essai à locationId vide — trouvé en écrivant CROSS-02.
   */
  private async findAppointmentAcrossTenants(
    id: string,
    candidateTenantIds: string[],
    skipTenantId: string | null,
  ): Promise<{ appt: AppointmentDocument; tenantId: string } | null> {
    for (const tenantId of candidateTenantIds) {
      if (tenantId === skipTenantId) continue;
      const locations = await runWithTenant(systemReadContext(tenantId), () => this.locations.findAllForTenant({ salonId: tenantId }));
      for (const loc of locations) {
        const locId = loc._id.toString();
        const found = await runWithTenant(systemReadContext(tenantId, locId, [locId]), () => this.apptModel.findOne({ _id: id }).exec());
        if (found) return { appt: found, tenantId };
      }
    }
    return null;
  }

  /**
   * Annulation : autorisée au staff (JWT, même salon), au client via lien signé (#12),
   * OU au client propriétaire via son propre JWT (SKILL_client_appointments_dynamic BK.2 —
   * salon dérivé de l'appointment, pas du scope de la requête appelante : le client peut
   * posséder des RDV dans plusieurs salons).
   *
   * Durcissement post-Sprint-1-v2 Partie 3 (trou trouvé en nettoyant Prompt 6b) : le
   * premier essai reste scopé au tenant courant (staff, lien signé, ou client déjà sur le
   * bon salon — comportement inchangé). Si absent ET appelant client authentifié, le RDV
   * peut vivre dans un AUTRE de ses salons — cherche SEULEMENT parmi les tenants connus de
   * CE client (`ClientProfile.tenantIds`, même mécanisme que `listMine()`), jamais un
   * balayage cross-tenant arbitraire. Appels scopés (`runWithTenant`), jamais de bypass.
   */
  async cancel(id: string, opts: { user?: AuthUser; dto?: CancelAppointmentDto }): Promise<AppointmentDocument> {
    // Lecture souple (pas getTenantContext(), qui throw) : `cancel()` doit rester appelable
    // sans context établi (cas historique scope=null), seul `isStaff` en dépend.
    const currentTenantId = tenantStorage.getStore()?.tenantId ?? null;
    const tokenOk = !!opts.dto?.token && verifyAppointmentToken(id, opts.dto.token);

    let appt: AppointmentDocument | null = currentTenantId ? await this.apptModel.findOne({ _id: id }) : null;
    let apptTenantId = currentTenantId;

    if (!appt && opts.user?.role === 'client' && opts.user.clientId) {
      const candidateTenantIds = await this.clientProfiles.getTenantIdsForClient(opts.user.salonId, opts.user.clientId);
      const found = await this.findAppointmentAcrossTenants(id, candidateTenantIds, currentTenantId);
      if (found) {
        appt = found.appt;
        apptTenantId = found.tenantId;
      }
    }

    if (!appt) throw new NotFoundException('Appointment not found.');
    const resolvedAppt = appt;
    const resolvedTenantId = apptTenantId!;

    return runWithTenant(systemReadContext(resolvedTenantId), async () => {
      const isStaff =
        !!opts.user &&
        ['owner', 'manager', 'stylist', 'colorist'].includes(opts.user.role) &&
        resolvedTenantId === currentTenantId; // isolation multi-tenant : même salon requis

      let isOwnerClient = false;
      if (!isStaff && !tokenOk && opts.user?.role === 'client') {
        const ownClientDocs = await this.clientModel.find({ userId: new Types.ObjectId(opts.user.sub) }).select('_id').exec();
        isOwnerClient = ownClientDocs.some((c) => (c._id as Types.ObjectId).toString() === resolvedAppt.clientId.toString());
      }

      if (!isStaff && !tokenOk && !isOwnerClient) {
        throw new ForbiddenException('Not allowed to cancel this appointment.');
      }
      if (!ACTIVE_STATUSES.includes(resolvedAppt.status)) {
        throw new BadRequestException('Appointment already completed or cancelled.');
      }
      // Un client ne peut annuler qu'un RDV à venir (pas de "cancel" rétroactif sur son propre historique).
      if (isOwnerClient && !isStaff && !tokenOk && resolvedAppt.start < new Date()) {
        throw new BadRequestException('This appointment is in the past.');
      }

      resolvedAppt.status = 'cancelled';
      await resolvedAppt.save();
      void this.notifications.dispatch({
        salonId: resolvedAppt.salonId,
        staffId: resolvedAppt.stylistId,
        type: SOCKET_EVENTS.APPOINTMENT_CANCELLED,
        title: 'Appointment cancelled',
        body: 'An appointment was cancelled.',
        payload: { appointmentId: resolvedAppt._id.toString(), stylistId: resolvedAppt.stylistId.toString(), checkInCode: resolvedAppt.checkInCode },
      });
      return resolvedAppt;
    });
  }
}
