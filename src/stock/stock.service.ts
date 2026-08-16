import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { StockMove, StockMoveDocument } from './schemas/stock-move.schema';
import {
  CreateProductDto,
  UpdateProductDto,
  UpdateProductDosesDto,
  CreateStockMovementDto,
  CreateInventoryCountDto,
} from './dto/stock.dto';
import { AdjustStockDto } from './dto/stock.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { startOfDayInTz, endOfDayInTz, isoDateInTz, shiftIsoDate } from '../common/time/tz-day.util';
import { LossAlertService } from '../loss-control/loss-alert.service';

@Injectable()
export class StockService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockMove.name) private readonly moveModel: Model<StockMoveDocument>,
    private readonly lossAlertService: LossAlertService,
  ) {}

  async list(opts: { category?: string; activeOnly?: boolean; search?: string; inStock?: boolean; isConsumable?: boolean }): Promise<ProductDocument[]> {
    const filter: FilterQuery<ProductDocument> = {};
    if (opts.category) filter.category = opts.category;
    if (opts.activeOnly) filter.active = true;
    if (opts.search) filter.name = { $regex: opts.search, $options: 'i' };
    if (opts.inStock) filter.stock = { $gt: 0 };
    if (opts.isConsumable !== undefined) filter.isConsumable = opts.isConsumable;
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

  /** LC-1/LC-7 (SKILL_loss_control_doses.md) — owner-only, séparé de `update()`. */
  async updateDoses(id: string, dto: UpdateProductDosesDto): Promise<ProductDocument> {
    const p = await this.productModel.findOne({ _id: id });
    if (!p) throw new NotFoundException('Product not found.');
    if (dto.dosesPerUnit !== undefined) p.dosesPerUnit = dto.dosesPerUnit;
    if (dto.isConsumable !== undefined) p.isConsumable = dto.isConsumable;
    if (dto.varianceThresholdPct !== undefined) p.varianceThresholdPct = dto.varianceThresholdPct;
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

  /**
   * LC-5 (SKILL_loss_control_doses.md, Prompt 3) — POS (`refill`/`adjustment`/`loss`).
   * `units` : magnitude positive pour `refill`/`loss` (le sens vient de `kind`), signée pour
   * `adjustment`. Réutilise `StockMove.note`/`createdBy` comme `reason`/`declaredBy` (LC-5) —
   * pas de champ dupliqué, cf. schéma.
   */
  async declareMovement(dto: CreateStockMovementDto, staffId: string): Promise<StockMoveDocument> {
    const product = await this.productModel.findOne({ _id: dto.productId });
    if (!product) throw new NotFoundException('Product not found.');

    let delta: number;
    if (dto.kind === 'refill') {
      if (dto.units <= 0) throw new BadRequestException('Un réapprovisionnement doit être une quantité positive.');
      delta = dto.units;
    } else if (dto.kind === 'loss') {
      if (dto.units <= 0) throw new BadRequestException('Une perte doit être déclarée en quantité positive.');
      delta = -dto.units;
    } else {
      if (dto.units === 0) throw new BadRequestException('Un ajustement doit être non nul.');
      delta = dto.units;
    }

    product.stock += delta;
    await product.save();

    return this.moveModel.create({
      productId: product._id,
      kind: dto.kind,
      type: delta >= 0 ? 'in' : 'out',
      qty: Math.abs(delta),
      doses: product.dosesPerUnit !== undefined ? Math.abs(delta) * product.dosesPerUnit : undefined,
      date: new Date(),
      note: dto.reason ?? '',
      createdBy: new Types.ObjectId(staffId),
    });
  }

  /**
   * LC-5 — INVENTAIRE PHYSIQUE (Prompt 3). LA jambe non contournable du loss control : sans
   * comptage réel, l'écart de stock (Calc 2, Prompt 4) compare du théorique à du théorique et
   * lit ~0% quel que soit le vol réel. `countedStock` REDÉFINIT `Product.stock` (valeur
   * absolue), il ne s'additionne pas comme un `refill`.
   */
  async declareInventoryCount(dto: CreateInventoryCountDto, staffId: string): Promise<StockMoveDocument> {
    const product = await this.productModel.findOne({ _id: dto.productId });
    if (!product) throw new NotFoundException('Product not found.');

    const previousStock = product.stock;
    const variance = dto.countedStock - previousStock;
    const now = new Date();

    product.stock = dto.countedStock;
    product.lastInventoryAt = now;
    await product.save();

    const move = await this.moveModel.create({
      productId: product._id,
      kind: 'inventory',
      type: variance >= 0 ? 'in' : 'out',
      qty: dto.countedStock,
      previousStock,
      variance,
      doses: product.dosesPerUnit !== undefined ? Math.abs(variance) * product.dosesPerUnit : undefined,
      date: now,
      note: dto.reason ?? '',
      createdBy: new Types.ObjectId(staffId),
    });

    // LC-6/LC-10 (Prompt 5) : un nouveau comptage est le SEUL moment où une nouvelle paire
    // baseline/réel devient disponible pour Calc 2 — c'est ici, pas ailleurs, qu'un écart
    // au-delà du seuil peut être détecté et alerté.
    await this.lossAlertService.checkStockVariance(dto.productId);

    return move;
  }

  private periodRange(period: 'day' | 'week' | 'month', ref = new Date()): { from: Date; to: Date } {
    const refDay = isoDateInTz(ref);
    const to = endOfDayInTz(refDay);
    let fromDay = refDay;
    if (period === 'week') fromDay = shiftIsoDate(refDay, -6);
    if (period === 'month') fromDay = `${refDay.slice(0, 7)}-01`;
    return { from: startOfDayInTz(fromDay), to };
  }

  async movements(productId?: string, period?: 'day' | 'week' | 'month'): Promise<StockMoveDocument[]> {
    const filter: FilterQuery<StockMoveDocument> = {};
    if (productId) filter.productId = new Types.ObjectId(productId);
    if (period) {
      const { from, to } = this.periodRange(period);
      filter.date = { $gte: from, $lte: to };
    }
    return this.moveModel.find(filter).sort({ date: -1 }).limit(200);
  }

  async low(): Promise<ProductDocument[]> {
    return this.productModel
      .find({ active: true, $expr: { $lte: ['$stock', '$lowStockAt'] } })
      .sort({ stock: 1 });
  }
}
