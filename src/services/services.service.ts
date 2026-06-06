import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Service, ServiceDocument } from '../schemas/service.schema';

@Injectable()
export class ServicesService {
  constructor(@InjectModel(Service.name) private serviceModel: Model<ServiceDocument>) {}

  findAll(audience?: string, category?: string) {
    const filter: Record<string, unknown> = { isActive: true };
    if (audience) filter.audience = audience;
    if (category) filter.category = category;
    return this.serviceModel.find(filter).exec();
  }

  async findOne(id: string) {
    const service = await this.serviceModel.findById(id);
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async create(dto: Partial<Service>) {
    return this.serviceModel.create(dto);
  }

  async update(id: string, dto: Partial<Service>) {
    const service = await this.serviceModel.findByIdAndUpdate(id, dto, { new: true });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async remove(id: string) {
    await this.serviceModel.findByIdAndUpdate(id, { isActive: false });
    return { success: true };
  }
}
