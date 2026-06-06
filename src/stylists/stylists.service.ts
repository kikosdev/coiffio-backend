import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Stylist, StylistDocument } from '../schemas/stylist.schema';
import { Appointment, AppointmentDocument, AppointmentStatus } from '../schemas/appointment.schema';

@Injectable()
export class StylistsService {
  constructor(
    @InjectModel(Stylist.name) private stylistModel: Model<StylistDocument>,
    @InjectModel(Appointment.name) private appointmentModel: Model<AppointmentDocument>,
  ) {}

  findAll() {
    return this.stylistModel.find({ isActive: true }).exec();
  }

  async findOne(id: string) {
    const stylist = await this.stylistModel.findById(id);
    if (!stylist) throw new NotFoundException('Stylist not found');
    return stylist;
  }

  async create(dto: Partial<Stylist>) {
    return this.stylistModel.create(dto);
  }

  async update(id: string, dto: Partial<Stylist>) {
    const stylist = await this.stylistModel.findByIdAndUpdate(id, dto, { new: true });
    if (!stylist) throw new NotFoundException('Stylist not found');
    return stylist;
  }

  async getAvailableSlots(stylistId: string, date: string, durationMinutes: number) {
    const stylist = await this.findOne(stylistId);
    const [shiftStart, shiftEnd] = stylist.shift;

    const day = new Date(date);
    const slots: string[] = [];
    const stepMinutes = 15;
    const totalSlots = ((shiftEnd - shiftStart) * 60 - durationMinutes) / stepMinutes;

    // Get existing confirmed/pending appointments for this stylist on this day
    const startOfDay = new Date(day); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day); endOfDay.setHours(23, 59, 59, 999);

    const existing = await this.appointmentModel.find({
      stylistId: new Types.ObjectId(stylistId),
      status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING] },
      startsAt: { $gte: startOfDay, $lte: endOfDay },
    });

    for (let i = 0; i <= totalSlots; i++) {
      const startMin = shiftStart * 60 + i * stepMinutes;
      const endMin = startMin + durationMinutes;

      if (endMin > shiftEnd * 60) break;

      const startTime = new Date(day);
      startTime.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      const endTime = new Date(day);
      endTime.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

      const conflict = existing.some(appt =>
        startTime < appt.endsAt && endTime > appt.startsAt,
      );

      if (!conflict) {
        slots.push(`${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`);
      }
    }

    return slots;
  }
}
