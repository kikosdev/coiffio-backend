import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type TeamMemberDocument = TeamMember & Document;

export enum MemberLevel {
  JUNIOR = 'Junior',
  SENIOR = 'Senior',
  MASTER = 'Master',
}

export enum MemberStatus {
  SHIFT = 'shift',
  BREAK = 'break',
  OFF = 'off',
  LEAVE = 'leave',
}

/**
 * week : 7 entrées (Lun→Dim). Chaque entrée est un "WeekDay" :
 *   null          → jour de repos (day off)
 *   'leave'       → congé annuel
 *   [start, end]  → shift (heures entières, ex. [9, 18])
 * Stocké en Mixed car le type varie par cellule.
 */
@Schema({ timestamps: true })
export class TeamMember {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  role: string;

  @Prop({ default: '' })
  dept: string;

  @Prop({ default: '' })
  initials: string;

  @Prop({ default: 'ph-3' })
  tone: string; // ph-2..ph-7 (dégradé portrait)

  @Prop({ type: String, enum: MemberLevel, default: MemberLevel.SENIOR })
  level: MemberLevel;

  @Prop({ type: String, enum: MemberStatus, default: MemberStatus.OFF })
  status: MemberStatus;

  @Prop({ default: new Date().getFullYear() })
  since: number; // année d'arrivée

  // Perfs (null si non applicable)
  @Prop({ type: Number, default: null })
  util: number | null;
  @Prop({ type: Number, default: null })
  rebook: number | null;
  @Prop({ type: Number, default: null })
  ticket: number | null;
  @Prop({ type: Number, default: null })
  retail: number | null;

  // Paie (€)
  @Prop({ default: 0 })
  base: number; // salaire fixe (période courante)
  @Prop({ default: 0 })
  commission: number;
  @Prop({ default: 0 })
  tip: number; // pourboires
  @Prop({ default: 0 })
  period: number; // cumul période

  @Prop({ type: [MongooseSchema.Types.Mixed], default: () => [null, null, null, null, null, null, null] })
  week: (number[] | 'leave' | null)[];

  @Prop({ default: true })
  isActive: boolean;
}

export const TeamMemberSchema = SchemaFactory.createForClass(TeamMember);
