import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { NotificationsGateway } from './notifications.gateway';
import { SalonScope } from '../common/scope/salon-scope';
import { AuthUser } from '../common/decorators/current-user.decorator';

export interface DispatchInput {
  salonId: Types.ObjectId | string;
  userId?: Types.ObjectId | string;
  staffId?: Types.ObjectId | string;
  role?: string;
  /** Also emit to `salon:{id}` — e.g. the POS board, which isn't any one user/role. */
  broadcast?: boolean;
  type: string;
  payload?: Record<string, unknown>;
}

export interface DispatchOnceInput {
  salonId: Types.ObjectId | string;
  /** Dedup key — one booking (possibly several appointment rows) = one notification. */
  groupId: string;
  type: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly model: Model<NotificationDocument>,
    private readonly gateway: NotificationsGateway,
  ) {}

  /**
   * Persist-then-emit (#7) : crée la Notification en Mongo PUIS émet. Jamais d'emit-only.
   * Scoping (#4) : un event userId va à `user:{id}` ; un event role va à `role:{role}`.
   */
  async dispatch(input: DispatchInput): Promise<NotificationDocument> {
    const notif = await this.model.create({
      salonId: new Types.ObjectId(input.salonId),
      userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
      staffId: input.staffId ? new Types.ObjectId(input.staffId) : undefined,
      role: input.role,
      type: input.type,
      payload: input.payload ?? {},
      read: false,
      date: new Date(),
    });
    if (input.userId) {
      const id = input.userId.toString();
      this.gateway.emitToRoom(`user:${id}`, input.type, notif);
    }
    if (input.staffId) {
      const id = input.staffId.toString();
      this.gateway.emitToRoom(`staff:${id}`, input.type, notif);
    }
    if (input.role) this.gateway.emitToRoom(`role:${input.role}`, input.type, notif);
    if (input.broadcast) this.gateway.emitToRoom(`salon:${input.salonId.toString()}`, input.type, notif);
    return notif;
  }

  /**
   * Broadcast déduplié (Prompt 2, SKILL_fix_pos_board_notifs_FINAL) — upsert sur
   * (salonId, type, groupId) : la contrainte d'unicité en base rend le doublon
   * impossible même si appelé plusieurs fois pour le même booking (ex. multi-service).
   * N'émet sur le socket QUE lors d'un véritable premier insert.
   */
  async dispatchOnce(input: DispatchOnceInput): Promise<void> {
    const filter = { salonId: new Types.ObjectId(input.salonId), type: input.type, groupId: input.groupId };
    const res = await this.model.updateOne(
      filter,
      {
        $setOnInsert: {
          ...filter,
          title: input.title,
          body: input.body,
          payload: input.payload ?? {},
          read: false,
          readBy: [],
          date: new Date(),
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount > 0) {
      const notif = await this.model.findOne(filter);
      this.gateway.emitToRoom(`salon:${input.salonId.toString()}`, input.type, notif);
    }
  }

  /** Liste scopée : identity userId, staff profile staffId, OU role match (#4). */
  async list(scope: SalonScope, user: AuthUser): Promise<NotificationDocument[]> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    return this.model
      .find({
        salonId: scope.salonId,
        $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }],
      })
      .sort({ date: -1 })
      .limit(100);
  }

  async markRead(scope: SalonScope, user: AuthUser, id: string): Promise<NotificationDocument> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    const n = await this.model.findOne({
      _id: id,
      salonId: scope.salonId,
      $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }],
    });
    if (!n) throw new NotFoundException('Notification not found.');
    n.read = true;
    await n.save();
    return n;
  }

  async readAll(scope: SalonScope, user: AuthUser): Promise<{ updated: number }> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    const res = await this.model.updateMany(
      { salonId: scope.salonId, read: false, $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }] },
      { $set: { read: true } },
    );
    return { updated: res.modifiedCount ?? 0 };
  }

  /**
   * POS history feed (Prompt 2, SKILL_fix_pos_board_notifs_FINAL) — the whole salon-wide
   * broadcast feed, not scoped to a specific user/role like `list()` above. Hydrates the
   * kiosk's bell on app restart.
   */
  async listForSalon(salonId: string): Promise<NotificationDocument[]> {
    return this.model
      .find({ salonId: new Types.ObjectId(salonId), groupId: { $exists: true } })
      .sort({ date: -1 })
      .limit(50);
  }

  /** Marks broadcasts as seen by this specific POS terminal/staff — shared feed, per-reader ack. */
  async markReadByReader(salonId: string, readerId: string, ids?: string[]): Promise<{ updated: number }> {
    const filter: Record<string, unknown> = { salonId: new Types.ObjectId(salonId) };
    if (ids?.length) filter._id = { $in: ids };
    const res = await this.model.updateMany(filter, { $addToSet: { readBy: readerId } });
    return { updated: res.modifiedCount ?? 0 };
  }
}
