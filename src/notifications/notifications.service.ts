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
  role?: string;
  type: string;
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
      role: input.role,
      type: input.type,
      payload: input.payload ?? {},
      read: false,
      date: new Date(),
    });
    if (input.userId) this.gateway.emitToRoom(`user:${input.userId.toString()}`, input.type, notif);
    if (input.role) this.gateway.emitToRoom(`role:${input.role}`, input.type, notif);
    return notif;
  }

  /** Liste scopée : userId == soi OU role match (#4). */
  async list(scope: SalonScope, user: AuthUser): Promise<NotificationDocument[]> {
    return this.model
      .find({
        salonId: scope.salonId,
        $or: [{ userId: new Types.ObjectId(user.sub) }, { role: user.role }],
      })
      .sort({ date: -1 })
      .limit(100);
  }

  async markRead(scope: SalonScope, user: AuthUser, id: string): Promise<NotificationDocument> {
    const n = await this.model.findOne({
      _id: id,
      salonId: scope.salonId,
      $or: [{ userId: new Types.ObjectId(user.sub) }, { role: user.role }],
    });
    if (!n) throw new NotFoundException('Notification not found.');
    n.read = true;
    await n.save();
    return n;
  }

  async readAll(scope: SalonScope, user: AuthUser): Promise<{ updated: number }> {
    const res = await this.model.updateMany(
      { salonId: scope.salonId, read: false, $or: [{ userId: new Types.ObjectId(user.sub) }, { role: user.role }] },
      { $set: { read: true } },
    );
    return { updated: res.modifiedCount ?? 0 };
  }
}
