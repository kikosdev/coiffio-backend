import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PosScopeGuard, PosUser } from '../common/guards/pos-scope.guard';
import { CurrentPosUser } from '../common/decorators/current-pos-user.decorator';
import { Staff, StaffDocument, WeeklyShift } from './schemas/staff.schema';
import { StaffProfile, StaffProfileDocument } from './schemas/staff-profile.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { BookingService } from '../booking/booking.service';
import { CreateWalkinDto } from '../booking/dto/booking.dto';
import { dateAtMin, addDaysIso, todayIso } from '../booking/availability.util';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDocument } from '../notifications/schemas/notification.schema';
import { FinanceService } from '../finance/finance.service';
import { PosPayDto } from './dto/team.dto';
import { FeatureGuard } from '../common/entitlements/guards/feature.guard';
import { RequiresFeature } from '../common/entitlements/decorators/requires-feature.decorator';

interface RosterCard {
  id: string;
  first: string;
  initial: string;
  color: string;
  role: string;
  pro: boolean;
  onShift: boolean;
  statusLabel: string;
}

interface TeamCard {
  id: string;
  first: string;
  initial: string;
  color: string;
  role: string;
  pro: boolean;
  week: WeeklyShift[];
}

// Africa/Tunis = UTC+1, no DST — no external dependency needed
const TUNIS_OFFSET_MS = 60 * 60 * 1000;

function isOnShiftToday(lastClockIn?: Date): boolean {
  if (!lastClockIn) return false;
  const nowTunis = new Date(Date.now() + TUNIS_OFFSET_MS);
  const ciTunis = new Date(lastClockIn.getTime() + TUNIS_OFFSET_MS);
  return (
    ciTunis.getUTCFullYear() === nowTunis.getUTCFullYear() &&
    ciTunis.getUTCMonth() === nowTunis.getUTCMonth() &&
    ciTunis.getUTCDate() === nowTunis.getUTCDate()
  );
}

interface CatalogItem {
  id: string;
  name: string;
  category: string;
  price: number;
  durationMin: number;
}

interface TodayAppt {
  id: string;
  client: string;
  service: string;
  stylistId: string;
  stylist: string;
  stylistInitials: string;
  stylistColor: string;
  isBooked: boolean;
  start: string;
  price: number;
  status: string;
  column: 'waiting' | 'in_chair' | 'done';
}

interface PosApptDetail {
  id: string;
  status: string;
  source: string;
  start: string;
  end: string;
  price: number;
  deposit: number | null;
  checkedInAt: string | null;
  column: 'waiting' | 'in_chair' | 'done';
  client: { name: string; phone: string; email: string };
  stylist: { name: string; color: string };
  services: { id: string; name: string; price: number; durationMin: number }[];
}

// Shared by getToday() and getAppointmentDetail() — a manual check-in pins the card
// to "in chair" regardless of the scheduled window; otherwise it's purely time-derived.
function computeColumn(
  status: string,
  start: Date,
  end: Date,
  checkedInAt: Date | undefined,
  now: Date,
): 'waiting' | 'in_chair' | 'done' {
  if (status === 'completed') return 'done';
  if (checkedInAt || (start <= now && end >= now)) return 'in_chair';
  return 'waiting';
}

@ApiTags('POS')
@ApiBearerAuth()
@Controller('pos')
@UseGuards(PosScopeGuard, FeatureGuard)
@RequiresFeature('pos')
export class PosController {
  constructor(
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    private readonly bookingService: BookingService,
    private readonly notificationsService: NotificationsService,
    private readonly financeService: FinanceService,
  ) { }

  @ApiOperation({ summary: 'Get the POS staff roster, on-shift status first' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('roster')
  async getRoster(): Promise<{ data: RosterCard[]; message: string }> {
    const staffList = await this.staffModel
      .find({ isActive: true, posEnabled: true })
      .select('name color role lastClockIn')
      .lean();

    if (!staffList.length) return { data: [], message: 'OK' };

    const staffIds = staffList.map((s) => s._id);
    const profiles = await this.profileModel
      .find({ userId: { $in: staffIds } })
      .select('userId level')
      .lean();

    const profileByStaffId = new Map(
      profiles.map((p) => [p.userId.toString(), p]),
    );

    const cards: RosterCard[] = staffList.map((staff) => {
      const profile = profileByStaffId.get(staff._id.toString());
      const firstName = staff.name.split(' ')[0];
      const shift = isOnShiftToday(staff.lastClockIn);

      return {
        id: staff._id.toString(),
        first: firstName,
        initial: firstName.charAt(0).toUpperCase(),
        color: staff.color ?? '#B89968',
        role: staff.role ?? 'staff',
        pro: profile ? ['master', 'senior'].includes(profile.level) : false,
        onShift: shift,
        statusLabel: shift ? 'On duty' : 'Off shift',
      };
    });

    // D-ROSTER-1: on-shift first, then alphabetical
    cards.sort((a, b) =>
      Number(b.onShift) - Number(a.onShift) || a.first.localeCompare(b.first),
    );

    return { data: cards, message: 'OK' };
  }

  // Team tab (RH view): mirrors the web /team list — isActive only, no PIN/posEnabled
  // gate. "On shift" is derived client-side from `week` (Africa/Tunis), not lastClockIn —
  // staff without a PIN never clock in but still have a schedule.
  @ApiOperation({ summary: 'Get the team roster (RH view, derived on-shift status from weekly schedule)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('team')
  async getTeam(): Promise<{ data: TeamCard[]; message: string }> {
    const staffList = await this.staffModel
      .find({ isActive: true })
      .select('name color role week')
      .lean();

    if (!staffList.length) return { data: [], message: 'OK' };

    const staffIds = staffList.map((s) => s._id);
    const profiles = await this.profileModel
      .find({ userId: { $in: staffIds } })    // ⚠️ vérifie le type de userId (cf. note)
      .select('userId level')
      .lean();

    const profileByStaffId = new Map(
      profiles.map((p) => [p.userId.toString(), p]),
    );

    const cards: TeamCard[] = staffList.map((staff) => {
      const profile = profileByStaffId.get(staff._id.toString());
      const firstName = staff.name.split(' ')[0];
      return {
        id: staff._id.toString(),
        first: firstName,
        initial: firstName.charAt(0).toUpperCase(),
        color: staff.color ?? '#B89968',
        role: staff.role ?? 'staff',
        pro: profile ? ['master', 'senior'].includes(profile.level) : false,
        week: staff.week ?? [],
      };
    });

    cards.sort((a, b) => a.first.localeCompare(b.first));
    return { data: cards, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get the active service catalog for the POS' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('catalog')
  async getCatalog(): Promise<{ data: CatalogItem[]; message: string }> {
    const services = await this.serviceModel
      .find({ active: true })
      .select('name category price durationMin')
      .sort({ category: 1, name: 1 })
      .lean();

    const data: CatalogItem[] = services.map((s) => ({
      id: (s._id as Types.ObjectId).toString(),
      name: s.name,
      category: s.category || 'other',
      price: s.price,
      durationMin: s.durationMin,
    }));

    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Get a day's appointments grouped by waiting/in-chair/done (defaults to today, Africa/Tunis)" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('today')
  async getToday(
    @Query('date') date?: string,
  ): Promise<{ data: TodayAppt[]; message: string }> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be yyyy-MM-dd.');
    }
    const now = new Date();
    const dateStr = date ?? todayIso();
    // Same UTC-labeled-as-Tunis convention the booking engine uses everywhere (dateAtMin) —
    // appointment start/end are stored that way, so day boundaries must match it exactly.
    const dayStart = dateAtMin(dateStr, 0);
    const dayEnd = dateAtMin(addDaysIso(dateStr, 1), 0);

    const appts = await this.apptModel
      .find({
        start: { $gte: dayStart, $lt: dayEnd },
        status: { $nin: ['cancelled'] },
      })
      .sort({ start: 1 })
      .lean();

    if (!appts.length) return { data: [], message: 'OK' };

    const clientIds = [...new Set(appts.map((a) => a.clientId.toString()))];
    const serviceIds = [...new Set(appts.flatMap((a) => a.services.map((s) => s.toString())))];
    const staffIds = [...new Set(appts.map((a) => a.stylistId.toString()))];

    const [clients, services, staff] = await Promise.all([
      this.clientModel.find({ _id: { $in: clientIds } }).select('name').lean(),
      this.serviceModel.find({ _id: { $in: serviceIds } }).select('name').lean(),
      this.staffModel.find({ _id: { $in: staffIds } }).select('name color').lean(),
    ]);

    const clientOf = new Map(clients.map((c) => [(c._id as Types.ObjectId).toString(), c.name]));
    const serviceOf = new Map(services.map((s) => [(s._id as Types.ObjectId).toString(), s.name]));
    const staffOf = new Map(staff.map((s) => [
      (s._id as Types.ObjectId).toString(),
      { name: s.name as string, color: (s.color as string) ?? '#B89968' },
    ]));

    const data: TodayAppt[] = appts
      .map((a) => {
        const member = staffOf.get(a.stylistId.toString());
        const parts = (member?.name ?? '—').split(' ');
        const initials = parts.map((p: string) => p.charAt(0).toUpperCase()).join('').slice(0, 2);

        const column = computeColumn(a.status, a.start, a.end, a.checkedInAt, now);

        return {
          id: a._id.toString(),
          client: a.source === 'walkin' ? 'Walk-in' : (clientOf.get(a.clientId.toString()) ?? '—'),
          service: a.services.length ? (serviceOf.get(a.services[0].toString()) ?? '—') : '—',
          stylistId: a.stylistId.toString(),
          stylist: parts[0],
          stylistInitials: initials,
          stylistColor: member?.color ?? '#B89968',
          isBooked: a.source !== 'walkin',
          start: a.start.toISOString(),
          price: a.price ?? 0,
          status: a.status,
          column,
        };
      })
      .filter((a) => a.column !== undefined) as TodayAppt[];

    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get full detail for a single appointment (POS)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('appointments/:id')
  async getAppointmentDetail(
    @Param('id') id: string,
  ): Promise<{ data: PosApptDetail; message: string }> {
    const appt = await this.apptModel.findOne({ _id: id }).lean();
    if (!appt) throw new NotFoundException('Appointment not found.');

    const [client, services, stylist] = await Promise.all([
      this.clientModel.findById(appt.clientId).select('name phone email').lean(),
      this.serviceModel.find({ _id: { $in: appt.services } }).select('name price durationMin').lean(),
      this.staffModel.findById(appt.stylistId).select('name color').lean(),
    ]);

    return {
      data: {
        id: appt._id.toString(),
        status: appt.status,
        source: appt.source,
        start: appt.start.toISOString(),
        end: appt.end.toISOString(),
        price: appt.price ?? 0,
        deposit: appt.deposit ?? null,
        checkedInAt: appt.checkedInAt ? appt.checkedInAt.toISOString() : null,
        column: computeColumn(appt.status, appt.start, appt.end, appt.checkedInAt, new Date()),
        client: {
          name: client?.name ?? (appt.source === 'walkin' ? 'Walk-in' : '—'),
          phone: client?.phone ?? '',
          email: client?.email ?? '',
        },
        stylist: { name: stylist?.name ?? '—', color: stylist?.color ?? '#B89968' },
        services: services.map((s) => ({
          id: (s._id as Types.ObjectId).toString(),
          name: s.name,
          price: s.price,
          durationMin: s.durationMin,
        })),
      },
      message: 'OK',
    };
  }

  @ApiOperation({ summary: 'Check a client in — pins the card to "in chair" regardless of scheduled time' })
  @ApiResponse({ status: 201, description: 'Checked in.' })
  @Post('appointments/:id/check-in')
  async checkIn(
    @Param('id') id: string,
  ): Promise<{ data: { ok: boolean; checkedInAt: string }; message: string }> {
    const appt = await this.apptModel.findOne({ _id: id });
    if (!appt) throw new NotFoundException('Appointment not found.');
    if (appt.status === 'completed' || appt.status === 'cancelled') {
      throw new BadRequestException('This appointment is already closed.');
    }
    if (!appt.checkedInAt) {
      appt.checkedInAt = new Date();
      await appt.save();
    }
    return { data: { ok: true, checkedInAt: appt.checkedInAt.toISOString() }, message: 'Checked in.' };
  }

  @ApiOperation({ summary: 'Record payment for an appointment and mark it completed (cash/card)' })
  @ApiResponse({ status: 201, description: 'Paid.' })
  @Post('appointments/:id/pay')
  async payAppointment(
    @Param('id') id: string,
    @Body() dto: PosPayDto,
  ): Promise<{ data: { ok: boolean }; message: string }> {
    const appt = await this.apptModel.findOne({ _id: id }).lean();
    if (!appt) throw new NotFoundException('Appointment not found.');
    if (appt.status === 'completed') throw new BadRequestException('This appointment is already paid.');
    if (appt.status === 'cancelled') throw new BadRequestException('This appointment was cancelled.');

    const services = await this.serviceModel
      .find({ _id: { $in: appt.services } })
      .select('name price')
      .lean();

    const items = services.map((s) => ({
      kind: 'service' as const,
      refId: (s._id as Types.ObjectId).toString(),
      name: s.name,
      qty: 1,
      unitPrice: s.price,
    }));
    if (items.length === 0) {
      items.push({ kind: 'service', refId: id, name: 'Service', qty: 1, unitPrice: appt.price ?? 0 });
    }

    await this.financeService.createPayment({
      appointmentId: id,
      stylistId: appt.stylistId.toString(),
      items,
      method: dto.method,
    });

    return { data: { ok: true }, message: 'Paid.' };
  }

  @ApiOperation({ summary: 'Clock in the current POS staff member' })
  @ApiResponse({ status: 201, description: 'Clocked in.' })
  @Post('clock-in')
  async clockIn(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: { ok: boolean; clockedIn: string }; message: string }> {
    const now = new Date();
    await this.staffModel.updateOne(
      { _id: caller.staffId },
      { $set: { lastClockIn: now } },
    );
    // SWAP: RegisterSession.open(caller.staffId, now) // TODO RegisterSession
    return { data: { ok: true, clockedIn: now.toISOString() }, message: 'Clocked in.' };
  }

  /**
   * "Add walk-in" (SKILL_fix_pos_board_notifications, Prompt 5) — walk-ins are appointments
   * (source:'walkin'), never a separate collection, so they show up on the same board query
   * as any other appointment. bb_pos_token has no `role`, so this can't reuse
   * POST /appointments/walkin (JwtGuard + RolesGuard) — same use case, POS-scoped guard.
   */
  @ApiOperation({ summary: 'Create a walk-in appointment, starting now' })
  @ApiResponse({ status: 201, description: 'Walk-in created.' })
  @Post('walkin')
  async createWalkin(
    @Body() dto: CreateWalkinDto,
  ): Promise<{ data: AppointmentDocument; message: string }> {
    const data = await this.bookingService.createWalkin(dto);
    return { data, message: 'Walk-in created.' };
  }

  /** Hydrates the POS bell on app restart — the persisted, deduplicated broadcast feed. */
  @ApiOperation({ summary: 'List the salon-wide notification feed (POS bell history)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('notifications')
  async listNotifications(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: NotificationDocument[]; message: string }> {
    const data = await this.notificationsService.listForSalon(caller.salonId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Mark notifications as read by this POS terminal/staff' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Patch('notifications/read')
  async markNotificationsRead(
    @CurrentPosUser() caller: PosUser,
    @Body() body: { ids?: string[] },
  ): Promise<{ data: { updated: number }; message: string }> {
    const data = await this.notificationsService.markReadByReader(caller.salonId, caller.staffId, body?.ids);
    return { data, message: 'OK' };
  }
}
