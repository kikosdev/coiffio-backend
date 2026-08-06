import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Testimonial, TestimonialDocument } from './schemas/testimonial.schema';
import { computeSalonIsOpen } from '../common/time/salon-clock';

const MAX_LIST_SALONS = 100;

export interface PublicSalonSummary {
  id: string;
  slug: string;
  name: string;
  address: string;
  coverImage: string | null;
  rating: number | null;
  isOpen: boolean | null;
}

@Injectable()
export class PublicService {
  constructor(
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Testimonial.name) private readonly testimonialModel: Model<TestimonialDocument>,
  ) {}

  /**
   * Sprint 2 v2 Prompt 4 : le fallback `DEFAULT_SALON_ID` a été retiré — il aurait servi le
   * MAUVAIS salon en silence pour un slug introuvable/typo, exactement le bug que ce prompt
   * corrige ailleurs (`resolveSalonId()`/`register()`). Le fallback "1 seul salon en base →
   * le renvoyer" reste : contrairement à `DEFAULT_SALON_ID`, il s'auto-désactive dès qu'un
   * 2e tenant existe (jamais un risque en usage multi-tenant réel), utile seulement au
   * confort dev/local à 1 salon.
   */
  async getSalonBySlug(slug: string): Promise<SalonDocument> {
    const bySlug = await this.salonModel.findOne({ slug }).lean<SalonDocument>();
    if (bySlug) return bySlug;

    const count = await this.salonModel.countDocuments();
    if (count === 1) {
      const sole = await this.salonModel.findOne({}).lean<SalonDocument>();
      if (sole) return sole;
    }

    throw new NotFoundException('Salon not found');
  }

  /**
   * Discovery-only cross-salon list (SKILL_home_list_all_salons) — deliberately not tenant-
   * scoped at all (cross-salon by design). No `isActive` field exists on Salon today, so
   * every seeded salon is returned; add that filter once the field lands rather than
   * fabricating it here. Superseded by DiscoveryService (Prompt 5) for new consumers, but
   * left in place since removing it would be an API contract change (out of this prompt's
   * scope).
   */
  async listAll(): Promise<PublicSalonSummary[]> {
    const salons = await this.salonModel
      .find({})
      .sort({ name: 1 })
      .limit(MAX_LIST_SALONS)
      .select('slug name address businessHours')
      .lean();

    return salons.map((s) => ({
      id: String((s as any)._id),
      slug: s.slug ?? '',
      name: s.name,
      address: s.address ?? '',
      coverImage: null, // pas de champ image sur Salon aujourd'hui
      rating: null, // pas de collection reviews aujourd'hui
      isOpen: computeSalonIsOpen(s),
    }));
  }

  /** Single-salon profile card (SKILL_fix_booking_real_staff_availability) — by Mongo _id. */
  async getOne(id: string): Promise<PublicSalonSummary> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Salon not found');
    const s = await this.salonModel.findById(id).select('slug name address businessHours').lean();
    if (!s) throw new NotFoundException('Salon not found');

    return {
      id: String((s as any)._id),
      slug: s.slug ?? '',
      name: s.name,
      address: s.address ?? '',
      coverImage: null,
      rating: null,
      isOpen: computeSalonIsOpen(s),
    };
  }

  async getLanding(slug: string) {
    const salon = await this.getSalonBySlug(slug);
    const salonId = String((salon as any)._id);

    const openedAt = salon.landing?.openedAt || (salon as any).createdAt;
    const yearsOpen = openedAt
      ? Math.floor((Date.now() - new Date(openedAt).getTime()) / (365.25 * 24 * 3600 * 1000))
      : 0;

    const [stylistsCount, loyalClients] = await Promise.all([
      this.profileModel.countDocuments({ salonId, isPublicOnLanding: { $ne: false } }),
      this.clientModel.countDocuments({ salonId }),
    ]);

    let signature: { title: string; duration: string; fromPrice: number } | null = null;
    if (salon.landing?.signatureServiceId) {
      const sig = await this.serviceModel.findById(salon.landing.signatureServiceId).lean();
      if (sig) {
        const h = Math.floor(sig.durationMin / 60);
        const m = sig.durationMin % 60;
        const duration = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
        signature = { title: sig.name, duration, fromPrice: sig.price };
      }
    }

    return {
      salon: { name: salon.name, slug: salon.slug, locale: 'EN · €' },
      landing: salon.landing ?? {},
      signature,
      stats: { yearsOpen, stylistsCount, loyalClients },
      contact: salon.contact ?? {},
      hours: salon.hours ?? [],
    };
  }

  async getFeaturedServices(slug: string, limit = 6) {
    const salon = await this.getSalonBySlug(slug);
    return this.serviceModel
      .find({
        salonId: String((salon as any)._id),
        active: true,
        isPublic: { $ne: false },
        isFeatured: { $ne: false },
      })
      .sort({ featuredOrder: 1, createdAt: 1 })
      .limit(limit)
      .select('name category gender price durationMin color')
      .lean();
  }

  async getPublicTeam(slug: string) {
    const salon = await this.getSalonBySlug(slug);
    const salonId = String((salon as any)._id);

    const staff = await this.staffModel
      .find({ salonId, isActive: true, 'publicProfile.visible': true })
      .sort({ 'publicProfile.order': 1, name: 1 })
      .select('name role color publicProfile')
      .lean();

    const profiles = await this.profileModel
      .find({ salonId, userId: { $in: staff.map((s) => (s as any)._id) } })
      .select('userId level publicTitle seniorityTag landingOrder')
      .lean();
    const profileByUser = new Map(profiles.map((p) => [String(p.userId), p]));

    // PROJECTION STRICTE — jamais passwordHash, email, phone, salonId.
    return staff.map((s) => {
      const id = String((s as any)._id);
      const profile = profileByUser.get(id);
      return {
        id,
        _id: id,
        name: s.name,
        role: s.role,
        color: s.color,
        title: s.publicProfile?.title ?? '',
        bio: s.publicProfile?.bio ?? '',
        publicTitle: profile?.publicTitle || s.publicProfile?.title || '',
        seniorityTag: profile?.seniorityTag ?? '',
        level: profile?.level ?? '',
        landingOrder: profile?.landingOrder ?? 0,
        nextSlot: null as string | null,
      };
    });
  }

  async getTestimonials(slug: string, limit = 3) {
    const salon = await this.getSalonBySlug(slug);
    return this.testimonialModel
      .find({ salonId: String((salon as any)._id), isApproved: true })
      .sort({ order: 1 })
      .limit(limit)
      .select('quote authorName authorMeta')
      .lean();
  }
}
