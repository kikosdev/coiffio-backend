import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type StaffDocument = Staff & Document;

export type StaffRole = 'owner' | 'manager' | 'stylist' | 'colorist';

export interface TimeBreak {
  start: string;
  end: string;
}

export interface WeeklyShift {
  day: number; // 0=Sun … 6=Sat
  start: string; // "HH:mm"
  end: string;
  breaks: TimeBreak[];
}

export interface PublicProfile {
  visible: boolean;
  title?: string;
  bio?: string;
  order: number;
}

@Schema({ timestamps: true })
export class Staff {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  // Lien vers users (Identity Service). OBLIGATOIRE — tout staff a un compte.
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  // Unique par salon uniquement — index composé défini ci-dessous.
  @Prop({ lowercase: true, trim: true })
  email: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: '#B89968' })
  color: string;

  @Prop({
    type: String,
    enum: ['owner', 'manager', 'stylist', 'colorist'],
    required: true,
    index: true,
  })
  role: StaffRole;

  @Prop({ default: true })
  isActive: boolean;

  // Self-toggle — stops the stylist from being offered for new public bookings
  // (availability engine + marketplace "available" badge) without deactivating the account.
  @Prop({ default: true })
  acceptingBookings: boolean;

  @Prop({
    type: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        start: { type: String, required: true },
        end: { type: String, required: true },
        breaks: {
          type: [
            {
              start: { type: String, required: true },
              end: { type: String, required: true },
            },
          ],
          default: [],
        },
      },
    ],
    default: [],
  })
  week: WeeklyShift[];

  @Prop({
    type: {
      visible: { type: Boolean, default: true },
      title: { type: String },
      bio: { type: String },
      order: { type: Number, default: 0 },
    },
    default: { visible: true, order: 0 },
    _id: false,
  })
  publicProfile: PublicProfile;

  @Prop({ type: String, select: false })
  pinHash?: string;

  @Prop({ type: Boolean, default: false })
  posEnabled: boolean;

  @Prop({ type: Date })
  lastClockIn?: Date;

  @Prop({ type: Number, default: 0, select: false })
  pinAttempts: number;

  @Prop({ type: Date, select: false })
  pinLockedUntil?: Date;
}

export const StaffSchema = SchemaFactory.createForClass(Staff);
StaffSchema.index({ salonId: 1, role: 1 });
// email unique PAR salon — sparse pour tolérer les membres sans email.
StaffSchema.index({ salonId: 1, email: 1 }, { unique: true, sparse: true });
// userId unique globalement — un seul profil staff par identité.
StaffSchema.index({ userId: 1 }, { unique: true });
