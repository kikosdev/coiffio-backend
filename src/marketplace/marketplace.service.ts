import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { computeSalonIsOpen, computeStaffOnShiftToday } from '../common/time/salon-clock';

export interface CategoryChip {
  category: string;
  serviceCount: number;
}

export interface ServiceHit {
  name: string;
  category: string;
  durationMin: number | null;
  gender: string;
  salonCount: number;
}

export interface SalonOffering {
  salonId: string;
  name: string;
  address: string;
  serviceName: string | null;
  price: number | null;
  durationMin: number | null;
  distanceKm: number | null;
  isOpen: boolean | null;
  coverImage: string | null;
}

export interface PublicBarber {
  staffId: string;
  salonId: string;
  name: string;
  title: string;
  isPro: boolean;
  isAvailable: boolean;
  initials: string;
}

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
  ) {}

  /** Browse : catégories réellement offertes (SD-1 — `category` est un champ libre, pas un enum). */
  async getCategories(): Promise<CategoryChip[]> {
    const rows = await this.serviceModel.aggregate([
      { $match: { active: true, isPublic: true, category: { $ne: '' } } },
      { $group: { _id: '$category', serviceCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({ category: r._id, serviceCount: r.serviceCount }));
  }

  /** Search : recherche libre sur `name`, tous salons actifs/publics (A2 — jamais de prix ici). */
  async searchByName(q: string): Promise<ServiceHit[]> {
    const services = await this.serviceModel
      .find({ active: true, isPublic: true, name: { $regex: q, $options: 'i' } })
      .select('name category durationMin gender')
      .lean();

    const seen = new Map<string, ServiceHit>();
    for (const s of services) {
      const key = s.name.toLowerCase();
      const existing = seen.get(key);
      if (existing) existing.salonCount++;
      else seen.set(key, { name: s.name, category: s.category, durationMin: s.durationMin ?? null, gender: s.gender, salonCount: 1 });
    }
    return [...seen.values()];
  }

  /** Tier-2 : salons offering all selected categories/names, with their combined best price. */
  async findOfferings(
    filter: { category?: string; categories?: string | string[]; name?: string; names?: string | string[] },
    lat?: number,
    lng?: number,
  ): Promise<SalonOffering[]> {
    const categories = this.uniqueList([filter.category, ...this.asList(filter.categories)]);
    const names = this.uniqueList([filter.name, ...this.asList(filter.names)]);
    if (categories.length === 0 && names.length === 0) {
      throw new BadRequestException('category/categories or name/names is required.');
    }

    const criteria = [
      ...categories.map((value) => ({ key: `category:${value.toLowerCase()}`, field: 'category' as const, value, re: new RegExp(`^${this.escapeRegex(value)}$`, 'i') })),
      ...names.map((value) => ({ key: `name:${value.toLowerCase()}`, field: 'name' as const, value, re: new RegExp(`^${this.escapeRegex(value)}$`, 'i') })),
    ];

    const services = await this.serviceModel
      .find({
        active: true,
        isPublic: true,
        $or: criteria.map((c) => ({ [c.field]: c.re })),
      })
      .select('salonId name category price durationMin')
      .lean();

    const bySalon = new Map<string, {
      matches: Map<string, { id: string; name: string; price: number; durationMin: number }>;
    }>();
    for (const s of services) {
      const salonKey = s.salonId.toString();
      const row = bySalon.get(salonKey) ?? { matches: new Map<string, { id: string; name: string; price: number; durationMin: number }>() };
      for (const criterion of criteria) {
        const value = criterion.field === 'category' ? s.category : s.name;
        if (!criterion.re.test(value ?? '')) continue;
        const current = row.matches.get(criterion.key);
        if (!current || s.price < current.price) {
          row.matches.set(criterion.key, { id: s._id.toString(), name: s.name, price: s.price, durationMin: s.durationMin ?? 0 });
        }
      }
      bySalon.set(salonKey, row);
    }

    const matched = [...bySalon.entries()].filter(([, row]) => row.matches.size === criteria.length);
    const salonIds = matched.map(([id]) => new Types.ObjectId(id));
    if (salonIds.length === 0) return [];

    let salons: any[];
    if (lat != null && lng != null) {
      salons = await this.salonModel.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [lng, lat] },
            distanceField: 'distanceMeters',
            spherical: true,
            query: { _id: { $in: salonIds } },
          },
        },
      ]);
    } else {
      salons = await this.salonModel.find({ _id: { $in: salonIds } }).sort({ name: 1 }).lean();
    }

    return salons.map((s): SalonOffering => {
      const row = bySalon.get(s._id.toString());
      const matchedServices = this.uniqueServices(row ? [...row.matches.values()] : []);
      return {
        salonId: s._id.toString(),
        name: s.name,
        address: s.address ?? '',
        serviceName: matchedServices.length ? matchedServices.map((service) => service.name).join(' + ') : null,
        price: matchedServices.length ? matchedServices.reduce((sum, service) => sum + service.price, 0) : null,
        durationMin: matchedServices.length ? matchedServices.reduce((sum, service) => sum + service.durationMin, 0) : null,
        distanceKm: s.distanceMeters != null ? Math.round((s.distanceMeters / 1000) * 10) / 10 : null,
        isOpen: computeSalonIsOpen(s),
        coverImage: null, // pas de champ image sur Salon aujourd'hui
      };
    });
  }

  /** Tier-1 : barbers (availability only, A3 — jamais de note/reviews). */
  async listPublicBarbers(): Promise<PublicBarber[]> {
    const staff = await this.staffModel
      .find({ role: { $in: ['stylist', 'colorist'] }, isActive: true, 'publicProfile.visible': true })
      .select('name salonId week publicProfile acceptingBookings')
      .lean();

    // ⚠️ StaffProfile.userId stocke en réalité Staff._id (pas l'identité User) — cf public.service.ts.
    const profiles = await this.profileModel
      .find({ userId: { $in: staff.map((s) => s._id) } })
      .select('userId publicTitle seniorityTag')
      .lean();
    const profileByStaffId = new Map(profiles.map((p) => [p.userId.toString(), p]));

    return staff.map((s): PublicBarber => {
      const profile = profileByStaffId.get(s._id.toString());
      return {
        staffId: s._id.toString(),
        salonId: s.salonId.toString(),
        name: s.name,
        title: profile?.publicTitle || s.publicProfile?.title || '',
        isPro: profile?.seniorityTag === 'Master',
        isAvailable: computeStaffOnShiftToday(s) && s.acceptingBookings !== false,
        initials: s.name.split(' ').map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase(),
      };
    });
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private asList(value?: string | string[]): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  private uniqueList(values: Array<string | undefined>): string[] {
    return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];
  }

  private uniqueServices<T extends { id: string }>(services: T[]): T[] {
    return [...new Map(services.map((service) => [service.id, service])).values()];
  }
}
