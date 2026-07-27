import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Client, ClientDocument, PreferredChannel } from './schemas/client.schema';
import { CreateClientDto, UpdateClientDto } from './dto/client.dto';
import { SalonScope } from '../common/scope/salon-scope';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { ClientProfileService } from '../identity/client-profile.service';

export interface ClientStats {
  visitCount: number;
  totalSpentTnd: number;
  lastVisitDate: string | null; // 'YYYY-MM-DD'
}

export interface ClientListItem {
  id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  commsConsent: boolean;
  preferredChannel: PreferredChannel;
  visitCount: number;
  totalSpentTnd: number;
  lastVisitDate: string | null;
}

export interface ClientVisit {
  serviceName: string;
  date: string; // 'YYYY-MM-DD'
  priceTnd: number;
}

export interface ClientDetail extends ClientListItem {
  recentVisits: ClientVisit[];
}

export interface LatestVisit {
  appointmentId: string;
  barber: {
    id: string | null;
    name: string;
    avatar: string | null;
    rating: number | null;
    reviewCount: number | null;
    isPro: boolean;
  };
  lastVisitAt: Date;
}

/**
 * Pattern CRUD canonique (Sprint 2) — répliqué par tous les modules suivants.
 * RÈGLE : chaque query injecte `scope.salonId` (convention #3, jamais omis).
 */
@Injectable()
export class ClientsService {
  constructor(
    @InjectModel(Client.name) private readonly model: Model<ClientDocument>,
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    private readonly clientProfiles: ClientProfileService,
  ) {}

  /**
   * Dernier RDV `completed` du client courant (SKILL_client_home_dynamic HOME.3).
   * Aucune fabrication de visite : `null` si le client n'a aucun historique.
   */
  async getLatestVisit(clientId: string): Promise<LatestVisit | null> {
    const appt: any = await this.apptModel
      // Appointment.clientId is genuinely stored as ObjectId but the schema doesn't get
      // Mongoose to cast query filters for that path (see booking.service.ts's list()) —
      // a raw string here would silently match nothing.
      .findOne({ clientId: new Types.ObjectId(clientId), status: 'completed' })
      .sort({ start: -1 })
      .populate('stylistId', 'name')
      .lean();

    if (!appt) return null;

    const staff = appt.stylistId as { _id: { toString(): string }; name: string } | null;
    return {
      appointmentId: appt._id.toString(),
      barber: {
        id: staff?._id?.toString() ?? null,
        name: staff?.name ?? 'Barber',
        avatar: null, // pas de champ avatar sur Staff aujourd'hui
        rating: null, // pas de collection reviews aujourd'hui (DH-3)
        reviewCount: null,
        isPro: false,
      },
      lastVisitAt: appt.start,
    };
  }

  /**
   * Completed-appointment stats (visits/spend), batched per client via aggregation. Matched
   * by `clientId` only (no `salonId` re-filter) — every id passed in already came from a
   * salon-scoped `Client` query, so the scoping is transitive through the relation.
   */
  private async statsByClientId(clientIds: Types.ObjectId[]): Promise<Map<string, ClientStats>> {
    if (clientIds.length === 0) return new Map();
    const rows = await this.apptModel.aggregate<{ _id: Types.ObjectId; visitCount: number; totalSpentTnd: number; lastVisitDate: Date }>([
      { $match: { clientId: { $in: clientIds }, status: 'completed' } },
      { $group: { _id: '$clientId', visitCount: { $sum: 1 }, totalSpentTnd: { $sum: '$price' }, lastVisitDate: { $max: '$start' } } },
    ]);
    return new Map(
      rows.map((r) => [
        r._id.toString(),
        {
          visitCount: r.visitCount,
          totalSpentTnd: r.totalSpentTnd,
          lastVisitDate: r.lastVisitDate ? new Date(r.lastVisitDate).toISOString().slice(0, 10) : null,
        },
      ]),
    );
  }

  private toListItem(c: ClientDocument, stats?: ClientStats): ClientListItem {
    return {
      id: c._id.toString(),
      name: c.name,
      phone: c.phone,
      email: c.email,
      notes: c.notes,
      commsConsent: c.commsConsent,
      preferredChannel: c.preferredChannel,
      visitCount: stats?.visitCount ?? 0,
      totalSpentTnd: stats?.totalSpentTnd ?? 0,
      lastVisitDate: stats?.lastVisitDate ?? null,
    };
  }

  /** Liste scopée, recherche optionnelle `q` sur name/phone/email. */
  async findAll(scope: SalonScope, q?: string): Promise<ClientListItem[]> {
    const filter: FilterQuery<ClientDocument> = { salonId: scope.salonId };
    if (q && q.trim()) {
      const rx = new RegExp(this.escapeRegex(q.trim()), 'i');
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    const clients = await this.model.find(filter).sort({ createdAt: -1 }).exec();
    const stats = await this.statsByClientId(clients.map((c) => c._id as Types.ObjectId));
    return clients.map((c) => this.toListItem(c, stats.get(c._id.toString())));
  }

  async findOne(scope: SalonScope, id: string): Promise<ClientDetail> {
    const doc = await this.model.findOne({ _id: id, salonId: scope.salonId }).exec();
    if (!doc) throw new NotFoundException('Client not found.');

    const stats = await this.statsByClientId([doc._id as Types.ObjectId]);
    const visits = await this.apptModel
      .find({ clientId: doc._id, status: { $nin: ['cancelled', 'noshow'] } })
      .sort({ start: -1 })
      .limit(10)
      .populate('services', 'name')
      .lean();
    const recentVisits: ClientVisit[] = visits.map((v: any) => ({
      serviceName: (v.services ?? []).map((s: any) => s?.name).filter(Boolean).join(', ') || 'Service',
      date: new Date(v.start).toISOString().slice(0, 10),
      priceTnd: v.price ?? 0,
    }));

    return { ...this.toListItem(doc, stats.get(doc._id.toString())), recentVisits };
  }

  /** Raw doc read used internally by write paths (create/update) — no stats needed. */
  private async findOneRaw(scope: SalonScope, id: string): Promise<ClientDocument> {
    const doc = await this.model.findOne({ _id: id, salonId: scope.salonId }).exec();
    if (!doc) throw new NotFoundException('Client not found.');
    return doc;
  }

  /**
   * Création avec merge-on-phone (Décision #10) : si un Client existe déjà avec le même
   * phone dans ce salon, on l'enrichit (sans écraser par du vide) au lieu de dupliquer.
   */
  async create(scope: SalonScope, dto: CreateClientDto): Promise<ClientDocument> {
    const existing = await this.model
      .findOne({ salonId: scope.salonId, phone: dto.phone })
      .exec();

    if (existing) {
      existing.name = dto.name || existing.name;
      if (dto.email !== undefined && dto.email !== '') existing.email = dto.email.toLowerCase();
      if (dto.commsConsent !== undefined) existing.commsConsent = dto.commsConsent;
      if (dto.preferredChannel !== undefined) existing.preferredChannel = dto.preferredChannel;
      if (dto.notes !== undefined) existing.notes = dto.notes;
      await existing.save();
      if (!existing.profileId) {
        await this.clientProfiles.attachProfile(scope.salonId, (existing._id as Types.ObjectId).toString(), existing.phone, {
          name: existing.name,
          email: existing.email,
        });
      }
      return existing;
    }

    const created = await this.model.create({
      salonId: scope.salonId,
      name: dto.name,
      phone: dto.phone,
      email: dto.email?.toLowerCase() ?? '',
      commsConsent: dto.commsConsent ?? true,
      preferredChannel: dto.preferredChannel ?? 'email',
      notes: dto.notes ?? '',
      registered: false,
      history: [],
    });
    await this.clientProfiles.attachProfile(scope.salonId, (created._id as Types.ObjectId).toString(), created.phone, {
      name: created.name,
      email: created.email,
    });
    return created;
  }

  async update(scope: SalonScope, id: string, dto: UpdateClientDto): Promise<ClientDocument> {
    const doc = await this.findOneRaw(scope, id);
    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.phone !== undefined) doc.phone = dto.phone;
    if (dto.email !== undefined) doc.email = dto.email.toLowerCase();
    if (dto.commsConsent !== undefined) doc.commsConsent = dto.commsConsent;
    if (dto.preferredChannel !== undefined) doc.preferredChannel = dto.preferredChannel;
    if (dto.notes !== undefined) doc.notes = dto.notes;
    await doc.save();
    return doc;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
