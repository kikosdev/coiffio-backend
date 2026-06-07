import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LeaveRequestDocument = LeaveRequest & Document;

export enum LeaveType {
  ANNUAL = 'Annual leave',
  SWAP = 'Shift swap',
  LATE_START = 'Late start',
}

export enum LeaveDecision {
  PENDING = 'pending',
  APPROVED = 'ok',
  DECLINED = 'no',
}

@Schema({ timestamps: true })
export class LeaveRequest {
  @Prop({ required: true })
  who: string; // nom du membre

  @Prop({ default: '' })
  init: string; // initiales

  @Prop({ type: String, enum: LeaveType, default: LeaveType.ANNUAL })
  type: LeaveType;

  @Prop({ default: '' })
  range: string; // ex. "12–16 May"

  @Prop({ default: 0 })
  days: number;

  @Prop({ default: '' })
  sub: string; // sous-titre / motif

  @Prop({ type: String, enum: LeaveDecision, default: LeaveDecision.PENDING })
  decided: LeaveDecision;
}

export const LeaveRequestSchema = SchemaFactory.createForClass(LeaveRequest);
