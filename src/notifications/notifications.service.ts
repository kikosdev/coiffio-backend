import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Notification, NotificationDocument, NotifType } from './notification.schema';
import { NotificationsGateway } from './notifications.gateway';
import { User, UserDocument, UserRole } from '../schemas/user.schema';
import { Appointment, AppointmentDocument, AppointmentStatus } from '../schemas/appointment.schema';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private model: Model<NotificationDocument>,
    @InjectModel(User.name)         private userModel: Model<UserDocument>,
    @InjectModel(Appointment.name)  private apptModel: Model<AppointmentDocument>,
    private readonly gateway: NotificationsGateway,
  ) {}

  async push(
    userId: string | Types.ObjectId,
    type: NotifType,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    const notif = await this.model.create({ userId, type, title, body, data });
    this.gateway.emitToUser(userId.toString(), notif.toObject());
    return notif;
  }

  async pushToManagers(
    type: NotifType,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    const managers = await this.userModel
      .find({ role: { $in: [UserRole.OWNER, UserRole.SUPERVISOR] }, isActive: true })
      .select('_id')
      .lean();

    await Promise.all(
      managers.map(m => this.push(m._id.toString(), type, title, body, data)),
    );

    this.gateway.emitToRole(UserRole.OWNER, { type, title, body, data });
    this.gateway.emitToRole(UserRole.SUPERVISOR, { type, title, body, data });
  }

  async findMine(userId: string, page = 0, limit = 20) {
    const skip = page * limit;
    const [items, total] = await Promise.all([
      this.model.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments({ userId }),
    ]);
    return { items, total, page, limit };
  }

  async unreadCount(userId: string) {
    return this.model.countDocuments({ userId, isRead: false });
  }

  async markRead(id: string) {
    return this.model.findByIdAndUpdate(id, { isRead: true }, { new: true });
  }

  async markAllRead(userId: string) {
    return this.model.updateMany({ userId, isRead: false }, { isRead: true });
  }

  async remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendAppointmentReminders() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const start = new Date(tomorrow); start.setHours(0, 0, 0, 0);
    const end   = new Date(tomorrow); end.setHours(23, 59, 59, 999);

    const appts = await this.apptModel
      .find({
        startsAt: { $gte: start, $lte: end },
        status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING] },
        clientId: { $ne: null },
      })
      .populate('serviceIds')
      .lean();

    await Promise.all(
      appts.map(appt => {
        if (!appt.clientId) return Promise.resolve();
        return this.push(
          appt.clientId.toString(),
          NotifType.APPOINTMENT_REMINDER,
          'Reminder — your appointment is tomorrow',
          `Your visit at Maison Haire is scheduled for tomorrow at ${new Date(appt.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
          { appointmentId: appt._id?.toString() },
        );
      }),
    );
  }
}
