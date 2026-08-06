import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { AddOverrideDto, SetWeeklyDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Schedule (Sprint 3) — la source de vérité de disponibilité (lue par le booking engine).
 * GET = owner·manager·(stylist=soi) ; éditer la rota / poser un override = owner·manager (matrice).
 */
@ApiTags('Schedule')
@ApiBearerAuth()
@Controller('schedule')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  /** Un stylist ne peut consulter que SA propre rota ; owner/manager voient toutes. */
  private assertCanRead(user: AuthUser, stylistId: string): void {
    if (user.role === 'stylist' && (user.staffId ?? user.sub) !== stylistId) {
      throw new ForbiddenException('You can only view your own schedule.');
    }
  }

  /** Horaires d'ouverture du salon — utilisé par le frontend pour désactiver les jours fermés. */
  @ApiOperation({ summary: "Get the salon's opening hours" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('salon-hours')
  async getSalonHours() {
    const data = await this.schedule.getSalonHours();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get a stylist's schedule (own schedule only for stylists)" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':stylistId')
  async get(@CurrentUser() user: AuthUser, @Param('stylistId') stylistId: string) {
    this.assertCanRead(user, stylistId);
    const data = await this.schedule.getSchedule(stylistId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Set a stylist's weekly rota (owner/manager only)" })
  @ApiResponse({ status: 200, description: 'Weekly rota saved.' })
  @Put(':stylistId')
  @Roles('owner', 'manager')
  async setWeekly(@Param('stylistId') stylistId: string, @Body() dto: SetWeeklyDto) {
    const data = await this.schedule.setWeekly(stylistId, dto);
    return { data, message: 'Weekly rota saved.' };
  }

  @ApiOperation({ summary: "Add a schedule override for a stylist (owner/manager only)" })
  @ApiResponse({ status: 201, description: 'Override added.' })
  @Post(':stylistId/override')
  @Roles('owner', 'manager')
  async addOverride(@Param('stylistId') stylistId: string, @Body() dto: AddOverrideDto) {
    const data = await this.schedule.addOverride(stylistId, dto);
    return { data, message: 'Override added.' };
  }

  @ApiOperation({ summary: "Remove a schedule override for a stylist (owner/manager only)" })
  @ApiResponse({ status: 200, description: 'Override removed.' })
  @Delete(':stylistId/override/:date')
  @Roles('owner', 'manager')
  @Destructive()
  async removeOverride(
    @Param('stylistId') stylistId: string,
    @Param('date') date: string,
  ) {
    const data = await this.schedule.removeOverride(stylistId, date);
    return { data, message: 'Override removed.' };
  }
}
