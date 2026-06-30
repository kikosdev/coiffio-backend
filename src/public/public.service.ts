import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Testimonial, TestimonialDocument } from './schemas/testimonial.schema';

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

  async getSalonBySlug(slug: string): Promise<SalonDocument> {
    const bySlug = await this.salonModel.findOne({ slug }).lean<SalonDocument>();
    if (bySlug) return bySlug;

    const defaultId = process.env.DEFAULT_SALON_ID;
    if (defaultId) {
      const byId = await this.salonModel.findById(defaultId).lean<SalonDocument>();
      if (byId) return byId;
    }

    const count = await this.salonModel.countDocuments();
    if (count === 1) {
      const sole = await this.salonModel.findOne({}).lean<SalonDocument>();
      if (sole) return sole;
    }

    throw new NotFoundException('Salon not found');
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
