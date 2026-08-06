import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Membership, MembershipDocument, MembershipRole } from './schemas/membership.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { LocationService } from '../locations/location.service';
import { MemoryCache } from '../common/utils/memory-cache.util';
import { runOutsideTenant, runWithTenant, TenantContext } from '../common/tenant/tenant-context';
import type { TenantRole } from '../common/tenant/tenant-context';

const CACHE_TTL_MS = 60_000;
const cacheKey = (userId: string): string => `mbr:${userId}`;

// Même forme que `bootstrapCtx()` dans `internal.service.ts`/`auth.service.ts` (chacun a sa
// propre copie locale, par convention établie) — jamais une vraie session, juste assez pour
// que le plugin de scope tenant laisse passer les écritures/lectures Mongoose sur `staffs`.
function bootstrapCtx(tenantId: string): TenantContext {
  return { tenantId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

export interface CreateMembershipInput {
  userId: string;
  tenantId: string;
  kind: 'staff' | 'client';
  staffId?: string;
  clientId?: string;
  role: Membership['role'];
  locationIds: string[];
  defaultLocationId?: string;
  status?: Membership['status'];
}

export interface ListedMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
  locationIds: string[];
  defaultLocationId?: string;
  status: Membership['status'];
}

export interface GrantMembershipInput {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  locationIds: string[];
  defaultLocationId?: string;
  /** Rattache un profil staff EXISTANT dans ce tenant plutôt que d'en créer un. Rare — le cas
   *  courant (Option B) n'en fournit pas, `grant()` crée alors un nouveau profil. */
  staffId?: string;
  clientId?: string;
  /** Utilisés seulement quand un nouveau profil staff est créé (`kind='staff'`, `staffId`
   *  absent) — `users` n'a pas de champ `name` (identité = login uniquement), donc pas de
   *  valeur à "reprendre du user" comme le décrit le SKILL littéralement. À défaut fournis,
   *  on les reprend du profil staff EXISTANT le plus ancien de ce user (autre tenant), qui
   *  est la meilleure source plausible pour Option B (même personne, nouveau tenant). */
  name?: string;
  email?: string;
  phone?: string;
}

/**
 * `memberships` est GLOBAL (`scoping-registry.ts`) — exempté du plugin de scope tenant,
 * donc lisible cross-tenant par `userId` sans contexte. C'est le point : résoudre TOUS les
 * tenants d'un user. Toute méthode filtrant par tenant le fait EXPLICITEMENT ici (jamais
 * une injection automatique du plugin, puisqu'il ne s'applique pas à cette collection).
 */
@Injectable()
export class MembershipService {
  // Stand-in Redis provisoire (même pattern qu'EntitlementsService/DiscoveryService,
  // Sprint 1 v2) — clé `mbr:{userId}`, TTL 60s. C'est CE cache que
  // `TenantContextMiddleware` interroge à chaque requête pour résoudre le tenant actif :
  // le JWT (valide 7j, pas de refresh ce sprint) ne fait plus foi seul, la base (via ce
  // cache) reste la source de vérité — une révocation/updateLocations se propage en ≤60s.
  private readonly cache = new MemoryCache();

  constructor(
    @InjectModel(Membership.name) private readonly model: Model<MembershipDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    private readonly locations: LocationService,
  ) {}

  async findByUser(userId: string): Promise<MembershipDocument[]> {
    return this.model.find({ userId: new Types.ObjectId(userId), status: 'active' }).exec();
  }

  /** Version cachée de `findByUser` — c'est celle-ci que le middleware doit appeler. */
  async findByUserCached(userId: string): Promise<MembershipDocument[]> {
    return this.cache.getOrSet(cacheKey(userId), CACHE_TTL_MS, () => this.findByUser(userId));
  }

  invalidateCache(userId: string): void {
    this.cache.delete(cacheKey(userId));
  }

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipDocument | null> {
    return this.model.findOne({ userId: new Types.ObjectId(userId), tenantId }).exec();
  }

  async findByTenant(tenantId: string): Promise<MembershipDocument[]> {
    return this.model.find({ tenantId }).exec();
  }

  /** `staffId` référence au plus un Membership (index `{staffId}` non-unique mais en
   *  pratique 1:1 — un profil staff = un seul membership). Le tenant n'est PAS vérifié ici
   *  (memberships est GLOBAL) — c'est la responsabilité de l'appelant (voir
   *  `TeamService.membershipForStaffInTenant`). */
  async findByStaffId(staffId: string): Promise<MembershipDocument | null> {
    return this.model.findOne({ staffId: new Types.ObjectId(staffId) }).exec();
  }

  /** Liste des tenants d'un user, enrichie du nom/slug salon — pour le tenant switcher
   *  (Prompt 6, frontend). Actifs uniquement (même filtre que `findByUser`). */
  async listForUser(userId: string): Promise<ListedMembership[]> {
    const active = await this.findByUser(userId);
    if (active.length === 0) return [];
    const salons = await this.salonModel
      .find({ _id: { $in: active.map((m) => m.tenantId) } })
      .select('name slug')
      .lean();
    const salonById = new Map(salons.map((s) => [(s._id as Types.ObjectId).toString(), s]));
    return active.map((m) => {
      const salon = salonById.get(m.tenantId);
      return {
        tenantId: m.tenantId,
        tenantName: salon?.name ?? '',
        tenantSlug: salon?.slug ?? '',
        role: m.role,
        locationIds: m.locationIds,
        defaultLocationId: m.defaultLocationId,
        status: m.status,
      };
    });
  }

  async create(input: CreateMembershipInput, session?: ClientSession): Promise<MembershipDocument> {
    const [created] = await this.model.create(
      [
        {
          userId: new Types.ObjectId(input.userId),
          tenantId: input.tenantId,
          kind: input.kind,
          staffId: input.staffId ? new Types.ObjectId(input.staffId) : undefined,
          clientId: input.clientId ? new Types.ObjectId(input.clientId) : undefined,
          role: input.role,
          locationIds: input.locationIds,
          defaultLocationId: input.defaultLocationId,
          status: input.status ?? 'active',
        },
      ],
      { session },
    );
    this.invalidateCache(input.userId);
    return created;
  }

  /**
   * Seul un owner peut accorder `role:'owner'`. Extrait de `grant()` (Sprint 2 v2 Prompt 3)
   * pour être réutilisé TEL QUEL par `InvitationService.create()` (Prompt 5) — la même règle
   * s'applique à la création d'une invitation `role='owner'`, pas seulement à `grant()` lui-
   * même, sans dupliquer la condition à deux endroits.
   */
  assertCanGrantRole(actingRole: TenantRole, role: MembershipRole): void {
    if (role === 'owner' && actingRole !== 'owner') {
      throw new ForbiddenException('Only an owner can grant owner access.');
    }
  }

  /**
   * Sprint 2 v2 Prompt 3 (Option B) — donne à un user un membership sur un NOUVEAU tenant.
   * Extension pure (décision #8 du SKILL) : ne déplace JAMAIS un profil staff existant,
   * en crée toujours un nouveau dans le tenant cible si `staffId` n'est pas fourni.
   *
   * `actingRole` = rôle de l'appelant sur SON tenant actif (jamais celui du tenant cible,
   * qu'il n'a par définition pas encore) — seul un owner peut accorder `role:'owner'`.
   * Appelé directement (Prompt 3, pas d'endpoint HTTP dédié) ou depuis
   * `InvitationService.accept()` (Prompt 5, `actingRole` y vaut toujours 'owner' — la
   * vérification manager-ne-peut-pas-owner a déjà eu lieu à la CRÉATION de l'invitation,
   * via `assertCanGrantRole` ci-dessus ; ce paramètre ne fait alors que confirmer qu'aucune
   * régression ne laisserait passer un rôle non autorisé).
   *
   * `session` (Prompt 5) : optionnel — permet d'être appelé à l'intérieur d'une transaction
   * Mongo existante (`session.withTransaction`), pour que la création du profil staff + du
   * membership fasse partie du même rollback atomique que le reste du flux d'acceptation.
   */
  async grant(actingRole: TenantRole, input: GrantMembershipInput, session?: ClientSession): Promise<MembershipDocument> {
    this.assertCanGrantRole(actingRole, input.role);

    const existing = await this.findByUserAndTenant(input.userId, input.tenantId);
    if (existing) {
      throw new ConflictException('This user already has a membership on this tenant.');
    }

    const kind: Membership['kind'] = input.role === 'client' ? 'client' : 'staff';

    if (kind === 'client') {
      if (!input.clientId) throw new BadRequestException('clientId is required to grant a client membership.');
      return this.create(
        {
          userId: input.userId,
          tenantId: input.tenantId,
          kind,
          clientId: input.clientId,
          role: input.role,
          locationIds: input.locationIds,
          defaultLocationId: input.defaultLocationId,
        },
        session,
      );
    }

    let staffId = input.staffId;
    if (staffId) {
      // Rattachement à un profil EXISTANT dans ce tenant — vérifié, jamais fait confiance.
      const staff = await runWithTenant(bootstrapCtx(input.tenantId), () => this.staffModel.findById(staffId).lean().exec());
      if (!staff || staff.salonId !== input.tenantId || staff.userId.toString() !== input.userId) {
        throw new BadRequestException('staffId does not match an existing staff profile for this user on this tenant.');
      }
    } else {
      // Aucun profil fourni : en créer un NOUVEAU (jamais déplacer l'existant d'un autre
      // tenant). `users` n'a pas de `name` — repris du profil staff existant le plus ancien
      // de ce user, à défaut fourni explicitement par l'appelant. Recherche délibérément
      // CROSS-TENANT (staffs est TENANT_SCOPED, aucun salonId ici par construction) —
      // `runOutsideTenant`, pas `runWithTenant`, sinon le plugin injecterait un salonId et
      // limiterait la recherche à UN SEUL tenant, ratant le profil existant qu'on cherche.
      // `.exec()` DOIT être appelé DANS le callback synchrone de `runOutsideTenant` — sinon
      // la Query lazy retournée s'exécute APRÈS que l'ALS se soit déjà dénoué (piège connu
      // de ce projet, revu à chaque nouveau `runWithTenant`/`runOutsideTenant`).
      const existingProfile = await runOutsideTenant('grant:find-existing-staff-profile-for-user', () =>
        this.staffModel.findOne({ userId: new Types.ObjectId(input.userId) }).sort({ createdAt: 1 }).lean().exec(),
      );
      const name = input.name ?? existingProfile?.name;
      if (!name) {
        throw new BadRequestException('name is required — no existing staff profile for this user to copy it from.');
      }
      const [created] = await runWithTenant(bootstrapCtx(input.tenantId), () =>
        this.staffModel.create(
          [
            {
              salonId: input.tenantId,
              userId: new Types.ObjectId(input.userId),
              name,
              email: input.email ?? existingProfile?.email ?? '',
              phone: input.phone ?? existingProfile?.phone ?? '',
              role: input.role,
              locationIds: input.locationIds,
              defaultLocationId: input.defaultLocationId,
              isActive: true,
            },
          ],
          { session },
        ),
      );
      staffId = (created._id as Types.ObjectId).toString();
    }

    return this.create(
      {
        userId: input.userId,
        tenantId: input.tenantId,
        kind,
        staffId,
        role: input.role,
        locationIds: input.locationIds,
        defaultLocationId: input.defaultLocationId,
      },
      session,
    );
  }

  /**
   * Révoque un membership. Un tenant garde TOUJOURS ≥1 owner actif — révoquer le dernier
   * échoue en 409 LAST_OWNER plutôt que de laisser un tenant sans personne habilitée à
   * gérer les accès (décision #Prompt 3, `Pièges connus`).
   */
  async revoke(membershipId: string): Promise<MembershipDocument | null> {
    const target = await this.model.findById(membershipId).exec();
    if (!target) return null;

    if (target.role === 'owner' && target.status === 'active') {
      const otherActiveOwners = await this.model.countDocuments({
        tenantId: target.tenantId,
        role: 'owner',
        status: 'active',
        _id: { $ne: target._id },
      });
      if (otherActiveOwners === 0) {
        throw new ConflictException({ code: 'LAST_OWNER', message: 'A tenant must always keep at least one active owner.' });
      }
    }

    const updated = await this.model
      .findByIdAndUpdate(membershipId, { $set: { status: 'revoked', revokedAt: new Date() } }, { new: true })
      .exec();
    if (updated) this.invalidateCache(updated.userId.toString());
    return updated;
  }

  /**
   * Change les locations accessibles. Valide qu'elles appartiennent bien au tenant du
   * membership (jamais fait confiance à l'appelant), puis synchronise `staff.locationIds`
   * en miroir — les deux copies (Membership et Staff) doivent rester d'accord, `staffs`
   * reste la source lue par le moteur de disponibilité (`BookingService`).
   */
  async updateLocations(membershipId: string, locationIds: string[]): Promise<MembershipDocument | null> {
    const target = await this.model.findById(membershipId).exec();
    if (!target) return null;

    if (locationIds.length > 0) {
      const tenantLocations = await this.locations.findAllForTenant({ salonId: target.tenantId }, true);
      const validIds = new Set(tenantLocations.map((l) => (l._id as Types.ObjectId).toString()));
      const invalid = locationIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException(`These locations do not belong to this tenant: ${invalid.join(', ')}`);
      }
    }

    const updated = await this.model.findByIdAndUpdate(membershipId, { $set: { locationIds } }, { new: true }).exec();
    if (updated) {
      this.invalidateCache(updated.userId.toString());
      if (updated.kind === 'staff' && updated.staffId) {
        await runWithTenant(bootstrapCtx(updated.tenantId), () =>
          this.staffModel.updateOne({ _id: updated.staffId }, { $set: { locationIds } }).exec(),
        );
      }
    }
    return updated;
  }
}
