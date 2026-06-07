import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TeamMember, TeamMemberDocument } from '../schemas/team-member.schema';
import { LeaveRequest, LeaveRequestDocument, LeaveDecision } from '../schemas/leave-request.schema';
import { PayPeriod, PayPeriodDocument } from '../schemas/pay-period.schema';
import { computeSlip, Payslip } from './payroll.config';

type WeekDay = number[] | 'leave' | null;

@Injectable()
export class TeamService {
  constructor(
    @InjectModel(TeamMember.name) private memberModel: Model<TeamMemberDocument>,
    @InjectModel(LeaveRequest.name) private leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(PayPeriod.name) private periodModel: Model<PayPeriodDocument>,
  ) {}

  // ── Members ──────────────────────────────────────────────
  findAll() {
    return this.memberModel.find({ isActive: true }).exec();
  }

  async findOne(id: string) {
    const m = await this.memberModel.findById(id);
    if (!m) throw new NotFoundException('Team member not found');
    return m;
  }

  async create(dto: Partial<TeamMember>) {
    if (!dto.name || !dto.role) {
      throw new BadRequestException('name and role are required');
    }
    if (!dto.initials && dto.name) dto.initials = dto.name.trim()[0].toUpperCase();
    if (!dto.week) dto.week = [null, null, null, null, null, null, null];
    return this.memberModel.create(dto);
  }

  async update(id: string, dto: Partial<TeamMember>) {
    const m = await this.memberModel.findByIdAndUpdate(id, dto, { new: true });
    if (!m) throw new NotFoundException('Team member not found');
    return m;
  }

  async remove(id: string) {
    const m = await this.memberModel.findByIdAndDelete(id);
    if (!m) throw new NotFoundException('Team member not found');
    return { deleted: true, id };
  }

  // ── Temps de travail (rota) ──────────────────────────────
  async setWeek(id: string, week: WeekDay[]) {
    if (!Array.isArray(week) || week.length !== 7) {
      throw new BadRequestException('week must be an array of 7 entries');
    }
    week.forEach((d) => this.validateDay(d));
    return this.update(id, { week });
  }

  async setDay(id: string, dayIdx: number, value: WeekDay) {
    if (dayIdx < 0 || dayIdx > 6) throw new BadRequestException('dayIdx must be 0..6');
    this.validateDay(value);
    const m = await this.findOne(id);
    const week = [...(m.week as WeekDay[])];
    week[dayIdx] = value;
    m.set('week', week);
    m.markModified('week');
    await m.save();
    return m;
  }

  private validateDay(d: WeekDay) {
    if (d === null || d === 'leave') return;
    if (Array.isArray(d) && d.length === 2) {
      const [s, e] = d;
      if (typeof s === 'number' && typeof e === 'number' && e > s) return;
    }
    throw new BadRequestException('Invalid day: expected null | "leave" | [start,end] with end > start');
  }

  // ── Congés / Approvals ───────────────────────────────────
  listLeaveRequests() {
    return this.leaveModel.find().sort({ createdAt: -1 }).exec();
  }

  async decideLeave(id: string, decided: LeaveDecision) {
    if (![LeaveDecision.APPROVED, LeaveDecision.DECLINED].includes(decided)) {
      throw new BadRequestException('decided must be "ok" or "no"');
    }
    const r = await this.leaveModel.findByIdAndUpdate(id, { decided }, { new: true });
    if (!r) throw new NotFoundException('Leave request not found');
    return r;
  }

  createLeaveRequest(dto: Partial<LeaveRequest>) {
    return new this.leaveModel(dto).save();
  }

  // ── Périodes & paie ──────────────────────────────────────
  listPeriods() {
    return this.periodModel.find().sort({ createdAt: -1 }).exec();
  }

  async payslip(memberId: string, periodId: string): Promise<Payslip & { member: string; period: string }> {
    const member = await this.findOne(memberId);
    const period = await this.periodModel.findById(periodId);
    if (!period) throw new NotFoundException('Pay period not found');
    const slip = computeSlip(
      { base: member.base, commission: member.commission, tip: member.tip },
      period.mult,
    );
    return { ...slip, member: member.name, period: period.label };
  }
}
