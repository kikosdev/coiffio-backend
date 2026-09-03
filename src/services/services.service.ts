import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Service, ServiceDocument, ServiceGender } from './schemas/service.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { CreateServiceDto, UpdateServiceDto, UpdateServiceDoseConfigDto } from './dto/service.dto';
import { SalonCatalogService } from '../salons/salon-catalog.service';

/**
 * Catalogue services (Sprint 2). Prompt 6b : plus de `scope: SalonScope` en paramètre — le
 * plugin de scope (Prompt 3) injecte/valide déjà `salonId` sur toute requête TENANT_SCOPED,
 * donc le passer explicitement ici était redondant depuis Prompt 3, pas juste depuis que
 * les contrôleurs utilisent `currentScope()`.
 */
@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name) private readonly model: Model<ServiceDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    private readonly salonCatalog: SalonCatalogService,
  ) {}

  /** Persist-then-recompute (SKILL_discovery_enrichment_sponsored, Prompt 1) — jamais avant
   * l'écriture réelle du service, toujours après. */
  private async recomputeCatalogAggregates(salonId: string): Promise<void> {
    await Promise.all([this.salonCatalog.recomputePriceRange(salonId), this.salonCatalog.recomputeTags(salonId)]);
  }

  /** Liste scopée, actifs uniquement par défaut, filtrable par gender. */
  async findAll(gender?: ServiceGender): Promise<ServiceDocument[]> {
    const filter: FilterQuery<ServiceDocument> = { active: true };
    if (gender) filter.gender = gender;
    return this.model.find(filter).sort({ gender: 1, name: 1 }).exec();
  }

  async findOne(id: string): Promise<ServiceDocument> {
    const doc = await this.model.findOne({ _id: id }).exec();
    if (!doc) throw new NotFoundException('Service not found.');
    return doc;
  }

  async create(dto: CreateServiceDto): Promise<ServiceDocument> {
    const doc = await this.model.create({
      name: dto.name,
      category: dto.category ?? '',
      gender: dto.gender,
      price: dto.price,
      durationMin: dto.durationMin,
      bufferMin: dto.bufferMin ?? 0,
      color: dto.color ?? '#B89968',
      active: true,
    });
    await this.recomputeCatalogAggregates(doc.salonId);
    return doc;
  }

  async update(id: string, dto: UpdateServiceDto): Promise<ServiceDocument> {
    const doc = await this.findOne(id);
    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.gender !== undefined) doc.gender = dto.gender;
    if (dto.price !== undefined) doc.price = dto.price;
    if (dto.durationMin !== undefined) doc.durationMin = dto.durationMin;
    if (dto.bufferMin !== undefined) doc.bufferMin = dto.bufferMin;
    if (dto.color !== undefined) doc.color = dto.color;
    await doc.save();
    await this.recomputeCatalogAggregates(doc.salonId);
    return doc;
  }

  /**
   * LC-2/LC-T8 (SKILL_loss_control_doses.md) — owner-only, séparé de `update()`. Un produit
   * ne peut entrer dans le théorique d'un service que s'il est dosable : `dosesPerUnit` posé
   * ET `isConsumable:true`. Sans ce garde, un produit retail pur configuré par erreur
   * produirait un théorique incalculable (division par `dosesPerUnit` absent, calcul 2).
   */
  async updateDoseConfig(id: string, dto: UpdateServiceDoseConfigDto): Promise<ServiceDocument> {
    const doc = await this.findOne(id);

    const productIds = [...new Set(dto.doseConfig.map((d) => d.productId))];
    if (productIds.length) {
      const products = await this.productModel
        .find({ _id: { $in: productIds } })
        .select('dosesPerUnit isConsumable')
        .lean();
      const byId = new Map(products.map((p) => [p._id.toString(), p]));
      for (const productId of productIds) {
        const product = byId.get(productId);
        if (!product) throw new BadRequestException(`Produit introuvable : ${productId}.`);
        if (!product.dosesPerUnit || !product.isConsumable) {
          throw new BadRequestException("Ce produit n'est pas dosable.");
        }
      }
    }

    doc.doseConfig = dto.doseConfig;
    await doc.save();
    return doc;
  }

  /** Soft delete (Décision : jamais de hard delete) → active:false. */
  async softDelete(id: string): Promise<ServiceDocument> {
    const doc = await this.findOne(id);
    doc.active = false;
    await doc.save();
    await this.recomputeCatalogAggregates(doc.salonId);
    return doc;
  }
}
