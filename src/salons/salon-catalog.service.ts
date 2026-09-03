import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';

interface PriceRangeAgg {
  min: number;
  max: number;
}

export interface PriceRange {
  min: number;
  max: number;
}

interface TagAgg {
  _id: string;
}

/**
 * Agrégats Salon dérivés du catalogue (SKILL_discovery_enrichment_sponsored, Prompt 1).
 * Event-driven depuis ServicesService (create/update/soft-delete) — pas de job cron.
 * `Salon` est UNSCOPED (aucun TenantContext requis pour y écrire) ; `Service` est
 * TENANT_SCOPED (le plugin de scope exige un contexte déjà posé par l'appelant — toujours
 * vrai ici puisque ServicesService s'exécute derrière JwtGuard, ou depuis un script sous
 * `runOutsideTenant`).
 *
 * `compute*` (lecture pure) / `recompute*` (lecture + écriture) sont séparées exprès :
 * le backfill (Prompt 2) a besoin d'un dry-run qui n'écrit rien, sans dupliquer le pipeline
 * d'agrégation dans le script — il appelle `compute*`, jamais sa propre version.
 */
@Injectable()
export class SalonCatalogService {
  constructor(
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
  ) {}

  /** { min, max } sur les services actifs ; `null` si aucun service actif (→ unset, jamais {min:undefined}). */
  async computePriceRange(salonId: string): Promise<PriceRange | null> {
    const [agg] = await this.serviceModel.aggregate<PriceRangeAgg>([
      { $match: { salonId, active: true } },
      { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } },
    ]);
    return agg ? { min: agg.min, max: agg.max } : null;
  }

  /** Catégories distinctes des services actifs, triées. `$group` plutôt que `.distinct()` :
   * `distinct` n'est pas dans QUERY_HOOKS (tenant-scope.plugin.ts) et échapperait donc à
   * l'enforcement du plugin — `aggregate()` y passe toujours. */
  async computeTags(salonId: string): Promise<string[]> {
    const rows = await this.serviceModel.aggregate<TagAgg>([
      { $match: { salonId, active: true, category: { $exists: true, $ne: '' } } },
      { $group: { _id: '$category' } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => r._id);
  }

  async recomputePriceRange(salonId: string): Promise<void> {
    const priceRange = await this.computePriceRange(salonId);
    await this.salonModel.updateOne(
      { _id: salonId },
      priceRange ? { $set: { priceRange } } : { $unset: { priceRange: 1 } },
    );
  }

  async recomputeTags(salonId: string): Promise<void> {
    const serviceTags = await this.computeTags(salonId);
    await this.salonModel.updateOne({ _id: salonId }, { $set: { serviceTags } });
  }
}
