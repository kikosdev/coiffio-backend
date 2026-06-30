import { Injectable, NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { Schedule, ScheduleDocument } from './schemas/schedule.schema';
import { StaffProfile, StaffProfileDocument } from './schemas/staff-profile.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { UpdateStaffDto } from './dto/team.dto';
import { SalonScope } from '../common/scope/salon-scope';
import { AuthUser } from '../common/decorators/current-user.decorator';

const MANAGERS = ['owner', 'manager'];
const MS_PER_MIN = 60_000;

export interface PublicStaff {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  color: string;
  isActive: boolean;
  level?: string;
  capabilities?: string[];
  baseRate?: number;
  commissionPct?: number;
}

export interface StylistStanding {
  stylistId: string;
  name: string;
  level: string;
  baseRate: number;
  commissionPct: number;
  upcomingShifts: { date: string; start: string; end: string }[];
  completedCount: number;
  upcomingCount: number;
  grossServices: number;
  estimatedCommission: number;
  tips: number;
}

@Injectable()
export class TeamService {
  constructor(
    @InjectModel(Staff.name)        private readonly staffModel:    Model<StaffDocument>,
    @InjectModel(Schedule.name)     private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel:  Model<StaffProfileDocument>,
    @InjectModel(Appointment.name)  private readonly apptModel:     Model<AppointmentDocument>,
  ) {}

  private toPublic(s: StaffDocument, profile?: StaffProfileDocument | null, includePay = false): PublicStaff {
    const base: PublicStaff = {
      id:       s._id.toString(),
      name:     s.name,
      email:    s.email,
      phone:    s.phone,
      role:     s.role,
      color:    s.color,
      isActive: s.isActive,
    };
    if (profile) {
      base.level = profile.level;
      base.capabilities = profile.capabilities;
      if (includePay) {
        base.baseRate = profile.baseRate;
        base.commissionPct = profile.commissionPct;
      }
    }
    return base;
  }

  // ─── Staff accounts ────────────────────────────────────────────────────────

  async listStaff(scope: SalonScope, requesterRole: string): Promise<PublicStaff[]> {
    const includePay = MANAGERS.includes(requesterRole);
    const staff = await this.staffModel
      .find({ salonId: scope.salonId })
      .sort({ role: 1, name: 1 })
      .exec();
    const profiles = await this.profileModel.find({ salonId: scope.salonId });
    const byStaff = new Map(profiles.map((p) => [p.userId.toString(), p]));
    return staff.map((s) => this.toPublic(s, byStaff.get(s._id.toString()), includePay));
  }

  async updateStaff(scope: SalonScope, id: string, dto: UpdateStaffDto): Promise<PublicStaff> {
    const s = await this.staffModel.findOne({ _id: id, salonId: scope.salonId });
    if (!s) throw new NotFoundException('Staff member not found.');
    if (dto.salonId && dto.salonId !== s.salonId.toString()) {
      throw new BadRequestException('Un staff ne peut pas changer de salon.');
    }
    if (s.role === 'owner' && dto.role) {
      throw new BadRequestException('The owner role cannot be changed.');
    }
    if (dto.name !== undefined) s.name = dto.name;
    if (dto.phone !== undefined) s.phone = dto.phone;
    if (dto.role !== undefined && s.role !== 'owner') s.role = dto.role;
    if (dto.isActive !== undefined) s.isActive = dto.isActive;
    if (dto.color !== undefined) s.color = dto.color;
    await s.save();

    const profileFields =
      dto.level !== undefined ||
      dto.capabilities !== undefined ||
      dto.baseRate !== undefined ||
      dto.commissionPct !== undefined;
    let profile = await this.profileModel.findOne({ salonId: scope.salonId, userId: s._id });
    if (profileFields) {
      const update: Partial<StaffProfile> = {};
      if (dto.level !== undefined) update.level = dto.level;
      if (dto.capabilities !== undefined) update.capabilities = dto.capabilities;
      if (dto.baseRate !== undefined) update.baseRate = dto.baseRate;
      if (dto.commissionPct !== undefined) update.commissionPct = dto.commissionPct;
      profile = await this.profileModel.findOneAndUpdate(
        { salonId: scope.salonId, userId: s._id },
        { $set: update, $setOnInsert: { salonId: scope.salonId, userId: s._id } },
        { upsert: true, new: true },
      );
    }
    return this.toPublic(s, profile, true);
  }

  async deactivateStaff(scope: SalonScope, id: string): Promise<PublicStaff> {
    const s = await this.staffModel.findOne({ _id: id, salonId: scope.salonId });
    if (!s) throw new NotFoundException('Staff member not found.');
    if (s.role === 'owner') throw new BadRequestException('The owner account cannot be deactivated.');
    s.isActive = false;
    await s.save();
    const profile = await this.profileModel.findOne({ salonId: scope.salonId, userId: s._id });
    return this.toPublic(s, profile, true);
  }

  // ─── Standing (#9 — le staff courant UNIQUEMENT) ──────────────────────────

  async myStanding(scope: SalonScope, user: AuthUser): Promise<StylistStanding> {
    // user.staffId = Staff._id (résolu au login depuis le profil staff).
    const me = await this.staffModel.findOne({ _id: user.staffId, salonId: scope.salonId });
    if (!me) throw new NotFoundException('Account not found.');
    const profile = await this.profileModel.findOne({ salonId: scope.salonId, userId: me._id });
    const commissionPct = profile?.commissionPct ?? 0;

    const now = new Date();
    const completed = await this.apptModel.find({
      salonId: scope.salonId,
      stylistId: me._id,
      status: 'completed',
    });
    const upcoming = await this.apptModel.countDocuments({
      salonId: scope.salonId,
      stylistId: me._id,
      status: { $in: ['booked', 'confirmed'] },
      start: { $gte: now },
    });
    const grossServices = completed.reduce((a, c) => a + (c.price ?? 0), 0);
    const estimatedCommission = Math.round((grossServices * commissionPct) / 100);

    const upcomingShifts: { date: string; start: string; end: string }[] = [];
    const schedule = await this.scheduleModel.findOne({ salonId: scope.salonId, stylistId: me._id });
    const weekly = me.week ?? [];
    const overrides = schedule?.overrides ?? [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(now.getTime() + i * 24 * 60 * MS_PER_MIN);
      const date = d.toISOString().slice(0, 10);
      const override = overrides.find((o) => o.date === date);
      if (override && (override.type === 'off' || override.type === 'leave')) continue;
      const base = weekly.find((w) => w.day === d.getUTCDay());
      if (override && override.type === 'custom' && override.start && override.end) {
        upcomingShifts.push({ date, start: override.start, end: override.end });
      } else if (base) {
        upcomingShifts.push({ date, start: base.start, end: base.end });
      }
    }

    return {
      stylistId:          me._id.toString(),
      name:               me.name,
      level:              profile?.level ?? 'senior',
      baseRate:           profile?.baseRate ?? 0,
      commissionPct,
      upcomingShifts,
      completedCount:     completed.length,
      upcomingCount:      upcoming,
      grossServices,
      estimatedCommission,
      tips: 0,
    };
  }
}
