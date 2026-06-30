import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OverviewService } from './overview.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';

/** Overview "Arc of the day" (Sprint 9). Agrégat lecture-seule, owner·manager. */
@Controller('overview')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  async forDate(@Req() req: Request, @Query('date') date?: string) {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const data = await this.overview.forDate(getSalonScope(req), d);
    return { data, message: 'OK' };
  }
}
