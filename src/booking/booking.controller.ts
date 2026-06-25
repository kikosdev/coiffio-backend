import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { BookingService } from './booking.service';
import {
  AvailabilityQueryDto,
  AvailabilityTimelineQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  CreateWalkinDto,
  ListAppointmentsQueryDto,
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
@Controller()
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  // ─── Public (storefront) ────────────────────────────────────────────────

  /** Catalogue services public (parcours Book a Visit, étape BookServices). */
  @Get('book/services')
  @UseGuards(OptionalJwtGuard)
  async catalog(@Req() req: Request, @Query('gender') gender?: string) {
    const data = await this.booking.catalog(getSalonScope(req), gender);
    return { data, message: 'OK' };
  }

  /** Availability : public (OptionalJwt) — lue par le parcours Book a Visit et le backoffice. */
  @Get('availability')
  @UseGuards(OptionalJwtGuard)
  async availability(@Req() req: Request, @Query() query: AvailabilityQueryDto) {
    const data = await this.booking.availability(getSalonScope(req), query);
    return { data, message: 'OK' };
  }

  /** Timeline multi-jours : mêmes garanties que /availability, vue 7 jours (par défaut) pour le Step II du parcours. */
  @Get('availability/timeline')
  @UseGuards(OptionalJwtGuard)
  async availabilityTimeline(@Req() req: Request, @Query() query: AvailabilityTimelineQueryDto) {
    const data = await this.booking.availabilityTimeline(getSalonScope(req), query);
    return { data, message: 'OK' };
  }

  /** Création RDV : public en 'online' (#10 merge-on-phone) ou staff en 'phone'. Transaction + 409. */
  @Post('appointments')
  @UseGuards(OptionalJwtGuard)
  async create(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Body() dto: CreateAppointmentDto) {
    const data = await this.booking.createAppointment(getSalonScope(req), dto, user);
    return { data, message: 'Appointment booked.' };
  }

  /** Annulation : staff (JWT) ou client via lien signé `?token=` (#12). */
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

  /** Client self-service: returns the caller's own appointments (populated). */
  @Get('appointments/mine')
  @UseGuards(JwtGuard)
  async mine(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.booking.listMine(getSalonScope(req), user);
    return { data, message: 'OK' };
  }

  // ─── Backoffice (staff) ──────────────────────────────────────────────────

  @Post('appointments/walkin')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async walkin(@Req() req: Request, @Body() dto: CreateWalkinDto) {
    const data = await this.booking.createWalkin(getSalonScope(req), dto);
    return { data, message: 'Walk-in created.' };
  }

  @Get('appointments')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async list(@Req() req: Request, @Query() query: ListAppointmentsQueryDto) {
    const data = await this.booking.list(getSalonScope(req), query.date, query.stylistId);
    return { data, message: 'OK' };
  }

  @Get('appointments/group/:groupId')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async group(@Req() req: Request, @Param('groupId') groupId: string) {
    const data = await this.booking.listGroup(getSalonScope(req), groupId);
    return { data, message: 'OK' };
  }

  @Get('appointments/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async one(@Req() req: Request, @Param('id') id: string) {
    const data = await this.booking.getOne(getSalonScope(req), id);
    return { data, message: 'OK' };
  }
}
