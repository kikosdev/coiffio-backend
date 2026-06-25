import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { PublicService } from './public.service';

@UseGuards(OptionalJwtGuard)
@Controller('public/salons')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get(':salonSlug/landing')
  getLanding(@Param('salonSlug') slug: string) {
    return this.publicService.getLanding(slug);
  }

  @Get(':salonSlug/services')
  getServices(
    @Param('salonSlug') slug: string,
    @Query('limit') limit?: string,
  ) {
    return this.publicService.getFeaturedServices(slug, limit ? parseInt(limit, 10) : 6);
  }

  @Get(':salonSlug/team')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  getTeam(@Param('salonSlug') slug: string) {
    return this.publicService.getPublicTeam(slug);
  }

  @Get(':salonSlug/testimonials')
  getTestimonials(
    @Param('salonSlug') slug: string,
    @Query('limit') limit?: string,
  ) {
    return this.publicService.getTestimonials(slug, limit ? parseInt(limit, 10) : 3);
  }
}
