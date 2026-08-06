import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Location, LocationDocument, LocationGeoPoint } from './schemas/location.schema';
import { CreateLocationDto, LocationAddressDto, UpdateLocationDto } from './dto/location.dto';
import { SalonScope } from '../common/scope/salon-scope';

// Placeholder Sprint 1 — le Control Plane (Prompt 7) n'existe pas encore, donc pas de
// limits.locationsMax réel par plan. Fallback générique le temps que l'entitlements
// service soit branché ; ne JAMAIS bloquer le provisioning en attendant.
const DEFAULT_LOCATIONS_MAX = Number(process.env.LOCATIONS_MAX_DEFAULT ?? 5);

function toGeoPoint(address?: LocationAddressDto): LocationGeoPoint | undefined {
  if (address?.lat == null || address?.lng == null) return undefined;
  return { type: 'Point', coordinates: [address.lng, address.lat] };
}

/**
 * ⚠️ Exception délibérée au nettoyage Prompt 6b (retrait de `scope: SalonScope` des
 * services) : CE service le garde. `TenantContextMiddleware` (tenant-context.middleware.ts)
 * appelle `findAllForTenant`/`findPrimary` AVANT qu'un TenantContext n'existe — c'est
 * littéralement ce qui sert à le construire (résolution de `locationId`/`locationIds`).
 * `getTenantContext()` y throw systématiquement (chicken-and-egg structurel, pas un oubli).
 * Les autres call sites (contrôleurs, BookingService, ClientProfileService via
 * `runWithTenant(systemReadContext(tenantId), ...)`) ont tous un contexte déjà établi et
 * pourraient s'en passer, mais un seul point d'entrée (le bootstrap) l'exige — donc
 * `scope` reste le paramètre pour TOUT le service, plutôt que deux API différentes pour
 * la même classe.
 */
@Injectable()
export class LocationService {
  constructor(@InjectModel(Location.name) private readonly model: Model<LocationDocument>) {}

  /** Toutes les locations actives du tenant. Le filtrage par locationIds du caller
   *  arrive avec le TenantContext (Prompt 2) — non applicable tant qu'il n'existe pas. */
  async findAllForTenant(scope: SalonScope, includeInactive = false): Promise<LocationDocument[]> {
    const filter: Record<string, unknown> = { salonId: scope.salonId };
    if (!includeInactive) filter.active = true;
    return this.model.find(filter).sort({ isPrimary: -1, name: 1 }).exec();
  }

  async findPrimary(scope: SalonScope): Promise<LocationDocument> {
    const doc = await this.model.findOne({ salonId: scope.salonId, isPrimary: true }).exec();
    if (!doc) throw new NotFoundException('No primary location configured for this salon.');
    return doc;
  }

  async findOne(scope: SalonScope, id: string): Promise<LocationDocument> {
    const doc = await this.model.findOne({ _id: id, salonId: scope.salonId }).exec();
    if (!doc) throw new NotFoundException('Location not found.');
    return doc;
  }

  async create(scope: SalonScope, dto: CreateLocationDto): Promise<LocationDocument> {
    const activeCount = await this.model.countDocuments({ salonId: scope.salonId, active: true });
    if (activeCount >= DEFAULT_LOCATIONS_MAX) {
      throw new ForbiddenException({
        code: 'LOCATIONS_MAX_REACHED',
        message: `Plan limit reached: ${DEFAULT_LOCATIONS_MAX} location(s) max.`,
      });
    }

    // Une location créée via cet endpoint n'est jamais primaire — la primaire est
    // auto-créée au provisioning (migrate-create-primary-locations.ts / internal API).
    return this.model.create({
      salonId: scope.salonId,
      name: dto.name,
      slug: dto.slug,
      address: dto.address ?? {},
      geo: toGeoPoint(dto.address),
      phone: dto.phone ?? '',
      timezone: dto.timezone ?? 'Africa/Tunis',
      openingHours: dto.openingHours ?? [],
      region: dto.region,
      isPrimary: false,
      active: true,
    });
  }

  async update(scope: SalonScope, id: string, dto: UpdateLocationDto): Promise<LocationDocument> {
    const doc = await this.findOne(scope, id);

    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.slug !== undefined) doc.slug = dto.slug;
    if (dto.phone !== undefined) doc.phone = dto.phone;
    if (dto.timezone !== undefined) doc.timezone = dto.timezone;
    if (dto.openingHours !== undefined) doc.openingHours = dto.openingHours;
    if (dto.region !== undefined) doc.region = dto.region;
    if (dto.active !== undefined) {
      if (doc.isPrimary && dto.active === false) {
        throw new ForbiddenException('Cannot deactivate the primary location.');
      }
      doc.active = dto.active;
    }
    if (dto.address !== undefined) {
      doc.address = { ...doc.address, ...dto.address };
      const merged = toGeoPoint({ lat: doc.address.lat, lng: doc.address.lng });
      if (merged) doc.geo = merged;
    }

    await doc.save();
    return doc;
  }

  /** Soft delete — jamais de hard delete. Interdit sur la location primaire. */
  async deactivate(scope: SalonScope, id: string): Promise<LocationDocument> {
    const doc = await this.findOne(scope, id);
    if (doc.isPrimary) {
      throw new ForbiddenException('Cannot deactivate the primary location.');
    }
    doc.active = false;
    await doc.save();
    return doc;
  }
}
