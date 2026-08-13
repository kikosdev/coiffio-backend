import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { GuestScopeService } from '../common/tenant/guest-scope.service';
import { PublicService } from './public.service';

@ApiTags('Public')
@UseGuards(OptionalJwtGuard)
@Controller('public/salons')
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly guestScope: GuestScopeService,
  ) {}

  @ApiOperation({ summary: 'List all salons — discovery, no geolocation required' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  listAll() {
    return this.publicService.listAll();
  }

  @ApiOperation({ summary: 'Get a single salon profile card by its Mongo _id' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.publicService.getOne(id);
  }

  @ApiOperation({ summary: 'Get public landing page data for a salon by slug' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/landing')
  getLanding(@Param('salonSlug') slug: string) {
    return this.publicService.getLanding(slug);
  }

  @ApiOperation({ summary: 'List featured services for a salon by slug' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/services')
  getServices(
    @Param('salonSlug') slug: string,
    @Query('limit') limit?: string,
  ) {
    return this.publicService.getFeaturedServices(slug, limit ? parseInt(limit, 10) : 6);
  }

  /**
   * `guestScope.run()` — même pattern que BookingController (Prompt 6, Partie C). Sans lui,
   * `getPublicTeam()` lit `staffs`/`staffprofiles` (TENANT_SCOPED) sans TenantContext et le
   * plugin de scope throw : 500 "No tenant context available" sur chaque appel, ce qui vidait
   * la section "OUR BARBERS" de l'écran salon mobile. Mono-tenant (le slug identifie déjà le
   * salon) donc `runAsGuest` via GuestScopeService, pas `runAsDiscovery` (cross-tenant).
   */
  @ApiOperation({ summary: 'List the public team members for a salon by slug' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/team')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  getTeam(@Param('salonSlug') slug: string) {
    return this.guestScope.run(slug, undefined, () => this.publicService.getPublicTeam(slug));
  }

  @ApiOperation({ summary: 'List testimonials for a salon by slug' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/testimonials')
  getTestimonials(
    @Param('salonSlug') slug: string,
    @Query('limit') limit?: string,
  ) {
    return this.publicService.getTestimonials(slug, limit ? parseInt(limit, 10) : 3);
  }
}
