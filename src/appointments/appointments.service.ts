import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Appointment, AppointmentDocument, AppointmentStatus } from '../schemas/appointment.schema';
import { User, UserDocument } from '../schemas/user.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { NotifType } from '../notifications/notification.schema';

function generateRef(): string {
  return 'HRE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectModel(Appointment.name) private appointmentModel: Model<AppointmentDocument>,
    @InjectModel(User.name)        private userModel: Model<UserDocument>,
    private readonly notifSvc: NotificationsService,
  ) {}

  findAll(stylistId?: string, status?: string, date?: string) {
    const filter: Record<string, unknown> = {};
    if (stylistId) filter.stylistId = new Types.ObjectId(stylistId);
    if (status) filter.status = status;
    if (date) {
      const d = new Date(date);
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      filter.startsAt = { $gte: start, $lte: end };
    }
    return this.appointmentModel.find(filter).populate('stylistId').populate('serviceIds').exec();
  }

  async findMine(userId: string) {
    return this.appointmentModel
      .find({ clientId: new Types.ObjectId(userId) })
      .populate('stylistId')
      .populate('serviceIds')
      .sort({ startsAt: -1 })
      .exec();
  }

  async create(dto: {
    clientId?: string;
    guestName?: string;
    guestEmail?: string;
    guestPhone?: string;
    stylistId: string;
    serviceIds: string[];
    startsAt: string;
    totalDurationMinutes: number;
    totalPriceEur: number;
    notes?: string;
  }) {
    const startsAt = new Date(dto.startsAt);
    const endsAt   = new Date(startsAt.getTime() + dto.totalDurationMinutes * 60_000);

    const appt = await this.appointmentModel.create({
      ...dto,
      clientId:   dto.clientId ? new Types.ObjectId(dto.clientId) : null,
      stylistId:  new Types.ObjectId(dto.stylistId),
      serviceIds: dto.serviceIds.map(id => new Types.ObjectId(id)),
      startsAt,
      endsAt,
      referenceCode: generateRef(),
      status: AppointmentStatus.CONFIRMED,
    });

    if (dto.clientId) {
      await this.userModel.findByIdAndUpdate(dto.clientId, {
        $inc: { totalVisits: 1, totalSpent: dto.totalPriceEur, loyaltyPoints: Math.floor(dto.totalPriceEur) },
      });
    }

    // Notify assigned staff member
    const staffUser = await this.userModel.findOne({ staffId: new Types.ObjectId(dto.stylistId) });
    if (staffUser) {
      await this.notifSvc.push(
        staffUser._id.toString(),
        NotifType.APPOINTMENT_CREATED,
        'New appointment assigned',
        `A new appointment has been booked for ${new Date(startsAt).toLocaleDateString('fr-FR')} at ${new Date(startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
        { appointmentId: appt._id?.toString() },
      );
    }

    // Notify managers
    await this.notifSvc.pushToManagers(
      NotifType.APPOINTMENT_CREATED,
      'New appointment booked',
      `Ref ${appt.referenceCode} — ${dto.clientId ? 'client' : 'guest'} — €${dto.totalPriceEur}`,
      { appointmentId: appt._id?.toString() },
    );

    return appt;
  }

  async updateStatus(id: string, status: AppointmentStatus) {
    const appt = await this.appointmentModel.findByIdAndUpdate(id, { status }, { new: true });
    if (!appt) throw new NotFoundException('Appointment not found');

    if (status === AppointmentStatus.CONFIRMED && appt.clientId) {
      await this.notifSvc.push(
        appt.clientId.toString(),
        NotifType.APPOINTMENT_CONFIRMED,
        'Appointment confirmed',
        `Your appointment (ref ${appt.referenceCode}) has been confirmed.`,
        { appointmentId: id },
      );
    }

    if (status === AppointmentStatus.CANCELLED) {
      if (appt.clientId) {
        await this.notifSvc.push(
          appt.clientId.toString(),
          NotifType.APPOINTMENT_CANCELLED,
          'Appointment cancelled',
          `Your appointment (ref ${appt.referenceCode}) has been cancelled. Contact us to reschedule.`,
          { appointmentId: id },
        );
      }
      const staffUser = await this.userModel.findOne({ staffId: appt.stylistId });
      if (staffUser) {
        await this.notifSvc.push(
          staffUser._id.toString(),
          NotifType.APPOINTMENT_CANCELLED,
          'Appointment cancelled',
          `An appointment on your schedule (ref ${appt.referenceCode}) has been cancelled.`,
          { appointmentId: id },
        );
      }
    }

    return appt;
  }

  async cancel(id: string) {
    return this.updateStatus(id, AppointmentStatus.CANCELLED);
  }
}
