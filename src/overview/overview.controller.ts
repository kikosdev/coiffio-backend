import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OverviewService } from './overview.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { todayIsoInTz } from '../common/time/tz-day.util';

/** Overview "Arc of the day" (Sprint 9). Agrégat lecture-seule, owner·manager. */
@ApiTags('Overview')
@ApiBearerAuth()
@Controller('overview')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @ApiOperation({ summary: "Get the day's aggregated overview (arc of the day) for a given date" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async forDate(@Query('date') date?: string) {
    const d = date ?? todayIsoInTz();
    const data = await this.overview.forDate(d);
    return { data, message: 'OK' };
  }
}
