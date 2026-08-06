import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { AuthService } from '../auth/auth.service';
import { CreateStaffAuthDto } from '../auth/dto/auth.dto';
import { SetAcceptingBookingsDto, UpdateStaffDto, UpdateStaffLocationsDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { currentScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { LimitGuard } from '../common/entitlements/guards/limit.guard';
import { EnforcesLimit } from '../common/entitlements/decorators/enforces-limit.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

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
  async list(@CurrentUser('role') role: string) {
    const data = await this.team.listStaff(role);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get the current staff member's standing" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('me/standing')
  async standing(@CurrentUser() user: AuthUser) {
    const data = await this.team.myStanding(user);
    return { data, message: 'OK' };
  }

  // Must come before ':id' below — Express matches static segments in registration order.
  @ApiOperation({ summary: "Toggle whether the current stylist is accepting new public bookings" })
  @ApiResponse({ status: 200, description: 'Accepting-bookings state updated.' })
  @Patch('me/accepting-bookings')
  async setAcceptingBookings(@CurrentUser() user: AuthUser, @Body() dto: SetAcceptingBookingsDto) {
    const data = await this.team.setAcceptingBookings(user, dto.acceptingBookings);
    return { data, message: 'Accepting-bookings state updated.' };
  }

  @ApiOperation({ summary: "Get a staff member's this-week stats (revenue, cuts, chair utilisation) — owner/manager only" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':id/stats')
  @Roles('owner', 'manager')
  async stats(@Param('id') id: string) {
    const data = await this.team.staffStats(id);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get a staff member's membership (tenant access) — owner/manager only" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':id/membership')
  @Roles('owner', 'manager')
  async membership(@Param('id') id: string) {
    const { salonId } = currentScope();
    const data = await this.team.getMembership(salonId, id);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Update a staff member's accessible locations — owner/manager only" })
  @ApiResponse({ status: 200, description: 'Locations updated.' })
  @Patch(':id/locations')
  @Roles('owner', 'manager')
  async updateLocations(@Param('id') id: string, @Body() dto: UpdateStaffLocationsDto) {
    const { salonId } = currentScope();
    const data = await this.team.updateStaffLocations(salonId, id, dto.locationIds);
    return { data, message: 'Locations updated.' };
  }

  @ApiOperation({ summary: "Revoke a staff member's tenant access (owner only)" })
  @ApiResponse({ status: 200, description: 'Access revoked.' })
  @Delete(':id/access')
  @Roles('owner')
  @Destructive()
  async revokeAccess(@Param('id') id: string) {
    const { salonId } = currentScope();
    const data = await this.team.revokeAccess(salonId, id);
    return { data, message: 'Access revoked.' };
  }

  @ApiOperation({ summary: 'Create a new staff account (owner only)' })
  @ApiResponse({ status: 201, description: 'Staff account created.' })
  @Post()
  @Roles('owner')
  @UseGuards(LimitGuard)
  @EnforcesLimit('staffMax')
  async create(@Body() dto: CreateStaffAuthDto) {
    const { salonId } = currentScope();
    const data = await this.auth.createStaff(salonId, dto);
    return { data, message: 'Staff account created.' };
  }

  @ApiOperation({ summary: 'Update a staff account (owner/manager only)' })
  @ApiResponse({ status: 200, description: 'Staff account updated.' })
  @Patch(':id')
  @Roles('owner', 'manager')
  async update(@Param('id') id: string, @Body() dto: UpdateStaffDto) {
    const data = await this.team.updateStaff(id, dto);
    return { data, message: 'Staff account updated.' };
  }

  @ApiOperation({ summary: 'Deactivate a staff account (owner only)' })
  @ApiResponse({ status: 200, description: 'Staff account deactivated.' })
  @Delete(':id')
  @Roles('owner')
  @Destructive()
  async deactivate(@Param('id') id: string) {
    const data = await this.team.deactivateStaff(id);
    return { data, message: 'Staff account deactivated.' };
  }
}
