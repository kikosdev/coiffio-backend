import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { PublicService } from './public.service';

@ApiTags('Public')
@UseGuards(OptionalJwtGuard)
@Controller('public/salons')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

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

  @ApiOperation({ summary: 'List the public team members for a salon by slug' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/team')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  getTeam(@Param('salonSlug') slug: string) {
    return this.publicService.getPublicTeam(slug);
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
