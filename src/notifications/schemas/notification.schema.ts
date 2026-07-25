import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId; // identity recipient (users._id)

  @Prop({ type: Types.ObjectId, ref: 'Staff', index: true })
  staffId?: Types.ObjectId; // staff profile recipient (staffs._id)

  @Prop({ index: true })
  role?: string; // ou diffusion à un rôle (ex. owner)

  @Prop({ required: true })
  type: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ default: false, index: true })
  read: boolean;

  @Prop({ required: true, index: true })
  date: Date;

  // ── Shared-terminal broadcasts (SKILL_fix_pos_board_notifs_FINAL) ──────────
  // groupId = dedup key (1 booking = 1 notif, even if it spans several appointment
  // rows). title/body are precomputed human text so GET /pos/notifications doesn't
  // need to re-populate client/service names on every read.
  @Prop()
  groupId?: string;

  @Prop()
  title?: string;

  @Prop()
  body?: string;

  // Readers who've acknowledged this notif (POS terminals share one feed — a
  // singular `read` boolean can't represent "seen at this terminal, not at that one").
  @Prop({ type: [String], default: [] })
  readBy: string[];
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ salonId: 1, userId: 1, read: 1 });
NotificationSchema.index({ salonId: 1, staffId: 1, read: 1 });
NotificationSchema.index({ salonId: 1, role: 1, read: 1 });
// Makes duplicate broadcasts for the same booking impossible at the DB level, not
// just best-effort in application code.
NotificationSchema.index(
  { salonId: 1, type: 1, groupId: 1 },
  { unique: true, partialFilterExpression: { groupId: { $exists: true } } },
);
