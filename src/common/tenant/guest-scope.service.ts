import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Salon, SalonDocument } from '../../seed/schemas/salon.schema';
import { Location, LocationDocument } from '../../locations/schemas/location.schema';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Feature } from '../entitlements/entitlements.types';
import { assertFeature } from '../entitlements/entitlements.assertions';
import { runAsDiscovery, runAsGuest } from './tenant-context';

/**
 * Résout tenant (par slug) + location (explicite ou primaire) pour les routes PUBLIQUES
 * (storefront, sans JWT) et pose le TenantContext manquant via `runAsGuest` (Sprint 1 v2,
 * Prompt 6, Partie C — bug trouvé en testant : `getSalonScope(req)` renvoie un objet simple
 * sans jamais poser de contexte AsyncLocalStorage, alors que le plugin de scope (Prompt 3)
 * exige `getTenantContext()` pour toute collection TENANT/LOCATION_SCOPED — 500 systématique
 * sur toute requête sans JWT). Réplique le pattern déjà validé par
 * `DiscoveryService.availability()` (Prompt 5) : résolution slug/location en mode
 * découverte (cross-tenant, lecture whitelisted), PUIS bascule sur un contexte guest normal
 * (scopé à CE tenant/CETTE location) pour l'opération réelle.
 *
 * Aucun fallback silencieux : slug ou location introuvable → NotFoundException (404 propre),
 * jamais un 500 générique ni un DEFAULT_SALON_ID deviné.
 */
@Injectable()
export class GuestScopeService {
  constructor(
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * `requiredFeature` optionnel : équivalent guest du `@RequiresFeature`/`FeatureGuard`
   * backoffice. Un `CanActivate` classique ne peut PAS faire ce check pour ces routes — le
   * TenantContext n'existe qu'À L'INTÉRIEUR du callback `runAsGuest`, pas encore à la phase
   * guard (avant que `run()` soit même appelé). Donc vérifié ici, manuellement, avec le
   * même payload 403 que `FeatureGuard` (`assertFeature`, partagé).
   */
  async run<T>(
    slug: string,
    explicitLocationId: string | undefined,
    fn: () => Promise<T>,
    requiredFeature?: Feature,
  ): Promise<T> {
    const { tenantId, locationId } = await runAsDiscovery(async () => {
      const salon = await this.salonModel.findOne({ slug, status: 'active' }).select('_id').exec();
      if (!salon) throw new NotFoundException('Salon not found.');
      const tenantId = (salon._id as Types.ObjectId).toString();

      const location = explicitLocationId
        ? await this.locationModel.findOne({ _id: explicitLocationId, salonId: tenantId, active: true }).select('_id').exec()
        : await this.locationModel.findOne({ salonId: tenantId, isPrimary: true, active: true }).select('_id').exec();
      if (!location) throw new NotFoundException('Location not found.');

      return { tenantId, locationId: (location._id as Types.ObjectId).toString() };
    });

    // Prompt 7 : entitlements réelles (jamais throw, fallback starter géré par le service
    // lui-même) — sans ça, `@RequiresFeature('ecommerce')` sur le storefront public lirait
    // un `features: {}` vide et bloquerait tout visiteur.
    const resolved = await this.entitlements.resolve(tenantId);
    if (requiredFeature) assertFeature(resolved.plan, resolved.features, requiredFeature);
    return runAsGuest(tenantId, locationId, fn, resolved);
  }
}
