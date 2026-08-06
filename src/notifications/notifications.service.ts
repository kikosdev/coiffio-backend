import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { NotificationsGateway } from './notifications.gateway';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { runWithTenant, TenantContext } from '../common/tenant/tenant-context';

/**
 * Contexte système synthétique — même principe que `systemReadContext` dans
 * `client-profile.service.ts`/`booking.service.ts`. `dispatchOnce()` peut être appelée sous
 * un contexte guest (ex. `BookingService.emitBookingCreated`, booking public) — `notifications`
 * n'est pas dans `GUEST_READABLE` (jamais exposée au visiteur), mais son `findOne` post-upsert
 * est une lecture interne bornée (juste pour l'émission socket), pas une donnée renvoyée au
 * guest. Jamais une vraie session.
 */
function systemReadContext(tenantId: string): TenantContext {
  return { tenantId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

export interface DispatchInput {
  salonId: string;
  userId?: Types.ObjectId | string;
  staffId?: Types.ObjectId | string;
  role?: string;
  /** Also emit to `salon:{id}` — e.g. the POS board, which isn't any one user/role. */
  broadcast?: boolean;
  type: string;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export interface DispatchOnceInput {
  salonId: string;
  /** Dedup key — one booking (possibly several appointment rows) = one notification. */
  groupId: string;
  type: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private readonly model: Model<NotificationDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly gateway: NotificationsGateway,
  ) {}

  /**
   * Persist-then-emit (#7) : crée la Notification en Mongo PUIS émet. Jamais d'emit-only.
   * Scoping (#4) : un event userId va à `user:{id}` ; un event role va à `role:{role}`.
   */
  async dispatch(input: DispatchInput): Promise<NotificationDocument> {
    const notif = await this.model.create({
      salonId: input.salonId,
      userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
      staffId: input.staffId ? new Types.ObjectId(input.staffId) : undefined,
      role: input.role,
      type: input.type,
      title: input.title,
      body: input.body,
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
    void this.sendPushForDispatch(input, notif);
    return notif;
  }

  /**
   * Broadcast déduplié (Prompt 2, SKILL_fix_pos_board_notifs_FINAL) — upsert sur
   * (salonId, type, groupId) : la contrainte d'unicité en base rend le doublon
   * impossible même si appelé plusieurs fois pour le même booking (ex. multi-service).
   * N'émet sur le socket QUE lors d'un véritable premier insert.
   */
  async dispatchOnce(input: DispatchOnceInput): Promise<void> {
    const filter = { salonId: input.salonId, type: input.type, groupId: input.groupId };
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
      const notif = await runWithTenant(systemReadContext(input.salonId), () => this.model.findOne(filter).exec());
      this.gateway.emitToRoom(`salon:${input.salonId.toString()}`, input.type, notif);
    }
  }

  private async sendPushForDispatch(input: DispatchInput, notif: NotificationDocument): Promise<void> {
    const users = await this.resolvePushRecipients(input);
    const tokens = [...new Set(users.map((user) => user.expoPushToken).filter((token): token is string => !!token))];
    if (tokens.length === 0) return;

    const title = input.title ?? this.defaultPushTitle(input.type);
    const body = input.body ?? this.defaultPushBody(input);
    const pushResult = await this.sendExpoPush(tokens, {
      title,
      body,
      data: {
        notificationId: notif._id.toString(),
        type: input.type,
        ...(input.payload ?? {}),
      },
    });
    if (pushResult.invalidTokens.length > 0) {
      await this.userModel.updateMany({ expoPushToken: { $in: pushResult.invalidTokens } }, { $unset: { expoPushToken: '' } });
    }
    notif.pushSent = pushResult.sentCount > 0;
    await notif.save();
  }

  private async resolvePushRecipients(input: DispatchInput): Promise<UserDocument[]> {
    const filters: Record<string, unknown>[] = [];
    if (input.userId) filters.push({ _id: new Types.ObjectId(input.userId), isActive: true });

    const staffFilters: Record<string, unknown>[] = [];
    if (input.staffId) {
      staffFilters.push({ _id: new Types.ObjectId(input.staffId), salonId: new Types.ObjectId(input.salonId), isActive: true });
    }
    if (input.role) {
      staffFilters.push({ salonId: new Types.ObjectId(input.salonId), role: input.role, isActive: true });
    }
    if (input.broadcast) {
      staffFilters.push({ salonId: new Types.ObjectId(input.salonId), isActive: true });
    }
    if (staffFilters.length > 0) {
      const staff = await this.staffModel.find({ $or: staffFilters }).select('userId').lean();
      const staffUserIds = staff.map((member) => member.userId).filter(Boolean);
      if (staffUserIds.length > 0) filters.push({ _id: { $in: staffUserIds }, isActive: true });
    }
    if (filters.length === 0) return [];
    return this.userModel.find({ $or: filters, expoPushToken: { $exists: true, $ne: '' } });
  }

  private defaultPushTitle(type: string): string {
    if (type.includes('appointment.created')) return 'New appointment';
    if (type.includes('appointment.cancelled')) return 'Appointment cancelled';
    return 'Coiffio';
  }

  private defaultPushBody(input: DispatchInput): string {
    const clientName = typeof input.payload?.clientName === 'string' ? input.payload.clientName : 'A client';
    const serviceName = typeof input.payload?.serviceName === 'string' ? input.payload.serviceName : 'booking';
    const start = input.payload?.start ? new Date(input.payload.start as string | Date) : null;
    const at = start && !Number.isNaN(start.getTime())
      ? ` at ${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`
      : '';
    if (input.type.includes('appointment.created')) return `${clientName} booked ${serviceName}${at}.`;
    if (input.type.includes('appointment.cancelled')) return `${clientName}'s appointment was cancelled.`;
    return 'You have a new notification.';
  }

  private async sendExpoPush(
    tokens: string[],
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<{ invalidTokens: string[]; sentCount: number }> {
    const invalidTokens: string[] = [];
    let sentCount = 0;
    for (let i = 0; i < tokens.length; i += 100) {
      const chunk = tokens.slice(i, i + 100);
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(chunk.map((to) => ({
            to,
            sound: 'default',
            priority: 'high',
            title: message.title,
            body: message.body,
            data: message.data,
          }))),
        });
        const json = await res.json().catch(() => null) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
        json?.data?.forEach((ticket, index) => {
          if (ticket.status === 'ok') sentCount += 1;
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(chunk[index]);
          }
        });
      } catch (err) {
        this.logger.warn(`Expo push send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { invalidTokens, sentCount };
  }

  /** Liste scopée : identity userId, staff profile staffId, OU role match (#4). */
  async list(user: AuthUser): Promise<NotificationDocument[]> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    return this.model
      .find({
        $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }],
      })
      .sort({ date: -1 })
      .limit(100);
  }

  async markRead(user: AuthUser, id: string): Promise<NotificationDocument> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    const n = await this.model.findOne({
      _id: id,
      $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }],
    });
    if (!n) throw new NotFoundException('Notification not found.');
    n.read = true;
    await n.save();
    return n;
  }

  async readAll(user: AuthUser): Promise<{ updated: number }> {
    const userId = new Types.ObjectId(user.sub);
    const staffId = user.staffId ? new Types.ObjectId(user.staffId) : null;
    const res = await this.model.updateMany(
      { read: false, $or: [{ userId }, ...(staffId ? [{ staffId }] : []), { role: user.role }] },
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
      .find({ salonId, groupId: { $exists: true } })
      .sort({ date: -1 })
      .limit(50);
  }

  /** Marks broadcasts as seen by this specific POS terminal/staff — shared feed, per-reader ack. */
  async markReadByReader(salonId: string, readerId: string, ids?: string[]): Promise<{ updated: number }> {
    const filter: Record<string, unknown> = { salonId };
    if (ids?.length) filter._id = { $in: ids };
    const res = await this.model.updateMany(filter, { $addToSet: { readBy: readerId } });
    return { updated: res.modifiedCount ?? 0 };
  }
}
