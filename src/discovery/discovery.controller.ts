import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { DiscoveryService, DiscoveryLocationHit, SalonProfile } from './discovery.service';
import { ByRegionQueryDto, NearbyQueryDto, SalonAvailabilityQueryDto } from './dto/discovery.dto';
import { StylistAvailability } from '../booking/booking.service';

/**
 * Public, sans JWT — exclu de TenantContextMiddleware (voir app.module.ts). Rate limit
 * 60/min/IP par route (spec Prompt 5), au-delà du throttle global de l'app.
 */
@ApiTags('Discovery')
@Controller('discovery')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @ApiOperation({ summary: 'Salons/locations near a given point (2dsphere geoNear)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('nearby')
  async nearby(@Query() q: NearbyQueryDto): Promise<{ data: DiscoveryLocationHit[]; message: string }> {
    const data = await this.discovery.nearby(q.lat, q.lng, q.radiusKm ?? 10, q.limit ?? 20);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Salons/locations by region — fallback when GPS is refused' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('by-region')
  async byRegion(@Query() q: ByRegionQueryDto): Promise<{ data: DiscoveryLocationHit[]; message: string }> {
    const data = await this.discovery.byRegion(q.region, q.limit ?? 20);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List regions with at least one active salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('regions')
  async regions(): Promise<{ data: string[]; message: string }> {
    const data = await this.discovery.regions();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Public storefront card for a salon (services, hours, testimonials, team)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('salon/:slug')
  async salon(@Param('slug') slug: string): Promise<{ data: SalonProfile; message: string }> {
    const data = await this.discovery.salonProfile(slug);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Live public availability for a salon (computed, never stored)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('salon/:slug/availability')
  async availability(
    @Param('slug') slug: string,
    @Query() q: SalonAvailabilityQueryDto,
  ): Promise<{ data: StylistAvailability[]; message: string }> {
    const data = await this.discovery.availability(slug, q);
    return { data, message: 'OK' };
  }
}
