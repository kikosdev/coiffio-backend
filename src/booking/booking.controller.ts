import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { GuestScopeService } from '../common/tenant/guest-scope.service';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Booking engine (Sprint 4). Availability recalculée live (#1) ; booking sous lock
 * transactionnel (#6) ; services chaînés = un bloc, un groupId (#3). Routes publiques
 * (storefront) sous OptionalJwt ; routes backoffice sous JWT + RolesGuard. Enveloppe + scope.
 *
 * ⚠️ Prompt 6, Partie C (bug trouvé en testant) : les routes publiques (catalog/
 * availability/availabilityTimeline/create/cancel) résolvent maintenant le tenant par
 * `:salonSlug` + posent un TenantContext via `GuestScopeService`/`runAsGuest` — sans ça, le
 * plugin de scope (Prompt 3) exige `getTenantContext()` sur `staffs`/`services`/
 * `appointments`, et un visiteur anonyme (jamais de JWT, jamais de contexte posé par le
 * middleware) recevait un 500 systématique. Slug/location introuvables → 404 propre, jamais
 * de fallback silencieux (DEFAULT_SALON_ID abandonné sur ces routes précises). Les routes
 * JwtGuard-only (backoffice) restent sur `currentScope()`, inchangées.
 */
@ApiTags('Booking')
@Controller()
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly guestScope: GuestScopeService,
  ) {}

  // ─── Public (storefront) ────────────────────────────────────────────────

  /** Catalogue services public (parcours Book a Visit, étape BookServices). */
  @ApiOperation({ summary: 'Get the public services catalogue for the salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/book/services')
  @UseGuards(OptionalJwtGuard)
  async catalog(@Param('salonSlug') salonSlug: string, @Query('gender') gender?: string) {
    const data = await this.guestScope.run(salonSlug, undefined, () => this.booking.catalog(gender));
    return { data, message: 'OK' };
  }

  /** Availability : public (storefront, sans JWT) — lue par le parcours Book a Visit et le backoffice. */
  @ApiOperation({ summary: 'Get live appointment availability for a given day' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/availability')
  @UseGuards(OptionalJwtGuard)
  async availability(@Param('salonSlug') salonSlug: string, @Query() query: AvailabilityQueryDto) {
    const data = await this.guestScope.run(salonSlug, query.locationId, () => this.booking.availability(query));
    return { data, message: 'OK' };
  }

  /** Timeline multi-jours : mêmes garanties que /availability, vue 7 jours (par défaut) pour le Step II du parcours. */
  @ApiOperation({ summary: 'Get a multi-day availability timeline (7 days by default)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/availability/timeline')
  @UseGuards(OptionalJwtGuard)
  async availabilityTimeline(@Param('salonSlug') salonSlug: string, @Query() query: AvailabilityTimelineQueryDto) {
    const data = await this.guestScope.run(salonSlug, query.locationId, () =>
      this.booking.availabilityTimeline(query),
    );
    return { data, message: 'OK' };
  }

  /** Création RDV : public en 'online' (#10 merge-on-phone) ou staff en 'phone'. Transaction + 409. */
  @ApiOperation({ summary: "Book a new appointment (public 'online' or staff 'phone')" })
  @ApiResponse({ status: 201, description: 'Appointment booked.' })
  @Post(':salonSlug/appointments')
  @UseGuards(OptionalJwtGuard)
  async create(
    @Param('salonSlug') salonSlug: string,
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: CreateAppointmentDto,
  ) {
    const data = await this.guestScope.run(salonSlug, undefined, () =>
      this.booking.createAppointment(dto, user),
    );
    return { data, message: 'Appointment booked.' };
  }

  /** Annulation : staff (JWT) ou client via lien signé `?token=` (#12). */
  @ApiOperation({ summary: 'Cancel an appointment (staff or client via signed link token)' })
  @ApiResponse({ status: 200, description: 'Appointment cancelled.' })
  @Patch(':salonSlug/appointments/:id/cancel')
  @UseGuards(OptionalJwtGuard)
  @Destructive()
  async cancel(
    @Param('salonSlug') salonSlug: string,
    @CurrentUser() user: AuthUser | undefined,
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    const data = await this.guestScope.run(salonSlug, undefined, () =>
      this.booking.cancel(id, { user, dto }),
    );
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
  async staffToday(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const data = await this.booking.staffToday(user, date);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get the current staff member's hydrated schedule week" })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('staff/schedule/week')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async staffScheduleWeek(@CurrentUser() user: AuthUser, @Query('startDate') startDate?: string) {
    const data = await this.booking.staffScheduleWeek(user, startDate);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a walk-in appointment (staff)' })
  @ApiResponse({ status: 201, description: 'Walk-in created.' })
  @ApiBearerAuth()
  @Post('appointments/walkin')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async walkin(@Body() dto: CreateWalkinDto) {
    const data = await this.booking.createWalkin(dto);
    return { data, message: 'Walk-in created.' };
  }

  @ApiOperation({ summary: 'List appointments for the salon, optionally filtered by date/stylist' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async list(@Query() query: ListAppointmentsQueryDto) {
    const data = await this.booking.list(query.date, query.stylistId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List the appointments belonging to a chained booking group' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments/group/:groupId')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async group(@Param('groupId') groupId: string) {
    const data = await this.booking.listGroup(groupId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get a single appointment by id' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('appointments/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async one(@Param('id') id: string) {
    const data = await this.booking.getOne(id);
    return { data, message: 'OK' };
  }
}
