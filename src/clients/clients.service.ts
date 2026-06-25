import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Client, ClientDocument } from './schemas/client.schema';
import { CreateClientDto, UpdateClientDto } from './dto/client.dto';
import { SalonScope } from '../common/scope/salon-scope';

/**
 * Pattern CRUD canonique (Sprint 2) — répliqué par tous les modules suivants.
 * RÈGLE : chaque query injecte `scope.salonId` (convention #3, jamais omis).
 */
@Injectable()
export class ClientsService {
  constructor(@InjectModel(Client.name) private readonly model: Model<ClientDocument>) {}

  /** Liste scopée, recherche optionnelle `q` sur name/phone/email. */
  async findAll(scope: SalonScope, q?: string): Promise<ClientDocument[]> {
    const filter: FilterQuery<ClientDocument> = { salonId: scope.salonId };
    if (q && q.trim()) {
      const rx = new RegExp(this.escapeRegex(q.trim()), 'i');
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    return this.model.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(scope: SalonScope, id: string): Promise<ClientDocument> {
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
      return existing;
    }

    return this.model.create({
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
  }

  async update(scope: SalonScope, id: string, dto: UpdateClientDto): Promise<ClientDocument> {
    const doc = await this.findOne(scope, id);
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
