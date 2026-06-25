import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Service, ServiceDocument, ServiceGender } from './schemas/service.schema';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';
import { SalonScope } from '../common/scope/salon-scope';

/** Catalogue services (Sprint 2) — même pattern canonique que Clients (scope partout). */
@Injectable()
export class ServicesService {
  constructor(@InjectModel(Service.name) private readonly model: Model<ServiceDocument>) {}

  /** Liste scopée, actifs uniquement par défaut, filtrable par gender. */
  async findAll(scope: SalonScope, gender?: ServiceGender): Promise<ServiceDocument[]> {
    const filter: FilterQuery<ServiceDocument> = { salonId: scope.salonId, active: true };
    if (gender) filter.gender = gender;
    return this.model.find(filter).sort({ gender: 1, name: 1 }).exec();
  }

  async findOne(scope: SalonScope, id: string): Promise<ServiceDocument> {
    const doc = await this.model.findOne({ _id: id, salonId: scope.salonId }).exec();
    if (!doc) throw new NotFoundException('Service not found.');
    return doc;
  }

  async create(scope: SalonScope, dto: CreateServiceDto): Promise<ServiceDocument> {
    return this.model.create({
      salonId: scope.salonId,
      name: dto.name,
      category: dto.category ?? '',
      gender: dto.gender,
      price: dto.price,
      durationMin: dto.durationMin,
      bufferMin: dto.bufferMin ?? 0,
      color: dto.color ?? '#B89968',
      active: true,
    });
  }

  async update(scope: SalonScope, id: string, dto: UpdateServiceDto): Promise<ServiceDocument> {
    const doc = await this.findOne(scope, id);
    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.gender !== undefined) doc.gender = dto.gender;
    if (dto.price !== undefined) doc.price = dto.price;
    if (dto.durationMin !== undefined) doc.durationMin = dto.durationMin;
    if (dto.bufferMin !== undefined) doc.bufferMin = dto.bufferMin;
    if (dto.color !== undefined) doc.color = dto.color;
    await doc.save();
    return doc;
  }

  /** Soft delete (Décision : jamais de hard delete) → active:false. */
  async softDelete(scope: SalonScope, id: string): Promise<ServiceDocument> {
    const doc = await this.findOne(scope, id);
    doc.active = false;
    await doc.save();
    return doc;
  }
}
