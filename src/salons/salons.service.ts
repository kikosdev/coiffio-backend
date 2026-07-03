import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { computeSalonIsOpen } from '../common/time/salon-clock';

export interface NearbySalon {
  id: string;
  name: string;
  address: string;
  coverImage: string | null;
  distanceKm: number | null;
  rating: number | null;
  isOpen: boolean | null;
  lat: number | null;
  lng: number | null;
}

const MAX_RESULTS = 20;
const MAX_UNGEOCODED = 10;

@Injectable()
export class SalonsService {
  constructor(@InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>) {}

  async findNearby(lat: number, lng: number, radiusKm: number): Promise<NearbySalon[]> {
    // Salons géolocalisés, triés par distance croissante (exclut ceux sans `location`).
    const geoSalons = await this.salonModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: { location: { $exists: true } },
        },
      },
      { $limit: MAX_RESULTS },
    ]);

    // Salons sans coords (échec backfill) — jamais renvoyés par $geoNear, listés en bas.
    const noGeoSalons = await this.salonModel
      .find({ 'location.coordinates': { $exists: false } })
      .limit(MAX_UNGEOCODED)
      .lean();

    const mapSalon = (s: any, distanceMeters: number | null): NearbySalon => ({
      id: s._id.toString(),
      name: s.name,
      address: s.address ?? '',
      coverImage: null, // pas de champ image sur Salon aujourd'hui
      distanceKm: distanceMeters == null ? null : Math.round((distanceMeters / 1000) * 10) / 10,
      rating: null, // pas de collection reviews aujourd'hui (DH-3)
      isOpen: computeSalonIsOpen(s),
      lat: s.location?.coordinates?.[1] ?? null,
      lng: s.location?.coordinates?.[0] ?? null,
    });

    return [
      ...geoSalons.map((s) => mapSalon(s, s.distanceMeters)),
      ...noGeoSalons.map((s) => mapSalon(s, null)),
    ];
  }
}
