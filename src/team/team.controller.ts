import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { TeamService } from './team.service';
import { AuthService } from '../auth/auth.service';
import { CreateStaffAuthDto } from '../auth/dto/auth.dto';
import { SetAcceptingBookingsDto, UpdateStaffDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Team roster management. Staff account creation delegates to AuthService
 * (identity split — credentials live in `users`, business profile in `staffs`).
 */
@ApiTags('Team')
@ApiBearerAuth()
@Controller('team')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist')
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly auth: AuthService,
  ) {}

  @ApiOperation({ summary: 'List staff members for the salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(@Req() req: Request, @CurrentUser('role') role: string) {
    const data = await this.team.listStaff(getSalonScope(req), role);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get the current staff member's standing" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('me/standing')
  async standing(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.team.myStanding(getSalonScope(req), user);
    return { data, message: 'OK' };
  }

  // Must come before ':id' below — Express matches static segments in registration order.
  @ApiOperation({ summary: "Toggle whether the current stylist is accepting new public bookings" })
  @ApiResponse({ status: 200, description: 'Accepting-bookings state updated.' })
  @Patch('me/accepting-bookings')
  async setAcceptingBookings(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() dto: SetAcceptingBookingsDto) {
    const data = await this.team.setAcceptingBookings(getSalonScope(req), user, dto.acceptingBookings);
    return { data, message: 'Accepting-bookings state updated.' };
  }

  @ApiOperation({ summary: "Get a staff member's this-week stats (revenue, cuts, chair utilisation) — owner/manager only" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':id/stats')
  @Roles('owner', 'manager')
  async stats(@Req() req: Request, @Param('id') id: string) {
    const data = await this.team.staffStats(getSalonScope(req), id);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new staff account (owner only)' })
  @ApiResponse({ status: 201, description: 'Staff account created.' })
  @Post()
  @Roles('owner')
  async create(@Req() req: Request, @Body() dto: CreateStaffAuthDto) {
    const { salonId } = getSalonScope(req);
    const data = await this.auth.createStaff(salonId, dto);
    return { data, message: 'Staff account created.' };
  }

  @ApiOperation({ summary: 'Update a staff account (owner/manager only)' })
  @ApiResponse({ status: 200, description: 'Staff account updated.' })
  @Patch(':id')
  @Roles('owner', 'manager')
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateStaffDto) {
    const data = await this.team.updateStaff(getSalonScope(req), id, dto);
    return { data, message: 'Staff account updated.' };
  }

  @ApiOperation({ summary: 'Deactivate a staff account (owner only)' })
  @ApiResponse({ status: 200, description: 'Staff account deactivated.' })
  @Delete(':id')
  @Roles('owner')
  async deactivate(@Req() req: Request, @Param('id') id: string) {
    const data = await this.team.deactivateStaff(getSalonScope(req), id);
    return { data, message: 'Staff account deactivated.' };
  }
}
