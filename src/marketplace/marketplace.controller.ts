import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  MarketplaceService,
  CategoryChip,
  ServiceHit,
  SalonOffering,
  PublicBarber,
} from './marketplace.service';
import { SearchServicesQueryDto, OfferingsQueryDto } from './dto/marketplace-query.dto';

/**
 * Discovery marketplace public — pas de guard (invité autorisé). Aucune écriture ici.
 */
@ApiTags('Marketplace')
@Controller()
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @ApiOperation({ summary: 'List marketplace service categories' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('services/categories')
  async categories(): Promise<{ data: CategoryChip[]; message: string }> {
    const data = await this.marketplace.getCategories();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Search marketplace services by name' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('services/search')
  async search(@Query() query: SearchServicesQueryDto): Promise<{ data: ServiceHit[]; message: string }> {
    const data = await this.marketplace.searchByName(query.q);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Find salon offerings matching a category/name, optionally near a location' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('services/offerings')
  async offerings(@Query() query: OfferingsQueryDto): Promise<{ data: SalonOffering[]; message: string }> {
    const data = await this.marketplace.findOfferings(
      {
        category: query.category,
        categories: [query.categories, query['categories[]']].flatMap((value) => (Array.isArray(value) ? value : value ? [value] : [])),
        name: query.name,
        names: [query.names, query['names[]']].flatMap((value) => (Array.isArray(value) ? value : value ? [value] : [])),
        serviceIds: [query.serviceIds, query['serviceIds[]']].flatMap((value) => (Array.isArray(value) ? value : value ? [value] : [])),
        match: query.match,
      },
      query.lat,
      query.lng,
    );
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List publicly visible barbers across salons' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('barbers/public')
  async barbers(): Promise<{ data: PublicBarber[]; message: string }> {
    const data = await this.marketplace.listPublicBarbers();
    return { data, message: 'OK' };
  }
}
