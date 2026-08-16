import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  LossControlAnalyticsService,
  StaffHonestyRow,
  VarianceResult,
  ExtremeUsageRow,
  InvestigationResult,
} from './loss-control-analytics.service';
import { StaffHonestyQueryDto, VarianceQueryDto, ExtremeUsageQueryDto } from './dto/loss-control-analytics.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/** LC-6 (SKILL_loss_control_doses.md, Prompt 4) — owner-only, lecture seule. */
@ApiTags('Loss Control')
@ApiBearerAuth()
@Controller('loss-control')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner')
export class LossControlAnalyticsController {
  constructor(private readonly analytics: LossControlAnalyticsService) {}

  /** Calc 1 — signal SECONDAIRE (repose sur la déclaration du staff). */
  @ApiOperation({ summary: 'Staff honesty variance: declared vs expected doses (secondary signal)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('staff-honesty')
  async staffHonesty(@Query() query: StaffHonestyQueryDto): Promise<{ data: { byStaff: StaffHonestyRow[] }; message: string }> {
    const data = await this.analytics.staffHonesty(query.period, query.stylistId);
    return { data, message: 'OK' };
  }

  /** Calc 2 — LE détecteur non contournable (stock réel constaté vs théorique). */
  @ApiOperation({ summary: 'Stock variance: theoretical (since last physical count) vs real (THE non-bypassable signal)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('variance')
  async variance(@Query() query: VarianceQueryDto): Promise<{ data: VarianceResult; message: string }> {
    const data = await this.analytics.variance(query.productId, query.period);
    return { data, message: 'OK' };
  }

  /** Calc 3 — signal SECONDAIRE (repose sur la déclaration du staff). */
  @ApiOperation({ summary: 'Extreme usage candidates: declared doses far above expected (secondary signal)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('extreme-usage')
  async extremeUsage(@Query() query: ExtremeUsageQueryDto): Promise<{ data: ExtremeUsageRow[]; message: string }> {
    const data = await this.analytics.extremeUsage(query.period);
    return { data, message: 'OK' };
  }

  /**
   * LC-9 (Prompt 7) — détail d'investigation d'un RDV, ouvert depuis une alerte
   * `extreme_usage` (porte déjà `appointmentId`) ou depuis la Caisse (`CaisseEntry
   * .appointmentId`, posé ce même prompt).
   */
  @ApiOperation({ summary: 'Appointment investigation detail: client/services/stylist, declared doses vs theoretical, linked payment' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('appointments/:id/investigation')
  async investigateAppointment(@Param('id') id: string): Promise<{ data: InvestigationResult; message: string }> {
    const data = await this.analytics.investigateAppointment(id);
    return { data, message: 'OK' };
  }
}
