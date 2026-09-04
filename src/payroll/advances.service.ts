import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { SalaryAdvance, SalaryAdvanceDocument } from './schemas/salary-advance.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { CreateAdvanceDto, DecideAdvanceDto } from './dto/payroll.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { SOCKET_EVENTS } from '../common/socket-events';
import { getTenantContext } from '../common/tenant/tenant-context';

// Rôles staff (non-owner) pouvant demander une avance pour eux-mêmes (P11 : l'écriture
// décisionnelle — accorder/décider — reste owner uniquement, seule la DEMANDE est ouverte).
const REQUESTER_ROLES = ['manager', 'stylist', 'colorist'];

@Injectable()
export class AdvancesService {
  constructor(
    @InjectModel(SalaryAdvance.name) private readonly advanceModel: Model<SalaryAdvanceDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * P6/Prompt 2 : deux chemins distincts selon qui appelle.
   * - owner : accorde directement une avance à un staff → déjà `approved` (l'owner remet
   *   la somme en décidant de la créer, pas de file d'attente pour lui-même).
   * - staff (manager/stylist/colorist) : dépose une demande → `pending`, en attente de
   *   décision owner via `decide()`.
   */
  async create(requester: AuthUser, dto: CreateAdvanceDto): Promise<SalaryAdvanceDocument> {
    const isOwner = requester.role === 'owner';
    if (isOwner) {
      if (!dto.staffId) throw new BadRequestException('staffId is required when an owner grants an advance.');
      // `staffs` est TENANT_SCOPED — sans cette garde, un owner pourrait accorder une avance
      // au nom d'un staffId d'un AUTRE salon (aucune fuite de données, mais un enregistrement
      // dénué de sens sous le mauvais salon plutôt qu'un refus explicite).
      const staff = await this.staffModel.findOne({ _id: dto.staffId });
      if (!staff) throw new NotFoundException('Staff not found in this salon.');
      const now = new Date();
      const created = await this.advanceModel.create({
        staffId: dto.staffId,
        amount: dto.amount,
        reason: dto.reason ?? '',
        status: 'approved',
        requestedBy: requester.sub,
        approvedBy: requester.sub,
        approvedAt: now,
      });
      return created;
    }

    if (!REQUESTER_ROLES.includes(requester.role) || !requester.staffId) {
      throw new BadRequestException('Only a staff member with a staff profile can request an advance.');
    }
    const created = await this.advanceModel.create({
      staffId: requester.staffId,
      amount: dto.amount,
      reason: dto.reason ?? '',
      status: 'pending',
      requestedBy: requester.staffId,
    });
    // Persist-then-emit (P12) : advance.requested → owner (+ supervisor si un jour introduit).
    const salonId = getTenantContext().tenantId;
    void this.notifications.dispatch({
      salonId,
      role: 'owner',
      type: SOCKET_EVENTS.ADVANCE_REQUESTED,
      payload: { advanceId: created._id.toString(), staffId: requester.staffId, amount: dto.amount },
    });
    return created;
  }

  /** Owner only (RolesGuard côté controller). pending → approved|rejected, jamais au-delà. */
  async decide(decider: AuthUser, id: string, dto: DecideAdvanceDto): Promise<SalaryAdvanceDocument> {
    const advance = await this.advanceModel.findOne({ _id: id });
    if (!advance) throw new NotFoundException('Advance not found.');
    if (advance.status !== 'pending') {
      throw new ConflictException(`Advance already ${advance.status}.`);
    }

    if (dto.decision === 'approve') {
      advance.status = 'approved';
      advance.approvedBy = decider.sub;
      advance.approvedAt = new Date();
    } else {
      advance.status = 'rejected';
      advance.rejectedReason = dto.rejectedReason ?? '';
    }
    await advance.save();

    // Persist-then-emit (P12) : advance.decided → le staff concerné.
    const salonId = getTenantContext().tenantId;
    void this.notifications.dispatch({
      salonId,
      staffId: advance.staffId,
      type: SOCKET_EVENTS.ADVANCE_DECIDED,
      payload: { advanceId: advance._id.toString(), status: advance.status },
    });
    return advance;
  }

  /** Owner only — overview salon (déjà scopé salonId par le plugin tenant). */
  async listForOwner(query: { status?: string; staffId?: string }): Promise<SalaryAdvanceDocument[]> {
    const filter: FilterQuery<SalaryAdvanceDocument> = {};
    if (query.status) filter.status = query.status;
    if (query.staffId) filter.staffId = query.staffId;
    return this.advanceModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  /** #9 — le staff ne voit strictement que ses propres avances. */
  async listForStaff(user: AuthUser): Promise<SalaryAdvanceDocument[]> {
    if (!user.staffId) return [];
    return this.advanceModel.find({ staffId: user.staffId }).sort({ createdAt: -1 }).exec();
  }
}
