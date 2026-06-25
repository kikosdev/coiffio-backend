import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ScheduleDocument = Schedule & Document;

export type OverrideType = 'off' | 'leave' | 'custom';

export interface TimeBreak {
  start: string; // "HH:mm"
  end: string;
}

export interface WeeklyShift {
  day: number; // 0=dimanche … 6=samedi
  start: string; // "HH:mm"
  end: string;
  breaks: TimeBreak[];
}

export interface ScheduleOverride {
  date: string; // "YYYY-MM-DD"
  type: OverrideType; // off/leave retirent la journée ; custom remplace les heures
  start?: string;
  end?: string;
  note?: string;
}

/**
 * Rota d'un stylist (constitution). `weekly` = fenêtre de travail de base par jour ;
 * `overrides` = exceptions datées (off/leave suppriment ; custom remplace). Décision #1 :
 * la disponibilité est calculée live à partir de Schedule − Appointments (jamais stockée).
 */
@Schema({ timestamps: true })
export class Schedule {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true, index: true })
  stylistId: Types.ObjectId;

  @Prop({
    type: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        start: { type: String, required: true },
        end: { type: String, required: true },
        breaks: {
          type: [{ start: { type: String, required: true }, end: { type: String, required: true } }],
          default: [],
        },
      },
    ],
    default: [],
  })
  weekly: WeeklyShift[];

  @Prop({
    type: [
      {
        date: { type: String, required: true },
        type: { type: String, enum: ['off', 'leave', 'custom'], required: true },
        start: { type: String },
        end: { type: String },
        note: { type: String, default: '' },
      },
    ],
    default: [],
  })
  overrides: ScheduleOverride[];
}

export const ScheduleSchema = SchemaFactory.createForClass(Schedule);
ScheduleSchema.index({ salonId: 1, stylistId: 1 }, { unique: true });
