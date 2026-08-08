import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/**
 * Une collision d'unicité sur `users.identifier` (E11000) veut dire "cet email/téléphone a
 * déjà un compte" — un refus MÉTIER définitif, jamais une panne. Sans ce mapping, elle
 * remonte en **500** (message Mongo brut, `AllExceptionsFilter` n'a pas de cas E11000), et le
 * `dp-client` du Control Plane la traite alors comme une indisponibilité du DP : 4 tentatives
 * (`MAX_ATTEMPTS`) puis comptage dans le disjoncteur — 5 doublons d'affilée ouvriraient le
 * breaker 60s sur nos propres erreurs métier. Un 409 sort de ce chemin : côté CP, un 4xx
 * n'est jamais retried et ne compte jamais pour le disjoncteur.
 *
 * VOLONTAIREMENT ÉTROIT — seule la clé `identifier` est reconnue ici. Les autres index
 * uniques traversés par ce provisioning (`salons._id`, `salons.slug`, `locations.{salonId,slug}`,
 * `staffs.{salonId,email}`, `staffs.{userId,salonId}`) gardent leur propre sémantique et
 * continuent de remonter telles quelles : ce n'est pas une conversion globale des E11000 du
 * projet. `users.identifier` est par ailleurs le SEUL index unique portant ce nom de champ
 * (`invitations.identifier` existe mais n'est pas unique), donc la clé est non ambiguë.
 */
function isOwnerIdentifierCollision(err: unknown): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> } | null;
  if (!e || e.code !== 11000) return false;
  const hasKey = (o?: Record<string, unknown>) => !!o && Object.prototype.hasOwnProperty.call(o, 'identifier');
  return hasKey(e.keyPattern) || hasKey(e.keyValue);
}

export interface ProvisionResult {
  tenantId: string;
  locationId: string;
  ownerStaffId: string;
  slug: string;
  /** [P3] Le `users._id` du propriétaire — créé sur la branche création, réutilisé tel quel
   *  sur la branche rattachement. Renvoyé pour que le CP puisse lier son `Tenant` à une
   *  identité réelle au lieu de sa seule copie dénormalisée `Tenant.owner`. */
  ownerUserId: string;
}

/** [P2 owner multi-salon] Un tenant où ce user est owner ACTIF. Volontairement minimal :
 *  juste de quoi laisser le CP afficher "rattacher à cet owner ?" et distinguer deux salons
 *  homonymes. Aucun identifiant de staff, aucune donnée de contact, aucun membership non-owner. */
export interface OwnerOwnership {
  tenantId: string;
  salonName: string;
  /** Rempli à partir du Prompt P4 (le champ n'existe pas encore sur `Salon`) — `undefined`
   *  d'ici là, jamais fabriqué. Le contrat de réponse est posé maintenant pour que le CP
   *  n'ait pas à changer de forme entre P2 et P4. */
  locationLabel?: string;
}

export interface OwnerLookupResult {
  exists: boolean;
  userId?: string;
  ownerships?: OwnerOwnership[];
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
    const attach = dto.attachToExistingOwner === true;

    // Le flag est AUTORITAIRE. Un `ownerUserId` fourni sans lui est une intention ambiguë
    // (créer ? rattacher ?) — refusée explicitement plutôt qu'ignorée en silence, puisque
    // cette ambiguïté est exactement ce que la décision 8 supprime.
    if (dto.ownerUserId && !attach) {
      throw new BadRequestException({
        code: 'ATTACH_FLAG_REQUIRED',
        message: 'ownerUserId requires attachToExistingOwner: true — refusing an ambiguous provisioning intent.',
      });
    }
    if (attach) await this.assertAttachableOwner(dto);

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
        ownerUserId: owner.userId.toString(),
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
                // [P4] Écrit ICI, avant la bifurcation création/rattachement : le salon est
                // créé une seule fois, en amont des deux branches, donc les deux le
                // persistent sans duplication de code. Absent du DTO => champ absent du
                // document (pas de chaîne vide fabriquée).
                locationLabel: dto.locationLabel,
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

          // Le profil staff owner de ce tenant — créé ici (branche création) ou par
          // `grant()` (branche rattachement). Le `schedule` plus bas le référence dans les
          // deux cas : c'est la seule valeur qui doit sortir de ce `if`.
          let ownerStaffOid: Types.ObjectId;

          if (attach) {
            // ── BRANCHE RATTACHEMENT (P3, décision 8) ────────────────────────────────
            // Ni `userModel.create()` (le compte existe, le réutiliser est tout l'objet de
            // cette branche), ni `staffModel.create()` : `grant()` crée LUI-MÊME le profil
            // staff dans le tenant cible. Un `staffModel.create()` ici entrerait en collision
            // avec l'index unique `(userId, salonId)` (Sprint 2 v2 Prompt 3) — ou pire, le
            // ferait passer en double si l'index venait à manquer.
            //
            // `users.role` du compte réutilisé n'est JAMAIS touché : c'est une catégorie large
            // (`owner|staff|client`), pas le rôle applicatif. L'autorité est
            // `Membership.role`, projeté de `staffs.role` (invariant Sprint 2). Un compte
            // `users.role:'staff'` devenant owner d'un nouveau salon reste `'staff'` ici, et
            // c'est CORRECT — ne pas "corriger" ça.
            ownerUserId = new Types.ObjectId(dto.ownerUserId!);
            const membership = await this.memberships.grant(
              'owner',
              {
                userId: dto.ownerUserId!,
                tenantId: dto.tenantId,
                role: 'owner',
                locationIds: [locationId],
                defaultLocationId: locationId,
                // OVERRIDE EXPLICITE des trois champs de contact. Sans eux, `grant()` recopie
                // le profil staff le PLUS ANCIEN de ce user dans un AUTRE tenant : silencieux,
                // et faux dès que l'owner a changé de téléphone ou veut un contact distinct
                // pour ce salon-ci. Le DTO de provisioning est la source de vérité, pas
                // l'historique d'un autre salon.
                name: dto.owner.name,
                email: dto.owner.email.toLowerCase().trim(),
                phone: dto.owner.phone,
              },
              session,
            );
            // `grant()` avec `role:'owner'` produit toujours un membership `kind:'staff'`,
            // donc `staffId` est garanti posé (invariant du `pre('validate')` de Membership).
            ownerStaffOid = membership.staffId!;
          } else {
            // ── BRANCHE CRÉATION (chemin historique, inchangé) ───────────────────────
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
            ownerStaffOid = owner._id as Types.ObjectId;
          }

          // `locationId` EXPLICITE : `schedules` est LOCATION_SCOPED, et le contexte de
          // provisioning (`bootstrapCtx`) porte `locationId: ''`. Sans cette valeur, le plugin
          // insère `locationId: ''`, et le premier enregistrement de rota par l'owner (session
          // réelle, vrai locationId) ne retrouve plus ce document : le `findOneAndUpdate`
          // upsert bascule en INSERT et viole l'index unique `salonId_1_stylistId_1` (E11000).
          await this.scheduleModel.create(
            [{ salonId: dto.tenantId, locationId, stylistId: ownerStaffOid, weekly: [], overrides: [] }],
            { session },
          );

          await this.serviceModel.create(
            DEFAULT_SERVICES.map((s) => ({ ...s, salonId: dto.tenantId })),
            { session, ordered: true },
          );

          result = {
            tenantId: dto.tenantId,
            locationId,
            ownerStaffId: ownerStaffOid.toString(),
            slug: salon.slug,
            ownerUserId: (ownerUserId as Types.ObjectId).toString(),
          };
        });
      });
    } catch (err) {
      // Voir `isOwnerIdentifierCollision` ci-dessus : refus métier (409), pas une panne (500).
      // La transaction a déjà été annulée par `withTransaction` — rien ne persiste, exactement
      // comme avant ce mapping (seul le CODE DE STATUT change, pas le comportement en base).
      if (isOwnerIdentifierCollision(err)) {
        // [P3] Ce refus reste le comportement par DÉFAUT (décision 8) : le rattachement à un
        // compte existant doit être demandé explicitement, jamais déduit de l'email.
        throw new ConflictException({
          code: 'OWNER_EMAIL_TAKEN',
          message: `An account already exists for "${dto.owner.email}" — resolve it via GET /internal/owners/lookup and re-send with attachToExistingOwner + ownerUserId to attach this tenant to it.`,
        });
      }
      throw err;
    } finally {
      await session.endSession();
    }

    // Hors transaction (Sprint 2 v2 Prompt 2) : `memberships` est GLOBAL, sans lien avec
    // la transaction tenant-scoped ci-dessus. Si cet appel échoue seul, le retry côté CP
    // (provisionTenant est idempotent sur tenantId) tombe dans la branche "already exists"
    // ci-dessus, qui auto-cicatrise le Membership manquant — jamais d'état bloqué.
    //
    // [P3] UNIQUEMENT sur la branche création : la branche rattachement a déjà son Membership,
    // créé par `grant()` DANS la transaction (donc soumis au même rollback que le reste, ce
    // qui est strictement plus sûr). Décision 5 : `grant()` OU `ensureOwnerMembership`, jamais
    // les deux — `grant()` refuse en 409 si le membership existe déjà. `ensureOwnerMembership`
    // reste par ailleurs indispensable à la branche idempotente plus haut (auto-cicatrisation
    // d'un tenant provisionné avant l'existence des Memberships) : il n'est pas supprimable.
    if (!attach) {
      await this.ensureOwnerMembership(result!.tenantId, result!.ownerStaffId, result!.locationId);
    }

    // Effet de bord APRÈS la transaction, jamais dedans (Sprint 4 Prompt 2) : un échec
    // d'envoi ne doit JAMAIS annuler un provisioning déjà commité — le tenant existe, l'email
    // est du meilleur effort. `dto.owner.password` fourni explicitement (rare — le CP n'en
    // envoie jamais aujourd'hui) => le owner connaît déjà son mot de passe, pas de mail.
    // [P3] `attach` => AUCUN mail non plus : c'est un compte déjà actif, qui a déjà son mot de
    // passe ; lui envoyer un lien de définition de mot de passe serait au mieux troublant, au
    // pire un vecteur de reset non sollicité déclenchable depuis le CP.
    // ownerUserId est TOUJOURS posé ici (branche "nouveau tenant" uniquement — la branche
    // idempotente "already exists" retourne plus haut) ; `!` plutôt qu'un narrowing par
    // `if (ownerUserId)` que TS ne résout pas correctement à travers la fermeture async de
    // `session.withTransaction`.
    if (!attach && !dto.owner.password) {
      await this.sendWelcomeEmail(ownerUserId!.toString(), dto.owner.name, dto.owner.email, dto.name);
    }

    this.logger.log(`Provisioned tenant ${dto.tenantId} (slug=${dto.slug}).`);
    return result!;
  }

  /**
   * [P3] Valide la cible d'un rattachement AVANT toute écriture. Le flag explicite dit
   * "rattache", il ne dit pas "rattache à n'importe quoi" : `ownerUserId` vient du CP et
   * n'est jamais pris pour argent comptant — même discipline que `grant()`, qui vérifie le
   * `staffId` qu'on lui passe au lieu de le croire.
   *
   * Le contrôle d'identifier est le garde-fou qui rend la décision 8 RÉELLE : sans lui, un
   * flag explicite accompagné d'un `ownerUserId` erroné (bug de résolution côté CP, deux
   * onglets, copier-coller) rattacherait un salon au mauvais propriétaire — exactement le
   * risque que le rattachement explicite est censé éliminer, simplement déplacé d'un champ
   * à l'autre.
   *
   * ⚠️ La comparaison ne s'applique QUE si le compte est identifié par EMAIL. `users`
   * accepte email OU téléphone comme identifiant (`identifierType`), et `dto.owner.email`
   * n'est alors comparable à rien : un owner identifié par `+216…` a légitimement un
   * `dto.owner.email` différent de son identifier. Comparer aveuglément rejetterait ce cas
   * pourtant valide (le lookup P2 accepte les deux formes).
   */
  private async assertAttachableOwner(dto: ProvisionTenantDto): Promise<void> {
    const user = await this.userModel.findById(dto.ownerUserId).select('identifier identifierType isActive').lean();
    if (!user) {
      throw new NotFoundException({
        code: 'OWNER_NOT_FOUND',
        message: `No account found for ownerUserId ${dto.ownerUserId} — resolve it via GET /internal/owners/lookup first.`,
      });
    }
    if (user.isActive === false) {
      throw new ConflictException({
        code: 'OWNER_INACTIVE',
        message: 'This account is deactivated — refusing to attach a new tenant to it.',
      });
    }
    if (user.identifierType === 'email') {
      const expected = normalizeIdentifier(dto.owner.email).value;
      if (user.identifier !== expected) {
        throw new BadRequestException({
          code: 'OWNER_IDENTIFIER_MISMATCH',
          message: 'ownerUserId does not match owner.email — refusing to attach this tenant to a different account.',
        });
      }
    }
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
   * [P2 owner multi-salon] "Cet email/téléphone a-t-il déjà un compte, et est-il owner
   * quelque part ?" — la brique qui manquait au CP pour proposer un rattachement AVANT de
   * provisionner, plutôt que de découvrir la collision en 409 après coup (P1).
   *
   * Trois issues distinctes, volontairement non confondues (le CP en fait 3 états d'UI) :
   *   - aucun compte              → { exists: false }                     (création classique)
   *   - compte, owner nulle part  → { exists: true, userId, ownerships: [] } (ex. un stylist)
   *   - compte owner              → { exists: true, userId, ownerships: [...] } (rattachement)
   *
   * MOINDRE EXPOSITION (même principe que le guest scope, Sprint 1) : cette route est
   * authentifiée par HMAC mais reste une route de LOOKUP D'IDENTITÉ — elle ne renvoie donc
   * ni `passwordHash` (jamais projeté), ni email/téléphone/nom, ni `staffId`, ni les
   * memberships NON-owner du user. Un user client/stylist ailleurs ressort exactement comme
   * un user sans aucun rôle : `ownerships: []`. Le CP n'a besoin de rien de plus.
   *
   * Ne réutilise délibérément PAS `InvitationService.preview()` malgré son `userExists`
   * identique : celui-ci résout un tenant par TOKEN d'invitation (flux public) et renvoie le
   * nom/rôle de l'invité — mauvais couplage et surface trop large pour un appel CP.
   *
   * `users` et `memberships` sont GLOBAL, `salons` est UNSCOPED (`scoping-registry.ts`) :
   * les trois lectures sont légitimes sans `TenantContext`, ce que `/internal/*` n'a pas
   * (routes exclues de `TenantContextMiddleware`).
   */
  async lookupOwner(rawIdentifier: string): Promise<OwnerLookupResult> {
    const { value: identifier } = normalizeIdentifier(rawIdentifier);

    const user = await this.userModel.findOne({ identifier }).select('_id').lean();
    if (!user) return { exists: false };

    const userId = (user._id as Types.ObjectId).toString();

    // `findByUser` ne renvoie QUE les memberships `status:'active'` — un accès révoqué ne
    // doit pas faire croire au CP que ce compte pilote encore un salon.
    const ownerMemberships = (await this.memberships.findByUser(userId)).filter((m) => m.role === 'owner');
    if (ownerMemberships.length === 0) return { exists: true, userId, ownerships: [] };

    // `locationLabel` n'existe pas encore sur le schéma (P4) : le projeter ici est sans effet
    // aujourd'hui et deviendra effectif sans retoucher ce code une fois le champ ajouté.
    const salons = await this.salonModel
      .find({ _id: { $in: ownerMemberships.map((m) => m.tenantId) } })
      .select('name locationLabel')
      .lean<Array<{ _id: Types.ObjectId; name?: string; locationLabel?: string }>>();
    const salonById = new Map(salons.map((s) => [s._id.toString(), s]));

    return {
      exists: true,
      userId,
      ownerships: ownerMemberships.map((m) => ({
        tenantId: m.tenantId,
        salonName: salonById.get(m.tenantId)?.name ?? '',
        locationLabel: salonById.get(m.tenantId)?.locationLabel,
      })),
    };
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
