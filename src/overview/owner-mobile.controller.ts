import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { OverviewService } from './overview.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';

@ApiTags('Owner Mobile')
@ApiBearerAuth()
@Controller('owner')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager')
export class OwnerMobileController {
  constructor(private readonly overview: OverviewService) {}

  @ApiOperation({ summary: 'Get optimized owner HQ aggregate for mobile' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('hq')
  async hq(@Req() req: Request, @Query('date') date?: string) {
    const data = await this.overview.ownerHq(getSalonScope(req), date);
    return { data, message: 'OK' };
  }
}
