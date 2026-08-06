import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from './schemas/user.schema';
import { Staff, StaffDocument, StaffRole } from '../team/schemas/staff.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { ClientProfileService } from '../identity/client-profile.service';
import { ListedMembership, MembershipService } from '../identity/membership.service';
import { AuthTokenPayload, AuthUser, MembershipClaim, Role } from '../common/decorators/current-user.decorator';
import { normalizeIdentifier } from './identifier.util';
import { runWithTenant, TenantContext } from '../common/tenant/tenant-context';
import { LocationService } from '../locations/location.service';
import { EmailService } from '../email/email.service';
import { passwordResetEmailHtml } from '../email/templates';
import { RESET_PURPOSE, ResetPayload, mintResetToken, resetPasswordLink } from './reset-token.util';
import {
  ChangePasswordDto,
  CreateStaffAuthDto,
  LoginDto,
  LoginPinDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  PosTokenPayload,
  RegisterDto,
  UpdateMeDto,
} from './dto/auth.dto';

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL = '1h';

export interface PublicUser {
  id: string;
  salonId: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  color?: string;
  isActive: boolean;
  registered: boolean;
  accountType: 'staff' | 'client';
  staffId?: string;
  clientId?: string;
}

/**
 * Formes minimales lues via le driver Mongo natif (`connection.collection(...)`), PAS via
 * les modèles Mongoose `staffModel`/`clientModel` — voir docstring de `login()` pour la
 * raison structurelle. Champs = uniquement ce que `toPublicFrom*`/`issueToken` consomment.
 */
interface StaffLoginRow {
  _id: Types.ObjectId;
  salonId: string;
  name: string;
  email?: string;
  phone?: string;
  role: StaffRole;
  color?: string;
}
interface ClientLoginRow {
  _id: Types.ObjectId;
  salonId: string;
  name: string;
  email?: string;
  phone: string;
}
interface StaffPinRow {
  _id: Types.ObjectId;
  salonId: string;
  name: string;
  color?: string;
  role: StaffRole;
  isActive: boolean;
  posEnabled: boolean;
  pinHash?: string;
  pinAttempts?: number;
  pinLockedUntil?: Date;
}

/**
 * Contexte de bootstrap une fois le tenant connu (par lecture native pour `loginPin`, par
 * `resolveSalonId()` — UNSCOPED, donc sans lookup scopé — pour `register`). Même forme que
 * `bootstrapCtx()` dans `internal.service.ts` : jamais une vraie session, juste assez pour
 * que le plugin de scope tenant laisse passer les écritures/lectures Mongoose qui suivent.
 */
function bootstrapCtx(tenantId: string): TenantContext {
  return { tenantId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name)         private readonly userModel:     Model<UserDocument>,
    @InjectModel(Staff.name)        private readonly staffModel:    Model<StaffDocument>,
    @InjectModel(Schedule.name)     private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel:  Model<StaffProfileDocument>,
    @InjectModel(Client.name)       private readonly clientModel:   Model<ClientDocument>,
    @InjectModel(Salon.name)        private readonly salonModel:    Model<SalonDocument>,
    @InjectConnection()             private readonly connection:    Connection,
    private readonly jwt: JwtService,
    private readonly clientProfiles: ClientProfileService,
    private readonly memberships: MembershipService,
    private readonly locations: LocationService,
    private readonly email: EmailService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private toPublicFromStaff(user: UserDocument, staff: StaffLoginRow): PublicUser {
    return {
      id:          user._id.toString(),
      salonId:     staff.salonId.toString(),
      name:        staff.name,
      email:       staff.email ?? '',
      phone:       staff.phone ?? '',
      role:        staff.role as Role,
      color:       staff.color,
      isActive:    user.isActive,
      registered:  true,
      accountType: 'staff',
      staffId:     staff._id.toString(),
    };
  }

  private toPublicFromClient(user: UserDocument, client: ClientLoginRow): PublicUser {
    return {
      id:          user._id.toString(),
      salonId:     client.salonId.toString(),
      name:        client.name,
      email:       client.email ?? '',
      phone:       client.phone,
      role:        'client',
      isActive:    user.isActive,
      registered:  true,
      accountType: 'client',
      clientId:    client._id.toString(),
    };
  }

  /**
   * Sprint 2 v2 Prompt 2 : le JWT ne porte plus `salonId`/`role` figés — il porte
   * `memberships[]` (une entrée par tenant actif de ce user), et le tenant ACTIF est
   * résolu PAR REQUÊTE par `TenantContextMiddleware`, jamais gravé ici. `JWT_EXPIRES`
   * reste 7j pour ce sprint (décision explicite — pas de refresh token, reporté au
   * Sprint 3 avec le reste de l'infra auth : access court + refresh + rotation).
   *
   * Lit `MembershipService.findByUser()` (PAS la version cachée `findByUserCached` — on
   * émet un token neuf, on veut l'état le plus frais possible, pas une entrée de cache
   * qui pourrait dater de jusqu'à 60s). Le login()/register()/createStaff() appelants
   * DOIVENT avoir déjà créé le Membership correspondant avant d'appeler ceci, sous peine
   * d'émettre un token à `memberships: []` — voir leurs docstrings respectives.
   */
  private async issueToken(userId: string): Promise<string> {
    const active = await this.memberships.findByUser(userId);
    const claims: MembershipClaim[] = active.map((m) => ({
      tenantId: m.tenantId,
      role: m.role as Role,
      staffId: m.staffId?.toString(),
      clientId: m.clientId?.toString(),
      locationIds: m.locationIds,
      defaultLocationId: m.defaultLocationId,
    }));
    const payload: AuthTokenPayload = { sub: userId, memberships: claims };
    return this.jwt.sign(payload);
  }

  /** Wrapper public de `issueToken()` — Sprint 2 v2 Prompt 5 : `InvitationService.accept()`
   *  émet une session tout comme `login()`/`register()`, une fois le Membership créé via
   *  `MembershipService.grant()`. Même émission, pas une logique dupliquée. */
  async issueTokenForUser(userId: string): Promise<string> {
    return this.issueToken(userId);
  }

  /**
   * Sprint 2 v2 Prompt 4 — remplace l'ancien fallback `DEFAULT_SALON_ID`/premier salon créé
   * (résidu mono-tenant d'avant Sprint 1 v2, signalé mais volontairement pas traité au
   * Prompt 2 — voir la docstring de `register()`). `candidateSlug` vient de
   * `AuthController` : sous-domaine du Host en priorité (`extractTenantSlugFromHost`),
   * sinon `RegisterDto.salonSlug` explicite. AUCUN fallback silencieux : slug absent ou
   * salon introuvable/inactif → 404 propre, jamais un rattachement au mauvais tenant.
   */
  private async resolveSalonId(candidateSlug?: string): Promise<string> {
    if (!candidateSlug) throw new NotFoundException('Salon not specified.');
    const salon = await this.salonModel.findOne({ slug: candidateSlug, status: 'active' }).select('_id').lean();
    if (!salon) throw new NotFoundException('Salon not found.');
    return (salon._id as Types.ObjectId).toString();
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  /**
   * `login()` s'exécute structurellement AVANT qu'un tenant ne soit connu — c'est
   * précisément son rôle (déterminer à quel salon ce compte appartient). Le lookup
   * staff/client par `userId` passe donc par le driver Mongo natif
   * (`connection.collection(...)`), qui ne passe PAS par le plugin de scope tenant
   * Mongoose. Trouvé le 2026-08-01 : `this.staffModel.findOne(...)`/`this.clientModel
   * .findOne(...)` faisaient 500 systématique ("No tenant context available"), car
   * `staffs`/`clients` sont TENANT_SCOPED et aucun `runWithTenant` ne les enveloppait
   * — ni le middleware (qui ne pose de contexte qu'APRÈS un JWT valide, donc jamais
   * sur /auth/login), ni cette méthode. 4e occurrence du même type d'oubli que
   * Prompt 4/7/9 (voir `tenant-context.middleware.ts`), jamais couverte par
   * `auth-by-role.spec.ts` car cette suite signe des JWT directement au lieu
   * d'appeler /auth/login. ⚠️ NE PAS remplacer par `runOutsideTenant` : sa docstring
   * l'interdit explicitement en flux HTTP normal — le driver natif est la bonne
   * couche ici, pas un contournement du plugin.
   */
  async login(dto: LoginDto): Promise<{ token: string; user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);
    const user = await this.userModel.findOne({ identifier: id.value });
    if (!user) throw new UnauthorizedException('Identifiants invalides.');
    if (!user.isActive) throw new UnauthorizedException('This account is disabled.');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Identifiants invalides.');

    await this.userModel.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

    const userId = (user._id as Types.ObjectId).toString();
    if (user.role === 'client') {
      const client = await this.connection.collection('clients').findOne<ClientLoginRow>({ userId: user._id });
      if (!client) throw new UnauthorizedException('Client profile not found.');
      return { token: await this.issueToken(userId), user: this.toPublicFromClient(user, client) };
    }

    const staff = await this.connection.collection('staffs').findOne<StaffLoginRow>({ userId: user._id });
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    return { token: await this.issueToken(userId), user: this.toPublicFromStaff(user, staff) };
  }

  // ─── PIN login (kiosk / POS scope) ──────────────────────────────────────────

  /**
   * Même famille de bug que `login()` (voir sa docstring) : `staffId` seul ne révèle le
   * tenant qu'en lisant `staffs` (TENANT_SCOPED) — chicken-and-egg réel, donc lecture
   * initiale via le driver Mongo natif, comme `login()`. Différence avec `login()` : ici
   * le tenant EST connu juste après cette lecture (`staffRow.salonId`), et le reste de la
   * méthode fait des écritures (`pinAttempts`/`pinLockedUntil`) — ces écritures repassent
   * par `staffModel` sous `runWithTenant(bootstrapCtx(...))`, pas par le driver natif, pour
   * garder les hooks/validation Mongoose dès que ça redevient possible (même logique que
   * `register()`, voir sa docstring).
   */
  async loginPin(dto: LoginPinDto): Promise<{
    token: string;
    staff: { id: string; name: string; first: string; color: string };
  }> {
    const staffRow = await this.connection.collection('staffs').findOne<StaffPinRow>(
      { _id: new Types.ObjectId(dto.staffId) },
      { projection: { salonId: 1, name: 1, color: 1, role: 1, isActive: 1, posEnabled: 1, pinHash: 1, pinAttempts: 1, pinLockedUntil: 1 } },
    );

    if (!staffRow || !staffRow.isActive || !staffRow.posEnabled) {
      throw new UnauthorizedException('Staff not found or not POS-enabled.');
    }

    return runWithTenant(bootstrapCtx(staffRow.salonId), async () => {
      const now = new Date();
      if (staffRow.pinLockedUntil && staffRow.pinLockedUntil > now) {
        const secondsLeft = Math.ceil((staffRow.pinLockedUntil.getTime() - now.getTime()) / 1000);
        throw new UnauthorizedException(`Too many attempts. Try again in ${secondsLeft}s.`);
      }

      if (!staffRow.pinHash) {
        throw new UnauthorizedException('PIN not configured. Contact your manager.');
      }

      const ok = await bcrypt.compare(dto.pin, staffRow.pinHash);

      if (!ok) {
        const newAttempts = (staffRow.pinAttempts ?? 0) + 1;
        const update: Record<string, unknown> = { pinAttempts: newAttempts };
        if (newAttempts >= 5) {
          update.pinLockedUntil = new Date(now.getTime() + 30_000);
          update.pinAttempts = 0;
        }
        await this.staffModel.updateOne({ _id: staffRow._id }, { $set: update });
        throw new UnauthorizedException('Wrong PIN.');
      }

      await this.staffModel.updateOne(
        { _id: staffRow._id },
        { $set: { pinAttempts: 0 }, $unset: { pinLockedUntil: '' } },
      );

      const salonId = staffRow.salonId.toString();
      const payload: PosTokenPayload = { staffId: staffRow._id.toString(), salonId, scope: 'pos', role: staffRow.role };
      const token = this.jwt.sign(payload, { expiresIn: '12h' });

      return {
        token,
        staff: {
          id:    staffRow._id.toString(),
          name:  staffRow.name,
          first: staffRow.name.split(' ')[0],
          color: staffRow.color ?? '#B89968',
        },
      };
    });
  }

  // ─── Register client (public, self-service) ──────────────────────────────────

  /**
   * Même famille de bug que `login()`/`loginPin()` (voir leurs docstrings), mais résolu
   * différemment ici : `resolveSalonId()` ne lit QUE `salons` (UNSCOPED — pas de lookup
   * scopé requis), donc le tenant est réellement connu AVANT tout accès à `clients`
   * (TENANT_SCOPED) — pas de chicken-and-egg. Le driver natif n'est donc pas nécessaire :
   * tout ce qui suit `resolveSalonId()` tourne sous `runWithTenant(bootstrapCtx(salonId))`,
   * qui garde les modèles Mongoose (hooks/validation) intacts — seul `login()`/`loginPin()`
   * ont un besoin réel de driver natif (tenant non déductible sans lire la ligne scopée).
   *
   * Sprint 2 v2 Prompt 4 : `candidateSlug` (résolu par `AuthController` — sous-domaine du
   * Host en priorité, sinon `dto.salonSlug` explicite) remplace l'ancien fallback
   * `DEFAULT_SALON_ID`/premier salon créé, qui rattachait TOUT client au même salon choisi
   * arbitrairement dès qu'il y avait plus d'un tenant. Le merge-on-phone
   * (`clientModel.findOne({salonId, phone})` ci-dessous) reste scopé à CE tenant — c'était
   * déjà correct, seul `salonId` lui-même pouvait être le mauvais.
   *
   * Sprint 2 v2 Prompt 2 : crée désormais AUSSI le Membership `kind='client'` (même forme
   * que `migrate-create-memberships.ts` Phase 2 — toutes les locations actives du tenant,
   * `defaultLocationId` = la primaire) AVANT d'émettre le token. Sans ça, le client
   * fraîchement inscrit recevrait un token à `memberships: []` et se ferait immédiatement
   * rejeter (400 TENANT_REQUIRED) à sa toute première requête authentifiée.
   */
  async register(dto: RegisterDto, candidateSlug?: string): Promise<{ token: string; user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);
    const phone = normalizeIdentifier(dto.phone).value;
    const salonId = await this.resolveSalonId(candidateSlug);

    const existing = await this.userModel.findOne({ identifier: id.value });
    if (existing) throw new ConflictException('An account with this identifier already exists.');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.userModel.create({
      identifier: id.value,
      identifierType: id.type,
      passwordHash,
      role: 'client',
      isActive: true,
    });
    const userId = (user._id as Types.ObjectId).toString();

    const client = await runWithTenant(bootstrapCtx(salonId), async () => {
      let client = await this.clientModel.findOne({ salonId, phone });
      if (client) {
        client.userId = user._id as Types.ObjectId;
        if (dto.email && !client.email) client.email = dto.email.toLowerCase();
        await client.save();
      } else {
        client = await this.clientModel.create({
          salonId,
          userId: user._id,
          name: dto.name,
          phone,
          email: dto.email?.toLowerCase() ?? '',
        });
      }
      if (!client.profileId) {
        await this.clientProfiles.attachProfile(salonId, (client._id as Types.ObjectId).toString(), client.phone, {
          name: client.name,
          email: client.email,
          userId,
        });
      }
      return client;
    });

    const existingMembership = await this.memberships.findByUserAndTenant(userId, salonId);
    if (!existingMembership) {
      const tenantLocations = await runWithTenant(bootstrapCtx(salonId), () => this.locations.findAllForTenant({ salonId }));
      const primary = tenantLocations.find((l) => l.isPrimary) ?? tenantLocations[0];
      await this.memberships.create({
        userId,
        tenantId: salonId,
        kind: 'client',
        clientId: (client._id as Types.ObjectId).toString(),
        role: 'client',
        locationIds: tenantLocations.map((l) => (l._id as Types.ObjectId).toString()),
        defaultLocationId: primary ? (primary._id as Types.ObjectId).toString() : undefined,
      });
    }

    return { token: await this.issueToken(userId), user: this.toPublicFromClient(user, client) };
  }

  // ─── Create staff (OWNER only) ───────────────────────────────────────────────

  /**
   * Sprint 2 v2 Prompt 2 : crée désormais AUSSI le Membership `kind='staff'` du nouveau
   * compte — sans ça, il n'aurait `memberships: []` à son premier login (400
   * TENANT_REQUIRED immédiat). `locationIds`/`defaultLocationId` du Membership reprennent
   * ceux du profil Staff fraîchement créé (vides par défaut ici, `CreateStaffAuthDto` n'en
   * porte pas — comportement inchangé, pas une régression de ce prompt).
   */
  async createStaff(salonId: string, dto: CreateStaffAuthDto): Promise<{ user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);

    const existing = await this.userModel.findOne({ identifier: id.value });
    if (existing) throw new ConflictException('An account with this identifier already exists.');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const userDoc = await this.userModel.create({
      identifier: id.value,
      identifierType: id.type,
      passwordHash,
      role: 'staff',
      isActive: true,
    });

    const staff = await this.staffModel.create({
      salonId,
      userId: userDoc._id,
      name: dto.name,
      email: dto.email?.toLowerCase().trim() ?? '',
      phone: dto.phone ?? '',
      role: dto.role,
      color: dto.color ?? '#B89968',
      isActive: true,
      week: [],
    });

    await this.scheduleModel.updateOne(
      { salonId, stylistId: staff._id },
      { $setOnInsert: { weekly: [], overrides: [] } },
      { upsert: true },
    );

    if (['stylist', 'colorist'].includes(dto.role) || dto.level || dto.capabilities || dto.baseRate != null || dto.commissionPct != null) {
      await this.profileModel.create({
        salonId,
        userId: staff._id,
        level: dto.level ?? 'senior',
        capabilities: dto.capabilities ?? [],
        baseRate: dto.baseRate ?? 0,
        commissionPct: dto.commissionPct ?? 0,
      });
    }

    await this.memberships.create({
      userId: (userDoc._id as Types.ObjectId).toString(),
      tenantId: salonId,
      kind: 'staff',
      staffId: (staff._id as Types.ObjectId).toString(),
      role: dto.role,
      locationIds: staff.locationIds ?? [],
      defaultLocationId: staff.defaultLocationId,
    });

    return { user: this.toPublicFromStaff(userDoc, staff) };
  }

  // ─── Me ─────────────────────────────────────────────────────────────────────

  async me(auth: AuthUser): Promise<PublicUser> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');

    // Sprint 2 v2 : `auth.accountType` vient du Membership ACTIF résolu par
    // `TenantContextMiddleware` pour CE tenant — pas `user.role` (global, figé au
    // signup). Un même compte peut être staff sur un tenant et client sur un autre ;
    // brancher sur `user.role` renverrait 401 pour la moitié de ces cas.
    if (auth.accountType === 'client') {
      const client = await this.clientModel.findById(auth.clientId);
      if (!client) throw new UnauthorizedException('Client profile not found.');
      return this.toPublicFromClient(user, client);
    }

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    return this.toPublicFromStaff(user, staff);
  }

  async updateMe(auth: AuthUser, dto: UpdateMeDto): Promise<PublicUser> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');

    if (auth.accountType === 'client') {
      const client = await this.clientModel.findById(auth.clientId);
      if (!client) throw new UnauthorizedException('Client profile not found.');
      if (dto.name !== undefined) client.name = dto.name;
      if (dto.email !== undefined) client.email = dto.email.toLowerCase();
      await client.save();
      return this.toPublicFromClient(user, client);
    }

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    if (dto.name !== undefined) staff.name = dto.name;
    if (dto.email !== undefined) {
      const taken = await this.staffModel.findOne({
        salonId: staff.salonId,
        email: dto.email.toLowerCase(),
        _id: { $ne: staff._id },
      });
      if (taken) throw new ConflictException('This email is already in use.');
      staff.email = dto.email.toLowerCase();
    }
    if (dto.phone !== undefined) staff.phone = dto.phone;
    await staff.save();
    return this.toPublicFromStaff(user, staff);
  }

  // ─── Memberships (Sprint 2 v2 Prompt 3) ───────────────────────────────────────

  /** Liste des tenants du user courant — alimente le tenant switcher (Prompt 6). */
  async listMemberships(auth: AuthUser): Promise<ListedMembership[]> {
    return this.memberships.listForUser(auth.sub);
  }

  /**
   * Valide que le tenant demandé fait partie des memberships ACTIFS du user (relu frais,
   * jamais depuis le cache 60s ni le JWT) puis réémet un token. Le JWT ne fige plus un
   * tenant actif (Prompt 2 — `memberships[]` porte TOUS les tenants, `X-Tenant-Id` sélectionne
   * par requête) : "switcher" ne change donc rien AU TOKEN lui-même, mais confirme l'accès et
   * renvoie les infos du tenant choisi pour que le frontend les persiste et les envoie en
   * header sur les requêtes suivantes (authStore, Prompt 6).
   */
  async switchTenant(auth: AuthUser, tenantId: string): Promise<{ token: string; tenantId: string; role: string; locationIds: string[]; defaultLocationId?: string }> {
    const membership = await this.memberships.findByUserAndTenant(auth.sub, tenantId);
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException('No active membership for this tenant.');
    }
    return {
      token: await this.issueToken(auth.sub),
      tenantId: membership.tenantId,
      role: membership.role,
      locationIds: membership.locationIds,
      defaultLocationId: membership.defaultLocationId,
    };
  }

  // ─── Password ────────────────────────────────────────────────────────────────

  async changePassword(auth: AuthUser, dto: ChangePasswordDto): Promise<void> {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException("Le nouveau mot de passe doit être différent de l'actuel.");
    }
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Mot de passe actuel incorrect.');
    user.passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await user.save();
  }

  /**
   * Sprint 2 v2 Prompt 3 — décision de design signalée (question laissée ouverte par le
   * Prompt 2) : SCOPÉ AU TENANT ACTIF, pas global à l'identité. "Se désactiver" depuis le
   * contexte du tenant B ne doit PAS couper l'accès à un tenant A où le même user est
   * staff/owner (exactement le scénario qu'Option B vient d'ouvrir) — l'ancien comportement
   * mettait `users.isActive=false`, un kill-switch global, sur un simple geste local.
   * `changePassword()` reste global, lui, SANS choix possible : il n'y a qu'un seul
   * `passwordHash` par identité (`users`), pas un par membership — rien à scoper.
   *
   * Révoque le membership du tenant ACTIF (`MembershipService.revoke()`, hérite donc
   * automatiquement de la protection LAST_OWNER — un owner seul ne peut pas se retirer lui-
   * même), désactive le profil staff/client DE CE TENANT uniquement. `users.isActive`
   * n'est plus touché ici — ce kill-switch global reste réservé à une future action admin,
   * pas ce flux self-service.
   */
  async deactivateMe(auth: AuthUser): Promise<void> {
    const membership = await this.memberships.findByUserAndTenant(auth.sub, auth.salonId);
    if (!membership) throw new UnauthorizedException('No active membership on this tenant.');

    await this.memberships.revoke(membership._id.toString()); // throws ConflictException LAST_OWNER if applicable

    // `clients` n'a pas de champ isActive (rien d'autre à faire — revoke() suffit : le
    // client ne résout plus ce tenant, `TenantContextMiddleware` le rejette désormais).
    if (auth.accountType === 'client') return;

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    staff.isActive = false;
    staff.acceptingBookings = false;
    await staff.save();
  }

  async updateExpoPushToken(auth: AuthUser, expoPushToken?: string | null): Promise<void> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    if (expoPushToken) user.expoPushToken = expoPushToken;
    else user.expoPushToken = undefined;
    await user.save();
  }

  // Toujours { sent: true }, que le compte existe ou non (ne révèle jamais si un identifiant
  // est enregistré) — un échec d'envoi réel (SMTP down) est loggé, jamais renvoyé au client,
  // pour la même raison : ne pas laisser un attaquant distinguer "compte inconnu" de "email
  // parti" de "email a échoué" par la forme de la réponse.
  async requestPasswordReset(dto: PasswordResetRequestDto): Promise<{ sent: boolean }> {
    const id = normalizeIdentifier(dto.identifier);
    const user = await this.userModel.findOne({ identifier: id.value, isActive: true });
    if (user) {
      const token = mintResetToken(this.jwt, user._id.toString(), RESET_TOKEN_TTL);
      const link = resetPasswordLink(token);
      this.logger.log(`[password-reset] ${user.role} ${id.value} → ${link}`);
      if (id.type === 'email') {
        try {
          await this.email.sendEmail({
            to: id.value,
            subject: 'Réinitialisez votre mot de passe SalonOS',
            html: passwordResetEmailHtml({ resetUrl: link }),
          });
        } catch (err) {
          this.logger.error(`[password-reset] Email send failed for ${id.value}: ${(err as Error).message}`);
        }
      } else {
        this.logger.warn(`[password-reset] Identifier ${id.value} is a phone number — no email channel, link only logged.`);
      }
    }
    return { sent: true };
  }

  async confirmPasswordReset(dto: PasswordResetConfirmDto): Promise<{ reset: boolean }> {
    let payload: ResetPayload;
    try {
      payload = this.jwt.verify<ResetPayload>(dto.token);
    } catch {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    if (payload.purpose !== RESET_PURPOSE) throw new BadRequestException('Invalid reset token.');

    const user = await this.userModel.findById(payload.sub);
    if (!user) throw new BadRequestException('Invalid reset token.');
    user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await user.save();
    return { reset: true };
  }
}
