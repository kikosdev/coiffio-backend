import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Location, LocationDocument } from '../locations/schemas/location.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { normalizeIdentifier } from '../auth/identifier.util';
import { mintResetToken, resetPasswordLink } from '../auth/reset-token.util';
import { runWithTenant, TenantContext } from '../common/tenant/tenant-context';
import { startOfDayInTz, todayIsoInTz } from '../common/time/tz-day.util';
import { MembershipService } from '../identity/membership.service';
import { EmailService } from '../email/email.service';
import { welcomeEmailHtml } from '../email/templates';
import { ImpersonateDto, ProvisionTenantDto } from './dto/internal.dto';

const BCRYPT_ROUNDS = 10;
const WELCOME_TOKEN_TTL = '24h';

/** Catalogue de démarrage — aucun catalogue existant à réutiliser (vérifié, rien dans
 *  src/seed/). Valeurs plausibles pour un salon tunisien, prix en TND. */
const DEFAULT_SERVICES = [
  { name: 'Coupe', category: 'Cheveux', gender: 'universal' as const, price: 35, durationMin: 30 },
  { name: 'Brushing', category: 'Cheveux', gender: 'universal' as const, price: 25, durationMin: 30 },
  { name: 'Couleur', category: 'Cheveux', gender: 'universal' as const, price: 80, durationMin: 90 },
  { name: 'Barbe', category: 'Barbier', gender: 'men' as const, price: 20, durationMin: 20 },
];

function toOpeningHours(businessHours: { day: number; isOpen: boolean; start: string; end: string }[]): unknown[] {
  return businessHours.map((h) => ({ day: h.day, open: h.start, close: h.end, closed: !h.isOpen }));
}

function bootstrapCtx(tenantId: string): TenantContext {
  return { tenantId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

export interface ProvisionResult {
  tenantId: string;
  locationId: string;
  ownerStaffId: string;
  slug: string;
}

export interface UsageResult {
  staffCount: number;
  locationCount: number;
  appointmentsThisMonth: number;
  smsThisMonth: number;
  storageMb: number;
  lastAppointmentCreatedAt: Date | null;
}

@Injectable()
export class InternalService {
  private readonly logger = new Logger(InternalService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Schedule.name) private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Appointment.name) private readonly appointmentModel: Model<AppointmentDocument>,
    private readonly jwt: JwtService,
    private readonly memberships: MembershipService,
    private readonly email: EmailService,
  ) {}

  /**
   * Idempotent sur `tenantId` (clé émise par le CP, devient l'`_id` de `salons`) : un 2e
   * appel avec le même tenantId renvoie l'état actuel, jamais de doublon. Séquence complète
   * sous UNE transaction MongoDB — un échec à n'importe quelle étape annule tout (rollback
   * complet), rien ne persiste. `runWithTenant` englobe la transaction (pas l'inverse) pour
   * que le contexte survive aux retries internes de `withTransaction`.
   */
  async provisionTenant(dto: ProvisionTenantDto): Promise<ProvisionResult> {
    const existing = await this.salonModel.findById(dto.tenantId).lean();
    if (existing) {
      const [location, owner] = await runWithTenant(bootstrapCtx(dto.tenantId), () =>
        Promise.all([
          this.locationModel.findOne({ salonId: dto.tenantId, isPrimary: true }).lean(),
          this.staffModel.findOne({ salonId: dto.tenantId, role: 'owner' }).sort({ createdAt: 1 }).lean(),
        ]),
      );
      if (!location || !owner) {
        throw new ConflictException(
          `Tenant ${dto.tenantId} already exists but provisioning is incomplete (missing ${!location ? 'primary location' : 'owner account'}) — needs manual repair, not a safe retry.`,
        );
      }
      // Auto-cicatrisant (Sprint 2 v2 Prompt 2) : un tenant provisionné AVANT ce prompt
      // n'a pas de Membership — un rejeu de provisionTenant() (retry légitime côté CP) le
      // crée ici plutôt que de rester silencieusement absent pour toujours.
      await this.ensureOwnerMembership(dto.tenantId, (owner._id as Types.ObjectId).toString(), (location._id as Types.ObjectId).toString());
      return {
        tenantId: dto.tenantId,
        locationId: (location._id as Types.ObjectId).toString(),
        ownerStaffId: (owner._id as Types.ObjectId).toString(),
        slug: existing.slug,
      };
    }

    let result: ProvisionResult | null = null;
    let ownerUserId: Types.ObjectId | null = null;
    const session = await this.connection.startSession();
    try {
      await runWithTenant(bootstrapCtx(dto.tenantId), async () => {
        await session.withTransaction(async () => {
          const [salon] = await this.salonModel.create(
            [
              {
                _id: new Types.ObjectId(dto.tenantId),
                name: dto.name,
                slug: dto.slug,
                timezone: dto.timezone ?? 'Africa/Tunis',
                currency: dto.currency ?? 'TND',
              },
            ],
            { session },
          );

          const [location] = await this.locationModel.create(
            [
              {
                salonId: dto.tenantId,
                name: 'Principal',
                slug: 'principal',
                region: dto.region,
                timezone: salon.timezone,
                openingHours: toOpeningHours(salon.businessHours),
                isPrimary: true,
                active: true,
              },
            ],
            { session },
          );
          const locationId = (location._id as Types.ObjectId).toString();

          const identifier = normalizeIdentifier(dto.owner.email);
          // password optionnel côté CP (spec) — quand absent (le cas nominal, le CP n'envoie
          // jamais de mot de passe), un mot de passe aléatoire inconnaissable est posé ; le
          // compte devient utilisable via l'email de bienvenue envoyé après la transaction
          // (Sprint 4 Prompt 2), pas via ce mot de passe.
          const password = dto.owner.password ?? crypto.randomBytes(24).toString('hex');
          const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
          const [user] = await this.userModel.create(
            [{ identifier: identifier.value, identifierType: identifier.type, passwordHash, role: 'owner', isActive: true }],
            { session },
          );
          ownerUserId = user._id as Types.ObjectId;

          const [owner] = await this.staffModel.create(
            [
              {
                salonId: dto.tenantId,
                userId: user._id,
                name: dto.owner.name,
                email: dto.owner.email.toLowerCase().trim(),
                phone: dto.owner.phone,
                role: 'owner',
                locationIds: [locationId],
                defaultLocationId: locationId,
                isActive: true,
              },
            ],
            { session },
          );

          await this.scheduleModel.create([{ salonId: dto.tenantId, stylistId: owner._id, weekly: [], overrides: [] }], { session });

          await this.serviceModel.create(
            DEFAULT_SERVICES.map((s) => ({ ...s, salonId: dto.tenantId })),
            { session, ordered: true },
          );

          result = {
            tenantId: dto.tenantId,
            locationId,
            ownerStaffId: (owner._id as Types.ObjectId).toString(),
            slug: salon.slug,
          };
        });
      });
    } finally {
      await session.endSession();
    }

    // Hors transaction (Sprint 2 v2 Prompt 2) : `memberships` est GLOBAL, sans lien avec
    // la transaction tenant-scoped ci-dessus. Si cet appel échoue seul, le retry côté CP
    // (provisionTenant est idempotent sur tenantId) tombe dans la branche "already exists"
    // ci-dessus, qui auto-cicatrise le Membership manquant — jamais d'état bloqué.
    await this.ensureOwnerMembership(result!.tenantId, result!.ownerStaffId, result!.locationId);

    // Effet de bord APRÈS la transaction, jamais dedans (Sprint 4 Prompt 2) : un échec
    // d'envoi ne doit JAMAIS annuler un provisioning déjà commité — le tenant existe, l'email
    // est du meilleur effort. `dto.owner.password` fourni explicitement (rare — le CP n'en
    // envoie jamais aujourd'hui) => le owner connaît déjà son mot de passe, pas de mail.
    // ownerUserId est TOUJOURS posé ici (branche "nouveau tenant" uniquement — la branche
    // idempotente "already exists" retourne plus haut) ; `!` plutôt qu'un narrowing par
    // `if (ownerUserId)` que TS ne résout pas correctement à travers la fermeture async de
    // `session.withTransaction`.
    if (!dto.owner.password) {
      await this.sendWelcomeEmail(ownerUserId!.toString(), dto.owner.name, dto.owner.email, dto.name);
    }

    this.logger.log(`Provisioned tenant ${dto.tenantId} (slug=${dto.slug}).`);
    return result!;
  }

  private async sendWelcomeEmail(userId: string, ownerName: string, ownerEmail: string, salonName: string): Promise<void> {
    try {
      const token = mintResetToken(this.jwt, userId, WELCOME_TOKEN_TTL);
      const setupUrl = resetPasswordLink(token);
      await this.email.sendEmail({
        to: ownerEmail,
        subject: 'Bienvenue sur SalonOS — définissez votre mot de passe',
        html: welcomeEmailHtml({ ownerName, salonName, setupUrl }),
      });
    } catch (err) {
      this.logger.error(`Welcome email failed for owner ${ownerEmail} (userId=${userId}) — tenant still provisioned, resend manually: ${(err as Error).message}`);
    }
  }

  /** Résout `userId` depuis le `staffId` connu (jamais celui passé en clair — évite un
   *  aller-retour supplémentaire côté appelant) puis crée le Membership manquant, s'il
   *  n'existe pas déjà (idempotent, comme le reste de cette méthode). */
  private async ensureOwnerMembership(tenantId: string, ownerStaffId: string, locationId: string): Promise<void> {
    // `.exec()` DOIT être appelé DANS le callback synchrone de `runWithTenant` — un objet
    // Query Mongoose est lazy, sans `.exec()` l'exécution réelle n'a lieu qu'après le
    // retour de `tenantStorage.run()`, hors de la fenêtre AsyncLocalStorage suivie (piège
    // déjà documenté ailleurs dans ce codebase, reproduit ici avant d'être corrigé).
    const owner = await runWithTenant(bootstrapCtx(tenantId), () => this.staffModel.findById(ownerStaffId).select('userId').lean().exec());
    const userId = owner?.userId?.toString();
    if (!userId) {
      this.logger.error(`ensureOwnerMembership: owner staff ${ownerStaffId} on tenant ${tenantId} has no userId — cannot create Membership.`);
      return;
    }
    const existing = await this.memberships.findByUserAndTenant(userId, tenantId);
    if (existing) return;
    await this.memberships.create({
      userId,
      tenantId,
      kind: 'staff',
      staffId: ownerStaffId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
    });
  }

  async updateTenantStatus(tenantId: string, status: 'active' | 'suspended' | 'churned'): Promise<{ tenantId: string; status: string }> {
    const salon = await this.salonModel.findByIdAndUpdate(tenantId, { status }, { new: true }).lean();
    if (!salon) throw new NotFoundException('Tenant not found.');
    this.logger.warn(`Tenant ${tenantId} status → ${status}.`);
    return { tenantId, status: salon.status };
  }

  async usage(tenantId: string): Promise<UsageResult> {
    const salon = await this.salonModel.findById(tenantId).lean();
    if (!salon) throw new NotFoundException('Tenant not found.');

    return runWithTenant(bootstrapCtx(tenantId), async () => {
      const monthStartIso = `${todayIsoInTz().slice(0, 7)}-01`;
      const [staffCount, locationCount, appointmentsThisMonth, lastAppt] = await Promise.all([
        this.staffModel.countDocuments({ salonId: tenantId, isActive: true }),
        this.locationModel.countDocuments({ salonId: tenantId, active: true }),
        this.appointmentModel.countDocuments({ start: { $gte: startOfDayInTz(monthStartIso) } }),
        this.appointmentModel.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean(),
      ]);
      return {
        staffCount,
        locationCount,
        appointmentsThisMonth,
        // Aucun dispatch SMS réel dans ce codebase (cf. dette entitlements smsQuota) — champ
        // présent pour le contrat, jamais fabriqué.
        smsThisMonth: 0,
        // Aucun tracking de stockage — idem, champ présent, jamais fabriqué.
        storageMb: 0,
        lastAppointmentCreatedAt: (lastAppt as { createdAt?: Date } | null)?.createdAt ?? null,
      };
    });
  }

  /**
   * JWT court signé pour le compte owner du tenant, avec `impersonatedBy`/reason portés
   * jusqu'à `TenantContext` (`tenant-context.middleware.ts` les lit et logue chaque requête
   * faite sous ce token). ⚠️ Le blocage des actions destructrices (delete/refund/suspension
   * de staff) pendant une impersonation N'EST PAS câblé endpoint par endpoint ici — seule la
   * plomberie structurelle (JWT → contexte → log) est faite. Nécessiterait un balayage
   * cross-module comparable à celui du Prompt 7 (feature gates) ; hors scope de cette preuve,
   * documenté comme dette de suivi plutôt que traité partiellement en silence.
   */
  async impersonate(tenantId: string, dto: ImpersonateDto): Promise<{ token: string; expiresInMinutes: number }> {
    const ttlMinutes = dto.ttlMinutes ?? 15;
    return runWithTenant(bootstrapCtx(tenantId), async () => {
      const owner = await this.staffModel.findOne({ salonId: tenantId, role: 'owner' }).sort({ createdAt: 1 }).lean();
      if (!owner) throw new NotFoundException('No owner account found for this tenant.');

      const payload = {
        sub: owner.userId.toString(),
        salonId: tenantId,
        role: 'owner' as const,
        staffId: (owner._id as Types.ObjectId).toString(),
        accountType: 'staff' as const,
        impersonatedBy: dto.adminId,
        impersonationReason: dto.reason,
      };
      const token = await this.jwt.signAsync(payload, { expiresIn: `${ttlMinutes}m` });
      this.logger.warn(`Impersonation token minted: tenant=${tenantId} admin=${dto.adminId} reason="${dto.reason}" ttl=${ttlMinutes}min.`);
      return { token, expiresInMinutes: ttlMinutes };
    });
  }
}
