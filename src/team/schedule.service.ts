import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { Schedule, ScheduleDocument } from './schemas/schedule.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { AddOverrideDto, SetWeeklyDto } from './dto/team.dto';
import { SalonScope } from '../common/scope/salon-scope';

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * Source de vérité de la disponibilité. Weekly shifts sont stockés dans Staff.week
 * ET synchronisés dans Schedule.weekly pour la rétrocompatibilité du booking engine.
 * Les overrides restent dans Schedule.overrides.
 */
@Injectable()
export class ScheduleService {
  constructor(
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Schedule.name) private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
  ) {}

  private async assertStaff(scope: SalonScope, stylistId: string): Promise<StaffDocument> {
    const s = await this.staffModel.findOne({ _id: stylistId, salonId: scope.salonId });
    if (!s) throw new NotFoundException('Staff member not found.');
    return s;
  }

  /** Horaires d'ouverture du salon — utilisé par le frontend pour pré-filtrer les jours. */
  async getSalonHours(scope: SalonScope) {
    const salon = await this.salonModel.findById(scope.salonId).lean();
    if (!salon) throw new NotFoundException('Salon introuvable.');
    return salon.businessHours ?? [];
  }

  /** Vérifie que chaque shift est dans un jour ouvert et dans les plages horaires du salon. */
  private async validateAgainstSalon(scope: SalonScope, weekly: SetWeeklyDto['weekly']): Promise<void> {
    const hours = await this.getSalonHours(scope);
    const byDay = new Map(hours.map((h) => [h.day, h]));

    for (const shift of weekly) {
      const salon = byDay.get(shift.day);
      if (!salon || !salon.isOpen) {
        throw new BadRequestException(
          `Le salon est fermé le ${DAY_NAMES[shift.day]}. Supprimez ce jour de la rota.`,
        );
      }
      if (shift.start < salon.start) {
        throw new BadRequestException(
          `${DAY_NAMES[shift.day]} : l'heure de début (${shift.start}) est avant l'ouverture du salon (${salon.start}).`,
        );
      }
      if (shift.end > salon.end) {
        throw new BadRequestException(
          `${DAY_NAMES[shift.day]} : l'heure de fin (${shift.end}) dépasse la fermeture du salon (${salon.end}).`,
        );
      }
    }
  }

  async getSchedule(scope: SalonScope, stylistId: string): Promise<ScheduleDocument> {
    await this.assertStaff(scope, stylistId);
    const doc = await this.scheduleModel.findOneAndUpdate(
      { salonId: scope.salonId, stylistId: new Types.ObjectId(stylistId) },
      { $setOnInsert: { weekly: [], overrides: [] } },
      { upsert: true, new: true },
    );
    // Reflect Staff.week into the returned doc for frontend compatibility.
    const staff = await this.staffModel.findById(stylistId).lean();
    if (doc && staff) {
      (doc as any).weekly = staff.week ?? [];
    }
    return doc as ScheduleDocument;
  }

  async setWeekly(scope: SalonScope, stylistId: string, dto: SetWeeklyDto): Promise<ScheduleDocument> {
    const staff = await this.assertStaff(scope, stylistId);

    await this.validateAgainstSalon(scope, dto.weekly);

    const weekly = dto.weekly.map((w) => ({
      day: w.day,
      start: w.start,
      end: w.end,
      breaks: w.breaks ?? [],
    }));

    // Staff.week is the primary store.
    staff.week = weekly;
    await staff.save();

    // Keep Schedule.weekly in sync so booking engine and overview can read it.
    const doc = await this.scheduleModel.findOneAndUpdate(
      { salonId: scope.salonId, stylistId: new Types.ObjectId(stylistId) },
      { $set: { weekly }, $setOnInsert: { overrides: [] } },
      { upsert: true, new: true },
    );
    return doc as ScheduleDocument;
  }

  async addOverride(scope: SalonScope, stylistId: string, dto: AddOverrideDto): Promise<ScheduleDocument> {
    if (dto.type === 'custom' && (!dto.start || !dto.end)) {
      throw new BadRequestException('A custom override requires start and end.');
    }
    const doc = await this.getSchedule(scope, stylistId);
    doc.overrides = doc.overrides.filter((o) => o.date !== dto.date);
    doc.overrides.push({
      date: dto.date,
      type: dto.type,
      start: dto.start,
      end: dto.end,
      note: dto.note ?? '',
    });
    await doc.save();
    return doc;
  }

  async removeOverride(scope: SalonScope, stylistId: string, date: string): Promise<ScheduleDocument> {
    const doc = await this.getSchedule(scope, stylistId);
    doc.overrides = doc.overrides.filter((o) => o.date !== date);
    await doc.save();
    return doc;
  }
}
