import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from '../schemas/product.schema';

@Injectable()
export class ProductsService {
  constructor(@InjectModel(Product.name) private productModel: Model<ProductDocument>) {}

  findAll(category?: string) {
    const filter: Record<string, unknown> = { isActive: true };
    if (category) filter.category = category;
    return this.productModel.find(filter).exec();
  }

  async findOne(id: string) {
    const product = await this.productModel.findById(id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(dto: Partial<Product>) {
    return this.productModel.create(dto);
  }

  async update(id: string, dto: Partial<Product>) {
    const product = await this.productModel.findByIdAndUpdate(id, dto, { new: true });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}
