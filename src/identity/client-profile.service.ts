import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { ClientProfile, ClientProfileDocument } from './schemas/client-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { LocationService } from '../locations/location.service';
import { normalizePhone } from './phone-normalization.util';
import { runWithTenant, TenantContext } from '../common/tenant/tenant-context';
import { mapWithConcurrencyLimit } from '../common/utils/concurrency-limit.util';

export interface GlobalHistoryEntry {
  tenantId: string;
  salonName: string;
  locationName: string;
  type: 'appointment';
  refId: string;
  date: Date;
  status: string;
}

export interface GlobalHistoryQuery {
  limit?: number;
  before?: Date;
}

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const MAX_CONCURRENT_TENANTS = 5;

/** Contexte système synthétique — lecture cross-tenant SCOPÉE tenant-par-tenant, jamais
 *  un bypass. `role`/`plan` sont des placeholders : ce n'est jamais une vraie session. */
function systemReadContext(tenantId: string, locationId = '', locationIds: string[] = []): TenantContext {
  return {
    tenantId,
    locationId,
    locationIds,
    role: 'owner',
    plan: 'starter',
    features: {},
    limits: {},
  };
}

@Injectable()
export class ClientProfileService {
  private readonly logger = new Logger(ClientProfileService.name);

  constructor(
    @InjectModel(ClientProfile.name) private readonly profileModel: Model<ClientProfileDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Appointment.name) private readonly appointmentModel: Model<AppointmentDocument>,
    private readonly locations: LocationService,
  ) {}

  /** Réutilise le profil existant par téléphone normalisé, ne duplique jamais. */
  async findOrCreateByPhone(
    rawPhone: string,
    data: { name?: string; email?: string; userId?: string } = {},
  ): Promise<ClientProfileDocument | null> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      this.logger.warn(`Phone "${rawPhone}" could not be normalized — no ClientProfile created/linked.`);
      return null;
    }

    const existing = await this.profileModel.findOne({ phone });
    if (existing) return existing;

    return this.profileModel.create({
      phone,
      name: data.name ?? '',
      email: data.email ?? '',
      userId: data.userId ? new Types.ObjectId(data.userId) : undefined,
    });
  }

  /**
   * $set clients.profileId + $addToSet ClientProfile.tenantIds.
   * ⚠️ Pas atomique (deux updateOne distincts, pas de transaction Mongo) : un crash
   * exactement entre les deux laisserait clients.profileId posé sans que ce tenantId
   * soit dans ClientProfile.tenantIds — getGlobalHistory manquerait ce tenant-là. Fenêtre
   * étroite (un crash process pile entre deux await consécutifs), mais réelle. Signalé
   * plutôt que supposé sûr — voir le rapport de livraison pour la décision de durcissement
   * (transaction Mongo, ou script de réconciliation périodique via runOutsideTenant).
   */
  async linkClient(tenantId: string, profileId: string, clientId: string): Promise<void> {
    // ⚠️ `.exec()` DOIT être appelé ici, dans le callback synchrone de runWithTenant — un
    // objet Query Mongoose est lazy (rien ne s'exécute avant .exec()/.then()) ; le retourner
    // sans l'exécuter fait perdre le contexte AsyncLocalStorage, puisque son exécution réelle
    // n'a alors lieu qu'après le retour de tenantStorage.run(), hors de sa fenêtre suivie.
    // Trouvé en re-testant getGlobalHistory de bout en bout (throw "No tenant context
    // available" sur ce point précis) — .create()/.save() n'ont pas ce problème (promesse
    // déjà amorcée en interne), seuls les objets Query lazy (.find/.updateOne/...) l'ont.
    await runWithTenant(systemReadContext(tenantId), () =>
      this.clientModel.updateOne({ _id: clientId }, { $set: { profileId } }).exec(),
    );
    await this.profileModel.updateOne({ _id: profileId }, { $addToSet: { tenantIds: tenantId } });
  }

  /**
   * Sucre pour les points de création de Client (rattachement automatique, spec Prompt 4
   * §4) : findOrCreateByPhone puis linkClient en une seule étape. Un téléphone
   * non-normalisable ne bloque JAMAIS la création du Client appelante — juste pas de
   * ClientProfile pour cette fois (loggé en warn dans findOrCreateByPhone).
   */
  async attachProfile(
    tenantId: string,
    clientId: string,
    rawPhone: string,
    data: { name?: string; email?: string; userId?: string } = {},
  ): Promise<ClientProfileDocument | null> {
    const profile = await this.findOrCreateByPhone(rawPhone, data);
    if (!profile) return null;
    await this.linkClient(tenantId, (profile._id as Types.ObjectId).toString(), clientId);
    return profile;
  }

  /**
   * Historique global — lit `appointments` en direct (PAS `Client.history[]`, confirmé
   * champ mort : 0/32 clients avec une entrée, poussé nulle part dans le code). Toujours
   * via runWithTenant, jamais de bypass (règle prouvée au Prompt 3, ne fléchit pas ici).
   *
   * Pour chaque tenant de `profile.tenantIds` : résout les Client de ce profil dans ce
   * tenant, résout les locations actives, puis une lecture scopée par location (une seule
   * si le tenant est mono-location — cas courant, pas de bouclage payé pour rien).
   * Concurrence plafonnée à MAX_CONCURRENT_TENANTS entre tenants. Chaque source est
   * limitée côté requête à `limit`, puis le résultat fusionné est retrié et retaillé à
   * `limit` — une pagination `before` exacte multi-source nécessiterait un curseur par
   * source ; ceci borne le coût sans prétendre à un curseur distribué parfait.
   */
  async getGlobalHistory(profileId: string, query: GlobalHistoryQuery = {}): Promise<GlobalHistoryEntry[]> {
    const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const profile = await this.profileModel.findById(profileId);
    if (!profile) throw new NotFoundException('Client profile not found.');

    const perTenant = await mapWithConcurrencyLimit(profile.tenantIds, MAX_CONCURRENT_TENANTS, async (tenantId) => {
      try {
        return await this.fetchTenantHistory(tenantId, profileId, limit, query.before);
      } catch (err) {
        this.logger.warn(`getGlobalHistory: skipping tenant ${tenantId} — ${(err as Error).message}`);
        return [];
      }
    });

    const merged = perTenant.flat();
    merged.sort((a, b) => b.date.getTime() - a.date.getTime());
    return merged.slice(0, limit);
  }

  private async fetchTenantHistory(
    tenantId: string,
    profileId: string,
    limit: number,
    before: Date | undefined,
  ): Promise<GlobalHistoryEntry[]> {
    // `locations` est TENANT_SCOPED : le plugin exige un contexte actif pour CETTE requête,
    // peu importe que LocationService scope déjà son filtre manuellement via SalonScope —
    // le plugin intercepte au niveau Mongoose, indépendamment du mécanisme de scoping de
    // l'appelant. Salon, lui, est UNSCOPED — aucun contexte requis, exempté par le plugin.
    const [locations, salon] = await Promise.all([
      runWithTenant(systemReadContext(tenantId), () => this.locations.findAllForTenant({ salonId: tenantId })),
      this.salonModel.findById(new Types.ObjectId(tenantId)),
    ]);
    const salonName = salon?.name ?? tenantId;

    if (locations.length === 0) {
      this.logger.warn(`getGlobalHistory: tenant ${tenantId} has no active location — skipped.`);
      return [];
    }

    // clients: TENANT_SCOPED (pas LOCATION_SCOPED) — un seul appel scopé au tenant suffit
    // pour résoudre les clientIds, quel que soit le nombre de locations.
    const clientIds = await runWithTenant(systemReadContext(tenantId), async () => {
      const docs = await this.clientModel.find({ profileId }).select('_id').exec();
      return docs.map((d) => d._id as Types.ObjectId);
    });

    if (clientIds.length === 0) {
      // profile.tenantIds pointe vers ce tenant mais aucun Client n'y a ce profileId —
      // signal de dérive potentielle du champ dénormalisé (voir rapport de livraison).
      this.logger.warn(`getGlobalHistory: tenant ${tenantId} listed in profile.tenantIds but no matching Client found.`);
      return [];
    }

    // Point (a) : pas de bouclage payé pour rien sur le cas mono-location.
    if (locations.length === 1) {
      const loc = locations[0];
      return this.fetchLocationAppointments(tenantId, loc._id.toString(), [loc._id.toString()], clientIds, salonName, loc.name, limit, before);
    }

    const perLocation = await Promise.all(
      locations.map((loc) =>
        this.fetchLocationAppointments(
          tenantId,
          loc._id.toString(),
          locations.map((l) => l._id.toString()),
          clientIds,
          salonName,
          loc.name,
          limit,
          before,
        ),
      ),
    );
    return perLocation.flat();
  }

  private async fetchLocationAppointments(
    tenantId: string,
    locationId: string,
    locationIds: string[],
    clientIds: Types.ObjectId[],
    salonName: string,
    locationName: string,
    limit: number,
    before: Date | undefined,
  ): Promise<GlobalHistoryEntry[]> {
    return runWithTenant(systemReadContext(tenantId, locationId, locationIds), async () => {
      const filter: FilterQuery<AppointmentDocument> = { clientId: { $in: clientIds } };
      if (before) filter.start = { $lt: before };

      const appts = await this.appointmentModel.find(filter).sort({ start: -1 }).limit(limit).exec();

      return appts.map((a) => ({
        tenantId,
        salonName,
        locationName,
        type: 'appointment' as const,
        refId: (a._id as Types.ObjectId).toString(),
        date: a.start,
        status: a.status,
      }));
    });
  }

  /**
   * Tenants connus d'un client à partir de SA PROPRE fiche `Client` dans un tenant donné —
   * résout `profileId` puis renvoie `ClientProfile.tenantIds[]` (même donnée que
   * `getGlobalHistory`, mais le SET brut plutôt qu'un historique tout fait). Pour des
   * appelants qui doivent faire LEURS PROPRES appels scopés par tenant (durcissement
   * post-Sprint-1-v2 Partie 3 : `BookingService.listMine()`/`.cancel()`, BK.1/BK.2) plutôt
   * que déléguer à `getGlobalHistory`. `tenantId` d'origine TOUJOURS inclus dans le résultat,
   * même sans `ClientProfile` lié (téléphone jamais normalisable, ou walk-in jamais
   * rattaché) — un client reste au moins visible chez lui.
   */
  async getTenantIdsForClient(tenantId: string, clientId: string): Promise<string[]> {
    const client = await runWithTenant(systemReadContext(tenantId), () =>
      this.clientModel.findById(clientId).select('profileId').exec(),
    );
    if (!client?.profileId) return [tenantId];
    const profile = await this.profileModel.findById(client.profileId).select('tenantIds').exec();
    const tenantIds = new Set(profile?.tenantIds ?? []);
    tenantIds.add(tenantId);
    return [...tenantIds];
  }

  /** Résout profileId à partir d'un clientId connu dans un tenant donné, puis délègue.
   *  Pas de profileId lié (téléphone jamais normalisable, ou pas encore rattaché) →
   *  historique vide, pas une erreur. */
  async getHistoryForClient(tenantId: string, clientId: string, query: GlobalHistoryQuery = {}): Promise<GlobalHistoryEntry[]> {
    const client = await runWithTenant(systemReadContext(tenantId), () => this.clientModel.findById(clientId).exec());
    if (!client?.profileId) return [];
    return this.getGlobalHistory(client.profileId, query);
  }
}
