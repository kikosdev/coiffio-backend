import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { LeaveRequest, LeaveRequestDocument, LeaveConflict } from './schemas/leave-request.schema';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { Schedule, ScheduleDocument } from './schemas/schedule.schema';
import { CreateLeaveRequestDto } from './dto/team.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { getTenantContext } from '../common/tenant/tenant-context';

const MANAGERS = ['owner', 'manager'];

@Injectable()
export class LeaveService {
  constructor(
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    @InjectModel(Schedule.name) private readonly scheduleModel: Model<ScheduleDocument>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Bornes Date d'une plage inclusive de dates 'YYYY-MM-DD' (UTC). */
  private rangeBounds(from: string, to: string): { start: Date; end: Date } {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new BadRequestException('Invalid range: "to" must be on or after "from".');
    }
    return { start, end };
  }

  async create(requester: AuthUser, dto: CreateLeaveRequestDto): Promise<LeaveRequestDocument> {
    const isManager = MANAGERS.includes(requester.role);
    // Un stylist ne peut déposer que pour lui-même ; owner/manager pour n'importe quel staff.
    const stylistId = isManager && dto.stylistId ? dto.stylistId : requester.sub;
    if (!isManager && dto.stylistId && dto.stylistId !== requester.sub) {
      throw new ForbiddenException('You can only request leave for yourself.');
    }
    this.rangeBounds(dto.range.from, dto.range.to); // valide la plage
    const created = await this.leaveModel.create({
      stylistId: new Types.ObjectId(stylistId),
      swapWithId: dto.swapWithId ? new Types.ObjectId(dto.swapWithId) : undefined,
      type: dto.type,
      range: { from: dto.range.from, to: dto.range.to },
      note: dto.note ?? '',
      status: 'pending',
      conflicts: [],
    });
    // leave.requested → owner + manager (#4 : diffusion par rôle).
    const salonId = getTenantContext().tenantId;
    const payload = { leaveRequestId: created._id.toString(), stylistId, range: dto.range };
    void this.notifications.dispatch({ salonId, role: 'owner', type: SOCKET_EVENTS.LEAVE_REQUESTED, payload });
    void this.notifications.dispatch({ salonId, role: 'manager', type: SOCKET_EVENTS.LEAVE_REQUESTED, payload });
    return created;
  }

  async list(requester: AuthUser, status?: string): Promise<LeaveRequestDocument[]> {
    const filter: FilterQuery<LeaveRequestDocument> = {};
    if (status) filter.status = status;
    // Stylist : ne voit que ses propres demandes.
    if (!MANAGERS.includes(requester.role)) filter.stylistId = new Types.ObjectId(requester.sub);
    return this.leaveModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  private async findConflicts(
    stylistId: Types.ObjectId,
    start: Date,
    end: Date,
  ): Promise<LeaveConflict[]> {
    // Chevauchement : appointment.start < rangeEnd && appointment.end > rangeStart, status != cancelled (#6).
    const overlapping = await this.apptModel
      .find({
        stylistId,
        status: { $ne: 'cancelled' },
        start: { $lt: end },
        end: { $gt: start },
      })
      .sort({ start: 1 })
      .exec();
    return overlapping.map((a) => ({
      appointmentId: a._id.toString(),
      start: a.start,
      end: a.end,
      clientId: a.clientId?.toString() ?? '',
    }));
  }

  /**
   * Approbation (#6) : BLOCK + force reassign. On calcule les conflits ; s'il y en a,
   * l'approbation est REFUSÉE par un **409 Conflict** portant la liste des conflits
   * (jamais d'auto-résolution). Le manager doit réassigner/annuler les bookings d'abord.
   * Sans conflit : approuvé ET override `leave` posé sur la rota pour chaque jour de la plage.
   */
  async approve(decider: AuthUser, id: string): Promise<LeaveRequestDocument> {
    const req = await this.leaveModel.findOne({ _id: id });
    if (!req) throw new NotFoundException('Leave request not found.');
    if (req.status !== 'pending') {
      throw new BadRequestException(`Request already ${req.status}.`);
    }

    const { start, end } = this.rangeBounds(req.range.from, req.range.to);
    const conflicts = await this.findConflicts(req.stylistId as Types.ObjectId, start, end);
    if (conflicts.length > 0) {
      req.conflicts = conflicts; // persiste pour l'UI
      await req.save();
      // BLOCAGE 409 — la liste des conflits voyage dans le body (cf. AllExceptionsFilter → data).
      throw new ConflictException({
        message: `Approval blocked: ${conflicts.length} conflicting booking(s). Reassign or cancel them first.`,
        conflicts,
      });
    }

    req.status = 'approved';
    req.conflicts = [];
    req.decidedBy = new Types.ObjectId(decider.sub);
    req.decidedAt = new Date();
    await req.save();

    // Pose les overrides 'leave' sur la rota (1 par jour de la plage).
    await this.applyLeaveOverrides(req.stylistId as Types.ObjectId, req.range.from, req.range.to);

    return req;
  }

  async reject(decider: AuthUser, id: string): Promise<LeaveRequestDocument> {
    const req = await this.leaveModel.findOne({ _id: id });
    if (!req) throw new NotFoundException('Leave request not found.');
    if (req.status !== 'pending') throw new BadRequestException(`Request already ${req.status}.`);
    req.status = 'rejected';
    req.decidedBy = new Types.ObjectId(decider.sub);
    req.decidedAt = new Date();
    await req.save();
    return req;
  }

  private async applyLeaveOverrides(
    stylistId: Types.ObjectId,
    from: string,
    to: string,
  ): Promise<void> {
    const schedule = await this.scheduleModel.findOneAndUpdate(
      { stylistId },
      { $setOnInsert: { weekly: [], overrides: [] } },
      { upsert: true, new: true },
    );
    if (!schedule) return;
    const dates = this.eachDate(from, to);
    const kept = schedule.overrides.filter((o) => !dates.includes(o.date));
    schedule.overrides = [
      ...kept,
      ...dates.map((date) => ({ date, type: 'leave' as const, note: 'Approved leave' })),
    ];
    await schedule.save();
  }

  private eachDate(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(`${from}T00:00:00.000Z`);
    const last = new Date(`${to}T00:00:00.000Z`);
    while (cur <= last) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }
}
