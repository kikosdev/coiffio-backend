import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { Location, LocationDocument } from '../locations/schemas/location.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Testimonial, TestimonialDocument } from '../public/schemas/testimonial.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { BookingService, StylistAvailability } from '../booking/booking.service';
import { runAsDiscovery, runAsGuest } from '../common/tenant/tenant-context';
import { DiscoveryCacheService } from './discovery-cache.service';
import { SalonAvailabilityQueryDto } from './dto/discovery.dto';
import { PriceRange } from '../salons/salon-catalog.service';

const CACHE_TTL_MS = 5 * 60_000;
const SCRAPE_LOG_THRESHOLD = 50;
// Plafond de candidats lus AVANT le tri sponsorisé-d'abord — sans lui, le `$limit`/`.limit()`
// Mongo tronquerait la liste avant même de savoir qui est sponsorisé, et un salon sponsorisé
// pourrait ne jamais atteindre le tri. Toujours >= au max DTO (50) pour que le tri porte sur
// tout ce qu'un appelant peut légitimement demander.
const DISCOVERY_CANDIDATE_CEILING = 50;

export interface DiscoveryLocationHit {
  salonSlug: string;
  salonName: string;
  locationName: string;
  address: { line1?: string; city?: string; postalCode?: string; country?: string };
  lat: number | null;
  lng: number | null;
  phone: string;
  openingHours: unknown[];
  region?: string;
  distanceMeters: number | null;
  coverImage: string | null;
  priceRange: PriceRange | null;
  serviceTags: string[];
  sponsored: boolean;
}

export interface SalonProfile {
  slug: string;
  name: string;
  coverImage: string | null;
  priceRange: PriceRange | null;
  serviceTags: string[];
  sponsored: boolean;
  locations: Array<{ name: string; address: unknown; phone: string; openingHours: unknown[]; region?: string }>;
  services: Array<{ name: string; category: string; price: number; durationMin: number }>;
  testimonials: Array<{ quote: string; authorFirstName: string; createdAt: Date }>;
  team: Array<{ name: string; role: string; avatar: null }>;
}

export interface SponsoredSalonHit {
  slug: string;
  name: string;
  city: string | null;
  coverImage: string | null;
  priceRange: PriceRange | null;
  serviceTags: string[];
}

interface SponsorshipFields {
  sponsored?: boolean;
  sponsoredUntil?: Date | null;
}

/**
 * `sponsored_actif` — calculé à la lecture, jamais lu tel quel (Décision #6 du skill).
 * Comparaison d'INSTANT (Date > Date) : `sponsoredUntil` est un timestamp absolu (UTC en
 * interne, comme tout Date Mongo/JS), donc `new Date(x).getTime() > Date.now()` suffit et
 * est déjà correct. PAS de `toZonedTime()`/`formatInTimeZone()` ici : ça décalerait l'instant
 * comparé de l'offset Africa/Tunis, exactement la classe de bug déjà rencontrée sur les
 * dates de booking côté front (`localDateISO()`, jamais `toISOString()` pour ce genre de
 * comparaison). date-fns-tz n'a de sens que pour un AFFICHAGE humain, jamais pour ce calcul.
 */
function isSponsoredActive(salon: SponsorshipFields): boolean {
  return !!salon.sponsored && !!salon.sponsoredUntil && new Date(salon.sponsoredUntil).getTime() > Date.now();
}

/**
 * Lecture cross-tenant publique (Sprint 1 v2, Prompt 5). RÈGLE ABSOLUE : c'est une
 * VITRINE — aucune donnée opérationnelle n'en sort. La whitelist de champs est implémentée
 * en dur ici (via `.select()` explicite sur chaque requête) ET, en filet de sécurité, par
 * le plugin lui-même dès qu'il voit `isDiscoveryContext(store)` — jamais un simple
 * laisser-passer (voir `tenant-scope.plugin.ts`). Tout accès passe par `runAsDiscovery()`,
 * la seule fonction capable de poser ce mode (WeakSet privé, non falsifiable ailleurs).
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Testimonial.name) private readonly testimonialModel: Model<TestimonialDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly booking: BookingService,
    // Injecté (Prompt 6, Partie A) plutôt qu'instancié en privé : la MÊME instance doit être
    // invalidable depuis `InternalService.updateSponsorship()` après une écriture CP.
    private readonly cache: DiscoveryCacheService,
  ) {}

  private logIfScraping(count: number, endpoint: string): void {
    if (count > SCRAPE_LOG_THRESHOLD) {
      this.logger.warn(`Discovery query on ${endpoint} returned ${count} results (>${SCRAPE_LOG_THRESHOLD}) — possible scraping.`);
    }
  }

  /** Ensemble des salons actifs — jamais exposé tel quel, sert uniquement à filtrer
   *  les locations/services/etc. par tenant autorisé. Porte aussi `sponsored`/`sponsoredUntil`
   *  bruts (nécessaires à `isSponsoredActive()`) et `coverImage`/`priceRange`/`serviceTags`
   *  — aucun des cinq n'est jamais renvoyé tel quel, voir le commentaire sur
   *  `PUBLIC_DISCOVERY_FIELDS.salons`. */
  private async activeSalonMap(): Promise<Map<string, SalonDocument>> {
    const salons = await this.salonModel
      .find({ status: 'active' })
      .select('name slug coverImage priceRange serviceTags sponsored sponsoredUntil')
      .exec();
    return new Map(salons.map((s) => [s._id.toString(), s]));
  }

  /** Tri from-scratch (aucun tri Mongo natif à ce jour sur by-region ; nearby est trié par
   *  $geoNear, pas par sponsorship) : sponsorisé actif d'abord, puis le critère naturel de
   *  l'endpoint. Appliqué en JS après lecture — sponsored vit sur `salons`, distance/nom sur
   *  la ligne courante, pas de champ commun à agréger côté Mongo simplement. */
  private sortDiscoveryHits(hits: DiscoveryLocationHit[], secondary: 'distance' | 'name'): DiscoveryLocationHit[] {
    return [...hits].sort((a, b) => {
      if (a.sponsored !== b.sponsored) return a.sponsored ? -1 : 1;
      if (secondary === 'distance') return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
      return a.salonName.localeCompare(b.salonName);
    });
  }

  async nearby(lat: number, lng: number, radiusKm = 10, limit = 20): Promise<DiscoveryLocationHit[]> {
    const key = `nearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}:${limit}`;
    return this.cache.getOrSet(key, CACHE_TTL_MS, () =>
      runAsDiscovery(async () => {
        const activeSalons = await this.activeSalonMap();
        const activeSalonIds = [...activeSalons.keys()];
        if (activeSalonIds.length === 0) return [];

        const rows = await this.locationModel
          .aggregate<LocationDocument & { distanceMeters: number }>([
            {
              $geoNear: {
                near: { type: 'Point', coordinates: [lng, lat] },
                distanceField: 'distanceMeters',
                maxDistance: radiusKm * 1000,
                spherical: true,
                query: { active: true, salonId: { $in: activeSalonIds } },
              },
            },
            { $limit: Math.max(limit, DISCOVERY_CANDIDATE_CEILING) },
          ])
          .exec();

        this.logIfScraping(rows.length, '/discovery/nearby');

        const hits = rows.map((r) => this.toLocationHit(r, activeSalons.get(r.salonId)!, r.distanceMeters));
        return this.sortDiscoveryHits(hits, 'distance').slice(0, limit);
      }),
    );
  }

  async byRegion(region: string, limit = 20): Promise<DiscoveryLocationHit[]> {
    const key = `by-region:${region.toLowerCase()}:${limit}`;
    return this.cache.getOrSet(key, CACHE_TTL_MS, () =>
      runAsDiscovery(async () => {
        const activeSalons = await this.activeSalonMap();
        const activeSalonIds = [...activeSalons.keys()];
        if (activeSalonIds.length === 0) return [];

        const rows = await this.locationModel
          .find({ active: true, region, salonId: { $in: activeSalonIds } })
          .select('name address phone openingHours region salonId')
          .limit(Math.max(limit, DISCOVERY_CANDIDATE_CEILING))
          .lean()
          .exec();

        this.logIfScraping(rows.length, '/discovery/by-region');

        const hits = rows.map((r) => this.toLocationHit(r as unknown as LocationDocument, activeSalons.get((r as unknown as LocationDocument).salonId)!, null));
        return this.sortDiscoveryHits(hits, 'name').slice(0, limit);
      }),
    );
  }

  /** [Prompt 4, `city` ajouté Prompt 6] Salons sponsorisés actifs uniquement, triés par nom
   *  (pas de rating en v1) — alimente la section Showcase de la landing plateforme. Liste
   *  vide → [] ; le front masque la section entière plutôt que d'afficher un état vide
   *  disgracieux dessus. `city` vient de la location primaire (pas de champ ville sur
   *  `Salon` lui-même) — absente si la location n'a pas encore de `address.city` renseigné,
   *  jamais fabriquée. */
  async sponsored(limit = 8): Promise<SponsoredSalonHit[]> {
    const key = `sponsored:${limit}`;
    return this.cache.getOrSet(key, CACHE_TTL_MS, () =>
      runAsDiscovery(async () => {
        const activeSalons = await this.activeSalonMap();
        const activeList = [...activeSalons.values()].filter((s) => isSponsoredActive(s));
        if (activeList.length === 0) return [];

        const salonIds = activeList.map((s) => s._id.toString());
        const primaryLocations = await this.locationModel
          .find({ salonId: { $in: salonIds }, isPrimary: true, active: true })
          .select('salonId address')
          .lean();
        const cityBySalonId = new Map(primaryLocations.map((l) => [l.salonId, l.address?.city || null]));

        const hits: SponsoredSalonHit[] = activeList
          .map((s) => ({
            slug: s.slug,
            name: s.name,
            city: cityBySalonId.get(s._id.toString()) ?? null,
            coverImage: s.coverImage ?? null,
            priceRange: s.priceRange ?? null,
            serviceTags: s.serviceTags ?? [],
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return hits.slice(0, limit);
      }),
    );
  }

  async regions(): Promise<string[]> {
    const key = 'regions';
    return this.cache.getOrSet(key, CACHE_TTL_MS, () =>
      runAsDiscovery(async () => {
        const activeSalons = await this.activeSalonMap();
        const activeSalonIds = [...activeSalons.keys()];
        if (activeSalonIds.length === 0) return [];

        const rows = await this.locationModel.aggregate<{ _id: string; count: number }>([
          { $match: { active: true, salonId: { $in: activeSalonIds }, region: { $exists: true, $ne: null } } },
          { $group: { _id: '$region', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]);
        return rows.map((r) => r._id).filter(Boolean);
      }),
    );
  }

  async salonProfile(slug: string): Promise<SalonProfile> {
    return runAsDiscovery(async () => {
      const salon = await this.salonModel
        .findOne({ slug, status: 'active' })
        .select('name slug coverImage priceRange serviceTags sponsored sponsoredUntil')
        .exec();
      if (!salon) throw new NotFoundException('Salon not found.');
      const salonId = salon._id.toString();

      const [locations, services, testimonials, team] = await Promise.all([
        this.locationModel.find({ salonId, active: true }).select('name address phone openingHours region').lean().exec(),
        this.serviceModel.find({ salonId, active: true, isPublic: true }).select('name category price durationMin').lean().exec(),
        this.testimonialModel.find({ salonId, isApproved: true }).sort({ order: 1 }).select('quote authorName createdAt').lean().exec(),
        // Backstop plugin déjà appliqué (publicProfile.visible:true forcé) — filtre explicite ici aussi.
        this.staffModel.find({ salonId, isActive: true, 'publicProfile.visible': true }).select('name role').lean().exec(),
      ]);

      return {
        slug: salon.slug,
        name: salon.name,
        coverImage: salon.coverImage ?? null,
        priceRange: salon.priceRange ?? null,
        serviceTags: salon.serviceTags ?? [],
        sponsored: isSponsoredActive(salon),
        locations: locations.map((l) => ({ name: l.name, address: l.address, phone: l.phone, openingHours: l.openingHours, region: l.region })),
        services: services.map((s) => ({ name: s.name, category: s.category, price: s.price, durationMin: s.durationMin })),
        testimonials: testimonials.map((t) => ({
          quote: t.quote,
          authorFirstName: (t.authorName ?? '').split(' ')[0] ?? '',
          createdAt: (t as unknown as { createdAt: Date }).createdAt,
        })),
        team: team.map((s) => ({ name: s.name, role: s.role, avatar: null })),
      };
    });
  }

  /**
   * Disponibilité publique — LIVE, jamais stockée. Un tenant précis est déjà identifié
   * (via le slug) : ce n'est plus de la découverte cross-tenant, donc `runAsGuest`
   * (contexte normal, scopé à ce tenant/cette location), pas `runAsDiscovery`. Réutilise
   * le moteur de disponibilité existant (BookingService) plutôt que d'en réinventer un.
   */
  async availability(slug: string, query: SalonAvailabilityQueryDto): Promise<StylistAvailability[]> {
    // Résolution du salon + de la location : lecture cross-tenant, donc discovery.
    const { tenantId, locationId } = await runAsDiscovery(async () => {
      const salon = await this.salonModel.findOne({ slug, status: 'active' }).select('name slug').exec();
      if (!salon) throw new NotFoundException('Salon not found.');
      const salonId = salon._id.toString();

      const location = query.locationId
        ? await this.locationModel.findOne({ _id: query.locationId, salonId, active: true }).select('name').exec()
        : await this.locationModel.findOne({ salonId, isPrimary: true, active: true }).select('name').exec();
      if (!location) throw new NotFoundException('Location not found.');

      return { tenantId: salonId, locationId: location._id.toString() };
    });

    return runAsGuest(tenantId, locationId, () =>
      this.booking.availability({ serviceId: query.serviceId, date: query.date }),
    );
  }

  private toLocationHit(loc: LocationDocument, salon: SalonDocument, distanceMeters: number | null): DiscoveryLocationHit {
    return {
      salonSlug: salon.slug,
      salonName: salon.name,
      locationName: loc.name,
      address: { line1: loc.address?.line1, city: loc.address?.city, postalCode: loc.address?.postalCode, country: loc.address?.country },
      lat: loc.address?.lat ?? null,
      lng: loc.address?.lng ?? null,
      phone: loc.phone,
      openingHours: loc.openingHours,
      region: loc.region,
      distanceMeters,
      coverImage: salon.coverImage ?? null,
      priceRange: salon.priceRange ?? null,
      serviceTags: salon.serviceTags ?? [],
      sponsored: isSponsoredActive(salon),
    };
  }
}
