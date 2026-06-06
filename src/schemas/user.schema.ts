import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

export enum UserRole {
  OWNER      = 'owner',
  SUPERVISOR = 'supervisor',
  STAFF      = 'staff',
  CLIENT     = 'client',
}

export enum StaffJob {
  STYLIST       = 'stylist',
  COLORIST      = 'colorist',
  ASSISTANT     = 'assistant',
  RECEPTIONIST  = 'receptionist',
}

export enum LoyaltyTier {
  INITIEE = 'initiee',
  MAISON  = 'maison',
  MAITRE  = 'maitre',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ required: true, unique: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ type: String, enum: UserRole, required: true, default: UserRole.CLIENT })
  role: UserRole;

  @Prop({ type: String, enum: StaffJob })
  job?: StaffJob;

  @Prop({ type: Types.ObjectId, ref: 'Stylist' })
  staffId?: Types.ObjectId;

  @Prop({ type: String, enum: LoyaltyTier, default: LoyaltyTier.INITIEE })
  loyaltyTier: LoyaltyTier;

  @Prop({ default: 0 })
  loyaltyPoints: number;

  @Prop({ default: 0 })
  totalSpent: number;

  @Prop({ default: 0 })
  totalVisits: number;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
