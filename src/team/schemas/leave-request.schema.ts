import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LeaveRequestDocument = LeaveRequest & Document;

export type LeaveType = 'leave' | 'swap';
export type LeaveStatus = 'pending' | 'approved' | 'rejected';

/** Plage de congé (dates inclusives, format 'YYYY-MM-DD'). */
export interface LeaveRange {
  from: string;
  to: string;
}

/** Conflit gelé au moment de la tentative d'approbation (#6) : un booking qui bloque le congé. */
export interface LeaveConflict {
  appointmentId: string;
  start: Date;
  end: Date;
  clientId: string;
}

/**
 * Demande de congé / échange de shift (constitution + SKILL_team_schedule).
 * Décision #6 : à l'approbation, si des bookings existent dans la plage → BLOCK 409
 * avec liste de conflits, jamais d'auto-résolution. Le manager doit réassigner/annuler
 * d'abord. L'override 'leave' n'est écrit dans le Schedule qu'après approbation sans conflit.
 */
@Schema({ timestamps: true })
export class LeaveRequest {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true, index: true })
  stylistId: Types.ObjectId;

  // Pour un swap : le stylist cible proposé (optionnel).
  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  swapWithId?: Types.ObjectId;

  @Prop({ type: String, enum: ['leave', 'swap'], default: 'leave' })
  type: LeaveType;

  @Prop({
    type: { from: { type: String, required: true }, to: { type: String, required: true } },
    required: true,
    _id: false,
  })
  range: LeaveRange;

  @Prop({ type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true })
  status: LeaveStatus;

  @Prop({
    type: [
      {
        appointmentId: { type: String, required: true },
        start: { type: Date, required: true },
        end: { type: Date, required: true },
        clientId: { type: String, default: '' },
      },
    ],
    default: [],
  })
  conflicts: LeaveConflict[];

  @Prop({ default: '' })
  note: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  decidedBy?: Types.ObjectId;

  @Prop()
  decidedAt?: Date;
}

export const LeaveRequestSchema = SchemaFactory.createForClass(LeaveRequest);
LeaveRequestSchema.index({ salonId: 1, status: 1, stylistId: 1 });
