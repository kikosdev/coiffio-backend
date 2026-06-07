import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Service, ServiceDocument, ServiceCategory } from '../schemas/service.schema';
import { Appointment, AppointmentDocument } from '../schemas/appointment.schema';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { QueryServicesDto } from './dto/query-services.dto';

export interface MarginResult {
  margin: number;
  marginPercent: number;
}

export interface CategoryStat {
  category: ServiceCategory;
  count: number;
  totalDuration: number;
}

export interface PopularService {
  service: ServiceDocument;
  count: number;
}

export interface PaginatedServices {
  data: ServiceDocument[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name)      private serviceModel: Model<ServiceDocument>,
    @InjectModel(Appointment.name)  private apptModel: Model<AppointmentDocument>,
  ) {}

  async findAll(query: QueryServicesDto): Promise<PaginatedServices> {
    const { category, search, isActive, page = 1, limit = 50 } = query;

    const filter: Record<string, unknown> = {};
    if (category)              filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive;
    if (search) {
      filter.$or = [
        { name:        { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const skip  = (page - 1) * limit;
    const total = await this.serviceModel.countDocuments(filter);

    const data = await this.serviceModel
      .find(filter)
      .sort({ displayOrder: 1, name: 1 })
      .skip(skip)
      .limit(limit)
      .exec();

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findCategories(): Promise<CategoryStat[]> {
    const rows = await this.serviceModel.aggregate<{
      _id: ServiceCategory;
      count: number;
      totalDuration: number;
    }>([
      { $match: { isActive: true } },
      {
        $group: {
          _id:           '$category',
          count:         { $sum: 1 },
          totalDuration: { $sum: '$duration' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map(r => ({
      category:      r._id,
      count:         r.count,
      totalDuration: r.totalDuration,
    }));
  }

  async findPopular(): Promise<PopularService[]> {
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const rows = await this.apptModel.aggregate<{
      _id: Types.ObjectId;
      count: number;
      service: ServiceDocument;
    }>([
      {
        $match: {
          startsAt: { $gte: since },
          status:   { $nin: ['cancelled', 'no_show'] },
        },
      },
      { $unwind: '$serviceIds' },
      { $group: { _id: '$serviceIds', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from:         'services',
          localField:   '_id',
          foreignField: '_id',
          as:           'service',
        },
      },
      { $unwind: '$service' },
      { $match: { 'service.isActive': true } },
    ]);

    return rows.map(r => ({ service: r.service, count: r.count }));
  }

  async findOne(id: string): Promise<ServiceDocument> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid service id');
    const service = await this.serviceModel.findById(id).exec();
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async create(dto: CreateServiceDto): Promise<ServiceDocument> {
    const exists = await this.serviceModel.findOne({ name: dto.name }).exec();
    if (exists) throw new ConflictException(`A service named "${dto.name}" already exists`);
    return this.serviceModel.create(dto);
  }

  async update(id: string, dto: UpdateServiceDto): Promise<ServiceDocument> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid service id');
    if (dto.name) {
      const conflict = await this.serviceModel.findOne({ name: dto.name, _id: { $ne: new Types.ObjectId(id) } }).exec();
      if (conflict) throw new ConflictException(`A service named "${dto.name}" already exists`);
    }
    const service = await this.serviceModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async toggleActive(id: string): Promise<ServiceDocument> {
    const service = await this.findOne(id);
    service.isActive = !service.isActive;
    return service.save();
  }

  async reorder(items: { id: string; displayOrder: number }[]): Promise<void> {
    await Promise.all(
      items.map(({ id, displayOrder }) => {
        if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid id: ${id}`);
        return this.serviceModel.findByIdAndUpdate(id, { displayOrder }).exec();
      }),
    );
  }

  async remove(id: string): Promise<{ success: boolean }> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid service id');
    await this.canDelete(id);
    const result = await this.serviceModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Service not found');
    return { success: true };
  }

  async canDelete(id: string): Promise<void> {
    const count = await this.apptModel.countDocuments({
      serviceIds: new Types.ObjectId(id),
    });
    if (count > 0) {
      throw new ConflictException(
        `Cannot delete: ${count} appointment(s) reference this service. Use toggle-active to deactivate it instead.`,
      );
    }
  }

  calculateMargin(price: number, costPrice: number): MarginResult {
    const margin        = price - costPrice;
    const marginPercent = price > 0 ? Math.round((margin / price) * 100) : 0;
    return { margin, marginPercent };
  }
}
