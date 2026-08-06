import { BadRequestException, ConflictException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Invitation, InvitationDocument, InvitationStatus } from './schemas/invitation.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Staff, StaffDocument, StaffRole } from '../team/schemas/staff.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { MembershipService } from './membership.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { normalizeIdentifier } from '../auth/identifier.util';
import { runWithTenant, TenantContext, TenantRole } from '../common/tenant/tenant-context';
import { CreateInvitationDto } from './dto/invitation.dto';

const INVITATION_TTL_DAYS = 7;
const TOKEN_BYTES = 32;
const BCRYPT_ROUNDS = 10;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Même forme que dans les autres services (`bootstrapCtx` — copie locale par convention
// établie) — jamais une vraie session, juste assez pour laisser passer l'émission de
// notification (`notifications` est TENANT_SCOPED) depuis un flux public sans TenantContext.
function bootstrapCtx(salonId: string): TenantContext {
  return { tenantId: salonId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

export interface PublicInvitation {
  id: string;
  identifier: string;
  name: string;
  role: StaffRole;
  locationIds: string[];
  status: InvitationStatus;
  expiresAt: Date;
}

export interface InvitationPreview {
  tenantName: string;
  role: StaffRole;
  identifier: string;
  name: string;
  userExists: boolean;
}

/**
 * Sprint 2 v2 Prompt 5 — flux d'invitation. Réutilise `MembershipService.grant()` (Prompt 3)
 * pour la création réelle du profil staff + du membership à l'acceptation, JAMAIS
 * réimplémenté ici — `grant()` porte déjà le contrôle "un manager ne peut pas accorder le
 * rôle owner" (`assertCanGrantRole`), dont cette classe hérite gratuitement des deux côtés
 * (vérifié à la création de l'invitation ET à l'acceptation, defense in depth).
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    @InjectModel(Invitation.name) private readonly model: Model<InvitationDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly memberships: MembershipService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {}

  private toPublic(inv: InvitationDocument): PublicInvitation {
    return {
      id: (inv._id as Types.ObjectId).toString(),
      identifier: inv.identifier,
      name: inv.name,
      role: inv.role,
      locationIds: inv.locationIds,
      status: inv.status,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * `salonId`/`actingRole`/`invitedByUserId` viennent du contexte de la requête (le
   * contrôleur les résout via `currentScope()`/`@CurrentUser()`) — jamais de l'appelant lui-
   * même. `@EnforcesLimit('staffMax')` (contrôleur, `LimitGuard`) bloque AVANT même
   * d'atteindre cette méthode si le plan est déjà au maximum de staffs actifs.
   */
  async create(
    salonId: string,
    actingRole: TenantRole,
    invitedByUserId: string,
    dto: CreateInvitationDto,
  ): Promise<PublicInvitation> {
    this.memberships.assertCanGrantRole(actingRole, dto.role);

    const id = normalizeIdentifier(dto.identifier);
    const existingUser = await this.userModel.findOne({ identifier: id.value }).lean();
    if (existingUser) {
      const existingMembership = await this.memberships.findByUserAndTenant(existingUser._id.toString(), salonId);
      if (existingMembership && existingMembership.status === 'active') {
        throw new ConflictException('This person already has active access to this tenant.');
      }
    }

    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await this.model.create({
      salonId,
      identifier: id.value,
      identifierType: id.type,
      name: dto.name,
      role: dto.role,
      locationIds: dto.locationIds,
      tokenHash: hashToken(rawToken),
      expiresAt,
      status: 'pending',
      invitedBy: new Types.ObjectId(invitedByUserId),
    });

    this.logSendLink(id.value, rawToken);
    return this.toPublic(invitation);
  }

  /** "Envoi" — comme `AuthService.requestPasswordReset()` (aucun service email/SMS réel
   *  n'existe dans ce projet), le lien clair n'est JAMAIS renvoyé par l'API, seulement
   *  loggé ici en attendant une vraie intégration. */
  private logSendLink(identifier: string, rawToken: string): void {
    const link = `${process.env.FRONTEND_ORIGIN ?? ''}/accept-invite/${rawToken}`;
    this.logger.log(`[invitation] ${identifier} → ${link}`);
  }

  async list(salonId: string, status?: InvitationStatus): Promise<PublicInvitation[]> {
    const filter: Record<string, unknown> = { salonId };
    if (status) filter.status = status;
    const invitations = await this.model.find(filter).sort({ createdAt: -1 });
    return invitations.map((inv) => this.toPublic(inv));
  }

  async revoke(salonId: string, id: string): Promise<PublicInvitation> {
    const invitation = await this.model.findOne({ _id: id, salonId });
    if (!invitation) throw new NotFoundException('Invitation not found.');
    invitation.status = 'revoked';
    await invitation.save();
    return this.toPublic(invitation);
  }

  /** Rate-limité 1/min au contrôleur (`@Throttle`) — régénère un token frais (l'ancien,
   *  déjà loggé/envoyé, ne doit plus être valide) et prolonge `expiresAt`. */
  async resend(salonId: string, id: string): Promise<PublicInvitation> {
    const invitation = await this.model.findOne({ _id: id, salonId });
    if (!invitation) throw new NotFoundException('Invitation not found.');
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Cannot resend an invitation with status '${invitation.status}'.`);
    }
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    invitation.tokenHash = hashToken(rawToken);
    invitation.expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await invitation.save();
    this.logSendLink(invitation.identifier, rawToken);
    return this.toPublic(invitation);
  }

  /**
   * Lecture par TOKEN, pas par tenant — le tenant n'est PAS encore connu (flux public, même
   * chicken-and-egg que `login()`). `invitations` est TENANT_SCOPED (`scoping-registry.ts`),
   * donc driver Mongo natif ici (bypasse le plugin), exactement comme `login()`/`loginPin()`
   * lisent `staffs`/`clients` sans contexte — voir leurs docstrings pour la justification
   * complète de ce pattern, déjà établi ce sprint.
   *
   * Expiration paresseuse : si `status` est encore `'pending'` mais `expiresAt` est dépassé
   * (l'index TTL de MongoDB tourne au mieux toutes les 60s, jamais fiable pour une réponse
   * HTTP immédiate), le statut est corrigé en base ICI avant de renvoyer 410 — ainsi le
   * prochain lecteur (y compris `list()`) voit un statut cohérent, pas seulement cette
   * réponse-ci.
   */
  private async findValidByToken(rawToken: string): Promise<InvitationDocument> {
    const tokenHash = hashToken(rawToken);
    const raw = await this.connection.collection('invitations').findOne({ tokenHash });
    if (!raw) throw new NotFoundException('Invitation not found.');

    // Le chargement ET l'éventuel `.save()` d'expiration paresseuse DOIVENT rester DANS le
    // même callback `runWithTenant` — du code après un `await runWithTenant(...)` s'exécute
    // hors de son contexte (l'ALS s'est déjà dénoué), le `.save()` y échouerait ("No tenant
    // context available"), piège déjà revu ailleurs dans ce sprint mais qui touche ici la
    // FIN d'un await, pas une Query lazy sans `.exec()`.
    const invitation = await runWithTenant(bootstrapCtx(raw.salonId as string), async () => {
      const found = await this.model.findById(raw._id).exec();
      if (!found) return null;
      if (found.status === 'pending' && found.expiresAt.getTime() < Date.now()) {
        found.status = 'expired';
        await found.save();
      }
      return found;
    });
    if (!invitation) throw new NotFoundException('Invitation not found.');
    if (invitation.status !== 'pending') {
      throw new GoneException(`This invitation is ${invitation.status}.`);
    }
    return invitation;
  }

  async preview(rawToken: string): Promise<InvitationPreview> {
    const invitation = await this.findValidByToken(rawToken);
    const salon = await this.salonModel.findById(invitation.salonId).select('name').lean();
    const userExists = !!(await this.userModel.findOne({ identifier: invitation.identifier }).select('_id').lean());
    return {
      tenantName: salon?.name ?? '',
      role: invitation.role,
      identifier: invitation.identifier,
      name: invitation.name,
      userExists,
    };
  }

  /**
   * Transaction : créer le User si absent (sinon réutiliser — cas cross-tenant, Option B
   * côté staff) → `MembershipService.grant()` (profil Staff + Membership) → marquer
   * l'invitation acceptée. Rollback complet si une étape échoue (`session.withTransaction`).
   * `actingRole:'owner'` passé à `grant()` : le contrôle manager-ne-peut-pas-owner a déjà eu
   * lieu à la CRÉATION de l'invitation (`create()` ci-dessus, via `assertCanGrantRole`) — ce
   * paramètre ne fait que confirmer qu'aucune régression ne laisserait passer un rôle non
   * autorisé, jamais une seconde autorisation métier.
   */
  async accept(rawToken: string, password: string | undefined): Promise<{ token: string; user: { id: string; name: string; role: StaffRole; salonId: string } }> {
    const invitation = await this.findValidByToken(rawToken);
    const existingUser = await this.userModel.findOne({ identifier: invitation.identifier });
    if (!existingUser && !password) {
      throw new BadRequestException('A password is required for a new account.');
    }

    const session = await this.connection.startSession();
    let userId!: string;
    let staffId!: string;
    try {
      await session.withTransaction(async () => {
        let user = existingUser;
        if (!user) {
          const passwordHash = await bcrypt.hash(password!, BCRYPT_ROUNDS);
          const [created] = await this.userModel.create(
            [{ identifier: invitation.identifier, identifierType: invitation.identifierType, passwordHash, role: 'staff', isActive: true }],
            { session },
          );
          user = created;
        }
        userId = (user._id as Types.ObjectId).toString();

        const membership = await this.memberships.grant(
          'owner',
          {
            userId,
            tenantId: invitation.salonId,
            role: invitation.role,
            locationIds: invitation.locationIds,
            name: invitation.name,
          },
          session,
        );
        staffId = membership.staffId!.toString();

        await this.connection.collection('invitations').updateOne(
          { _id: invitation._id },
          { $set: { status: 'accepted', acceptedAt: new Date(), membershipId: membership._id } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    const token = await this.auth.issueTokenForUser(userId);

    // Persister PUIS émettre (#7) — déjà garanti par NotificationsService.dispatch() lui-
    // même ; ce wrapper `runWithTenant` fournit juste le TenantContext que son écriture
    // Mongoose (`notifications`, TENANT_SCOPED) exige, absent ici (flux public, pas de JWT).
    await runWithTenant(bootstrapCtx(invitation.salonId), () =>
      this.notifications.dispatch({
        salonId: invitation.salonId,
        role: 'owner',
        type: SOCKET_EVENTS.STAFF_JOINED,
        title: 'New team member',
        body: `${invitation.name} joined as ${invitation.role}.`,
        payload: { staffId, name: invitation.name, role: invitation.role },
      }),
    );
    await runWithTenant(bootstrapCtx(invitation.salonId), () =>
      this.notifications.dispatch({
        salonId: invitation.salonId,
        role: 'manager',
        type: SOCKET_EVENTS.STAFF_JOINED,
        title: 'New team member',
        body: `${invitation.name} joined as ${invitation.role}.`,
        payload: { staffId, name: invitation.name, role: invitation.role },
      }),
    );

    return { token, user: { id: staffId, name: invitation.name, role: invitation.role, salonId: invitation.salonId } };
  }
}
