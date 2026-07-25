import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BookingService } from './booking.service';
import {
  AvailabilityQueryDto,
  AvailabilityTimelineQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  CreateWalkinDto,
  ListAppointmentsQueryDto,
  MineQueryDto,
} from './dto/booking.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Booking engine (Sprint 4). Availability recalculée live (#1) ; booking sous lock
 * transactionnel (#6) ; services chaînés = un bloc, un groupId (#3). Routes publiques
 * (storefront) sous OptionalJwt ; routes backoffice sous JWT + RolesGuard. Enveloppe + scope.
 */
@ApiTags('Booking')
@Controller()
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  // ─── Public (storefront) ────────────────────────────────────────────────

  /** Catalogue services public (parcours Book a Visit, étape BookServices). */
  @ApiOperation({ summary: 'Get the public services catalogue for the salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('book/services')
  @UseGuards(OptionalJwtGuard)
  async catalog(@Req() req: Request, @Query('gender') gender?: string) {
    const data = await this.booking.catalog(getSalonScope(req), gender);
    return { data, message: 'OK' };
  }

  /** Availability : public (OptionalJwt) — lue par le parcours Book a Visit et le backoffice. */
  @ApiOperation({ summary: 'Get live appointment availability for a given day' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('availability')
  @UseGuards(OptionalJwtGuard)
  async availability(@Req() req: Request, @Query() query: AvailabilityQueryDto) {
    const data = await this.booking.availability(getSalonScope(req), query);
    return { data, message: 'OK' };
  }

  /** Timeline multi-jours : mêmes garanties que /availability, vue 7 jours (par défaut) pour le Step II du parcours. */
  @ApiOperation({ summary: 'Get a multi-day availability timeline (7 days by default)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('availability/timeline')
  @UseGuards(OptionalJwtGuard)
  async availabilityTimeline(@Req() req: Request, @Query() query: AvailabilityTimelineQueryDto) {
    const data = await this.booking.availabilityTimeline(getSalonScope(req), query);
    return { data, message: 'OK' };
  }

  /** Création RDV : public en 'online' (#10 merge-on-phone) ou staff en 'phone'. Transaction + 409. */
  @ApiOperation({ summary: "Book a new appointment (public 'online' or staff 'phone')" })
  @ApiResponse({ status: 201, description: 'Appointment booked.' })
  @Post('appointments')
  @UseGuards(OptionalJwtGuard)
  async create(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Body() dto: CreateAppointmentDto) {
    const data = await this.booking.createAppointment(getSalonScope(req), dto, user);
    return { data, message: 'Appointment booked.' };
  }

  /** Annulation : staff (JWT) ou client via lien signé `?token=` (#12). */
  @ApiOperation({ summary: 'Cancel an appointment (staff or client via signed link token)' })
  @ApiResponse({ status: 200, description: 'Appointment cancelled.' })
  @Patch('appointments/:id/cancel')
  @UseGuards(OptionalJwtGuard)
  async cancel(
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    const data = await this.booking.cancel(getSalonScope(req), id, { user, dto });
    return { data, message: 'Appointment cancelled.' };
  }

  /** Client self-service: caller's own appointments, cross-salon (populated). */
  @ApiOperation({ summary: "Get the current client's own appointments across salons" })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments/mine')
  @UseGuards(JwtGuard)
  async mine(@CurrentUser() user: AuthUser, @Query() query: MineQueryDto) {
    const data = await this.booking.listMine(user, query.scope ?? 'upcoming');
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get aggregate client home data for the current client' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('client/home')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('client')
  async clientHome(@CurrentUser() user: AuthUser) {
    const data = await this.booking.clientHome(user);
    return { data, message: 'OK' };
  }

  // ─── Backoffice (staff) ──────────────────────────────────────────────────

  @ApiOperation({ summary: "Get the current staff member's hydrated appointments for today" })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('staff/today')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async staffToday(@Req() req: Request, @CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const data = await this.booking.staffToday(getSalonScope(req), user, date);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get the current staff member's hydrated schedule week" })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('staff/schedule/week')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async staffScheduleWeek(@Req() req: Request, @CurrentUser() user: AuthUser, @Query('startDate') startDate?: string) {
    const data = await this.booking.staffScheduleWeek(getSalonScope(req), user, startDate);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a walk-in appointment (staff)' })
  @ApiResponse({ status: 201, description: 'Walk-in created.' })
  @ApiBearerAuth()
  @Post('appointments/walkin')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async walkin(@Req() req: Request, @Body() dto: CreateWalkinDto) {
    const data = await this.booking.createWalkin(getSalonScope(req), dto);
    return { data, message: 'Walk-in created.' };
  }

  @ApiOperation({ summary: 'List appointments for the salon, optionally filtered by date/stylist' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async list(@Req() req: Request, @Query() query: ListAppointmentsQueryDto) {
    const data = await this.booking.list(getSalonScope(req), query.date, query.stylistId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List the appointments belonging to a chained booking group' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments/group/:groupId')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async group(@Req() req: Request, @Param('groupId') groupId: string) {
    const data = await this.booking.listGroup(getSalonScope(req), groupId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get a single appointment by id' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async one(@Req() req: Request, @Param('id') id: string) {
    const data = await this.booking.getOne(getSalonScope(req), id);
    return { data, message: 'OK' };
  }
}
