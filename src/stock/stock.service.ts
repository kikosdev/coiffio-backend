import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { StockMove, StockMoveDocument } from './schemas/stock-move.schema';
import { CreateProductDto, UpdateProductDto } from './dto/stock.dto';
import { AdjustStockDto } from './dto/stock.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class StockService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
  ) {}

  async list(opts: { category?: string; activeOnly?: boolean; search?: string; inStock?: boolean }): Promise<ProductDocument[]> {
    const filter: FilterQuery<ProductDocument> = {};
    if (opts.category) filter.category = opts.category;
    if (opts.activeOnly) filter.active = true;
    if (opts.search) filter.name = { $regex: opts.search, $options: 'i' };
    if (opts.inStock) filter.stock = { $gt: 0 };
    return this.productModel.find(filter).sort({ category: 1, name: 1 });
  }

  async create(dto: CreateProductDto): Promise<ProductDocument> {
    return this.productModel.create({
      name: dto.name,
      category: dto.category ?? '',
      price: dto.price,
      cost: dto.cost ?? 0,
      stock: dto.stock ?? 0,
      lowStockAt: dto.lowStockAt ?? 0,
      supplier: dto.supplier ?? '',
      barcode: dto.barcode ?? '',
      notes: dto.notes ?? '',
      visibleLanding: true,
      promo: false,
      promoPercent: 0,
      promoLabel: '',
      active: true,
    });
  }

  async adjustStock(user: AuthUser, id: string, dto: AdjustStockDto): Promise<ProductDocument> {
    const p = await this.productModel.findOneAndUpdate(
      { _id: id },
      { $inc: { stock: dto.delta } },
      { new: true },
    );
    if (!p) throw new NotFoundException('Product not found.');
    if (dto.delta !== 0) {
      await this.moveModel.create({
        productId: p._id,
        type: dto.delta > 0 ? 'in' : 'out',
        qty: Math.abs(dto.delta),
        date: new Date(),
        note: dto.note ?? '',
        createdBy: new Types.ObjectId(user.sub),
      });
    }
    return p;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    const p = await this.productModel.findOne({ _id: id });
    if (!p) throw new NotFoundException('Product not found.');
    Object.assign(p, dto);
    await p.save();
    return p;
  }

  async softDelete(id: string): Promise<ProductDocument> {
    const p = await this.productModel.findOne({ _id: id });
    if (!p) throw new NotFoundException('Product not found.');
    p.active = false;
    await p.save();
    return p;
  }

  async restock(user: AuthUser, id: string, qty: number, note?: string): Promise<ProductDocument> {
    const p = await this.productModel.findOneAndUpdate(
      { _id: id },
      { $inc: { stock: qty } },
      { new: true },
    );
    if (!p) throw new NotFoundException('Product not found.');
    await this.moveModel.create({
      productId: p._id,
      type: 'in',
      qty,
      date: new Date(),
      note: note ?? '',
      createdBy: new Types.ObjectId(user.sub),
    });
    return p;
  }

  async movements(productId?: string): Promise<StockMoveDocument[]> {
    const filter: FilterQuery<StockMoveDocument> = {};
    if (productId) filter.productId = new Types.ObjectId(productId);
    return this.moveModel.find(filter).sort({ date: -1 }).limit(200);
  }

  async low(): Promise<ProductDocument[]> {
    return this.productModel
      .find({ active: true, $expr: { $lte: ['$stock', '$lowStockAt'] } })
      .sort({ stock: 1 });
  }
}
