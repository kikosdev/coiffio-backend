import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PosScopeGuard, PosUser } from '../common/guards/pos-scope.guard';
import { CurrentPosUser } from '../common/decorators/current-pos-user.decorator';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { StaffProfile, StaffProfileDocument } from './schemas/staff-profile.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';

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

// Africa/Tunis = UTC+1, no DST — no external dependency needed
const TUNIS_OFFSET_MS = 60 * 60 * 1000;

function isOnShiftToday(lastClockIn?: Date): boolean {
  if (!lastClockIn) return false;
  const nowTunis = new Date(Date.now() + TUNIS_OFFSET_MS);
  const ciTunis  = new Date(lastClockIn.getTime() + TUNIS_OFFSET_MS);
  return (
    ciTunis.getUTCFullYear() === nowTunis.getUTCFullYear() &&
    ciTunis.getUTCMonth()    === nowTunis.getUTCMonth()    &&
    ciTunis.getUTCDate()     === nowTunis.getUTCDate()
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

@Controller('pos')
@UseGuards(PosScopeGuard)
export class PosController {
  constructor(
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
  ) {}

  @Get('roster')
  async getRoster(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: RosterCard[]; message: string }> {
    const salonId = new Types.ObjectId(caller.salonId);

    const staffList = await this.staffModel
      .find({ salonId, isActive: true, posEnabled: true })
      .select('name color role lastClockIn')
      .lean();

    if (!staffList.length) return { data: [], message: 'OK' };

    const staffIds = staffList.map((s) => s._id);
    const profiles = await this.profileModel
      .find({ salonId, userId: { $in: staffIds } })
      .select('userId level')
      .lean();

    const profileByStaffId = new Map(
      profiles.map((p) => [p.userId.toString(), p]),
    );

    const cards: RosterCard[] = staffList.map((staff) => {
      const profile   = profileByStaffId.get(staff._id.toString());
      const firstName = staff.name.split(' ')[0];
      const shift     = isOnShiftToday(staff.lastClockIn);

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

  @Get('team')
  async getTeam(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: RosterCard[]; message: string }> {
    const salonId = new Types.ObjectId(caller.salonId);

    const staffList = await this.staffModel
      .find({ salonId, isActive: true })
      .select('name color role lastClockIn')
      .lean();

    if (!staffList.length) return { data: [], message: 'OK' };

    const staffIds = staffList.map((s) => s._id);
    const profiles = await this.profileModel
      .find({ salonId, userId: { $in: staffIds } })
      .select('userId level')
      .lean();

    const profileByStaffId = new Map(
      profiles.map((p) => [p.userId.toString(), p]),
    );

    const cards: RosterCard[] = staffList.map((staff) => {
      const profile   = profileByStaffId.get(staff._id.toString());
      const firstName = staff.name.split(' ')[0];
      const shift     = isOnShiftToday(staff.lastClockIn);

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

    cards.sort((a, b) =>
      Number(b.onShift) - Number(a.onShift) || a.first.localeCompare(b.first),
    );

    return { data: cards, message: 'OK' };
  }

  @Get('catalog')
  async getCatalog(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: CatalogItem[]; message: string }> {
    const salonId = new Types.ObjectId(caller.salonId);

    const services = await this.serviceModel
      .find({ salonId, active: true })
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

  @Get('today')
  async getToday(
    @CurrentPosUser() caller: PosUser,
  ): Promise<{ data: TodayAppt[]; message: string }> {
    const salonId = new Types.ObjectId(caller.salonId);
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const dayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const appts = await this.apptModel
      .find({
        salonId,
        start: { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['cancelled'] },
      })
      .sort({ start: 1 })
      .lean();

    if (!appts.length) return { data: [], message: 'OK' };

    const clientIds  = [...new Set(appts.map((a) => a.clientId.toString()))];
    const serviceIds = [...new Set(appts.flatMap((a) => a.services.map((s) => s.toString())))];
    const staffIds   = [...new Set(appts.map((a) => a.stylistId.toString()))];

    const [clients, services, staff] = await Promise.all([
      this.clientModel.find({ _id: { $in: clientIds } }).select('name').lean(),
      this.serviceModel.find({ _id: { $in: serviceIds } }).select('name').lean(),
      this.staffModel.find({ _id: { $in: staffIds } }).select('name color').lean(),
    ]);

    const clientOf  = new Map(clients.map((c) => [(c._id as Types.ObjectId).toString(), c.name]));
    const serviceOf = new Map(services.map((s) => [(s._id as Types.ObjectId).toString(), s.name]));
    const staffOf   = new Map(staff.map((s) => [
      (s._id as Types.ObjectId).toString(),
      { name: s.name as string, color: (s.color as string) ?? '#B89968' },
    ]));

    const data: TodayAppt[] = appts
      .map((a) => {
        const member  = staffOf.get(a.stylistId.toString());
        const parts   = (member?.name ?? '—').split(' ');
        const initials = parts.map((p: string) => p.charAt(0).toUpperCase()).join('').slice(0, 2);

        let column: 'waiting' | 'in_chair' | 'done';
        if (a.status === 'completed') {
          column = 'done';
        } else if (a.start <= now && a.end >= now) {
          column = 'in_chair';
        } else {
          column = 'waiting';
        }

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
}
