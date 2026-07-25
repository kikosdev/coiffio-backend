import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from './schemas/user.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { AuthUser, Role } from '../common/decorators/current-user.decorator';
import { normalizeIdentifier } from './identifier.util';
import {
  ChangePasswordDto,
  CreateStaffAuthDto,
  LoginDto,
  LoginPinDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  PosTokenPayload,
  RegisterDto,
  UpdateMeDto,
} from './dto/auth.dto';

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL = '1h';
const RESET_PURPOSE = 'pwd_reset';

export interface PublicUser {
  id: string;
  salonId: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  color?: string;
  isActive: boolean;
  registered: boolean;
  accountType: 'staff' | 'client';
  staffId?: string;
  clientId?: string;
}

interface ResetPayload {
  sub: string;
  purpose: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name)         private readonly userModel:     Model<UserDocument>,
    @InjectModel(Staff.name)        private readonly staffModel:    Model<StaffDocument>,
    @InjectModel(Schedule.name)     private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel:  Model<StaffProfileDocument>,
    @InjectModel(Client.name)       private readonly clientModel:   Model<ClientDocument>,
    @InjectModel(Salon.name)        private readonly salonModel:    Model<SalonDocument>,
    private readonly jwt: JwtService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private toPublicFromStaff(user: UserDocument, staff: StaffDocument): PublicUser {
    return {
      id:          user._id.toString(),
      salonId:     staff.salonId.toString(),
      name:        staff.name,
      email:       staff.email ?? '',
      phone:       staff.phone ?? '',
      role:        staff.role as Role,
      color:       staff.color,
      isActive:    user.isActive,
      registered:  true,
      accountType: 'staff',
      staffId:     staff._id.toString(),
    };
  }

  private toPublicFromClient(user: UserDocument, client: ClientDocument): PublicUser {
    return {
      id:          user._id.toString(),
      salonId:     client.salonId.toString(),
      name:        client.name,
      email:       client.email ?? '',
      phone:       client.phone,
      role:        'client',
      isActive:    user.isActive,
      registered:  true,
      accountType: 'client',
      clientId:    client._id.toString(),
    };
  }

  private issueToken(
    user: UserDocument,
    profile: { staff?: StaffDocument; client?: ClientDocument },
  ): string {
    const salonId = profile.staff?.salonId.toString() ?? profile.client?.salonId.toString() ?? '';
    const role = (profile.staff?.role ?? user.role) as Role;
    const payload: AuthUser = {
      sub:         user._id.toString(),
      salonId,
      role,
      name:        profile.staff?.name ?? profile.client?.name ?? '',
      email:       profile.staff?.email ?? profile.client?.email ?? '',
      phone:       profile.staff?.phone ?? profile.client?.phone ?? '',
      accountType: user.role === 'client' ? 'client' : 'staff',
      staffId:     profile.staff?._id.toString(),
      clientId:    profile.client?._id.toString(),
    };
    return this.jwt.sign(payload);
  }

  private async resolveSalonId(): Promise<Types.ObjectId> {
    const fromEnv = process.env.DEFAULT_SALON_ID;
    if (fromEnv && Types.ObjectId.isValid(fromEnv)) return new Types.ObjectId(fromEnv);
    const salon = await this.salonModel.findOne().sort({ createdAt: 1 });
    if (!salon) throw new BadRequestException('No salon configured. Run the seed first.');
    return salon._id as Types.ObjectId;
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async login(dto: LoginDto): Promise<{ token: string; user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);
    const user = await this.userModel.findOne({ identifier: id.value });
    if (!user) throw new UnauthorizedException('Identifiants invalides.');
    if (!user.isActive) throw new UnauthorizedException('This account is disabled.');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Identifiants invalides.');

    await this.userModel.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

    if (user.role === 'client') {
      const client = await this.clientModel.findOne({ userId: user._id });
      if (!client) throw new UnauthorizedException('Client profile not found.');
      return { token: this.issueToken(user, { client }), user: this.toPublicFromClient(user, client) };
    }

    const staff = await this.staffModel.findOne({ userId: user._id });
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    return { token: this.issueToken(user, { staff }), user: this.toPublicFromStaff(user, staff) };
  }

  // ─── PIN login (kiosk / POS scope) ──────────────────────────────────────────

  async loginPin(dto: LoginPinDto): Promise<{
    token: string;
    staff: { id: string; name: string; first: string; color: string };
  }> {
    const staff = await this.staffModel
      .findById(dto.staffId)
      .select('+pinHash +pinAttempts +pinLockedUntil')
      .lean();

    if (!staff || !staff.isActive || !staff.posEnabled) {
      throw new UnauthorizedException('Staff not found or not POS-enabled.');
    }

    const now = new Date();
    if (staff.pinLockedUntil && staff.pinLockedUntil > now) {
      const secondsLeft = Math.ceil((staff.pinLockedUntil.getTime() - now.getTime()) / 1000);
      throw new UnauthorizedException(`Too many attempts. Try again in ${secondsLeft}s.`);
    }

    if (!staff.pinHash) {
      throw new UnauthorizedException('PIN not configured. Contact your manager.');
    }

    const ok = await bcrypt.compare(dto.pin, staff.pinHash);

    if (!ok) {
      const newAttempts = (staff.pinAttempts ?? 0) + 1;
      const update: Record<string, unknown> = { pinAttempts: newAttempts };
      if (newAttempts >= 5) {
        update.pinLockedUntil = new Date(now.getTime() + 30_000);
        update.pinAttempts = 0;
      }
      await this.staffModel.updateOne({ _id: staff._id }, { $set: update });
      throw new UnauthorizedException('Wrong PIN.');
    }

    await this.staffModel.updateOne(
      { _id: staff._id },
      { $set: { pinAttempts: 0 }, $unset: { pinLockedUntil: '' } },
    );

    const salonId = staff.salonId.toString();
    const payload: PosTokenPayload = { staffId: staff._id.toString(), salonId, scope: 'pos' };
    const token = this.jwt.sign(payload, { expiresIn: '12h' });

    return {
      token,
      staff: {
        id:    staff._id.toString(),
        name:  staff.name,
        first: staff.name.split(' ')[0],
        color: staff.color ?? '#B89968',
      },
    };
  }

  // ─── Register client (public, self-service) ──────────────────────────────────

  async register(dto: RegisterDto): Promise<{ token: string; user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);
    const phone = normalizeIdentifier(dto.phone).value;
    const salonId = await this.resolveSalonId();

    const existing = await this.userModel.findOne({ identifier: id.value });
    if (existing) throw new ConflictException('An account with this identifier already exists.');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.userModel.create({
      identifier: id.value,
      identifierType: id.type,
      passwordHash,
      role: 'client',
      isActive: true,
    });

    let client = await this.clientModel.findOne({ salonId, phone });
    if (client) {
      client.userId = user._id as Types.ObjectId;
      if (dto.email && !client.email) client.email = dto.email.toLowerCase();
      await client.save();
    } else {
      client = await this.clientModel.create({
        salonId,
        userId: user._id,
        name: dto.name,
        phone,
        email: dto.email?.toLowerCase() ?? '',
      });
    }

    return { token: this.issueToken(user, { client }), user: this.toPublicFromClient(user, client) };
  }

  // ─── Create staff (OWNER only) ───────────────────────────────────────────────

  async createStaff(salonId: string, dto: CreateStaffAuthDto): Promise<{ user: PublicUser }> {
    const id = normalizeIdentifier(dto.identifier);
    const salonObjId = new Types.ObjectId(salonId);

    const existing = await this.userModel.findOne({ identifier: id.value });
    if (existing) throw new ConflictException('An account with this identifier already exists.');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const userDoc = await this.userModel.create({
      identifier: id.value,
      identifierType: id.type,
      passwordHash,
      role: 'staff',
      isActive: true,
    });

    const staff = await this.staffModel.create({
      salonId: salonObjId,
      userId: userDoc._id,
      name: dto.name,
      email: dto.email?.toLowerCase().trim() ?? '',
      phone: dto.phone ?? '',
      role: dto.role,
      color: dto.color ?? '#B89968',
      isActive: true,
      week: [],
    });

    await this.scheduleModel.updateOne(
      { salonId: salonObjId, stylistId: staff._id },
      { $setOnInsert: { weekly: [], overrides: [] } },
      { upsert: true },
    );

    if (['stylist', 'colorist'].includes(dto.role) || dto.level || dto.capabilities || dto.baseRate != null || dto.commissionPct != null) {
      await this.profileModel.create({
        salonId: salonObjId,
        userId: staff._id,
        level: dto.level ?? 'senior',
        capabilities: dto.capabilities ?? [],
        baseRate: dto.baseRate ?? 0,
        commissionPct: dto.commissionPct ?? 0,
      });
    }

    return { user: this.toPublicFromStaff(userDoc, staff) };
  }

  // ─── Me ─────────────────────────────────────────────────────────────────────

  async me(auth: AuthUser): Promise<PublicUser> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');

    if (user.role === 'client') {
      const client = await this.clientModel.findById(auth.clientId);
      if (!client) throw new UnauthorizedException('Client profile not found.');
      return this.toPublicFromClient(user, client);
    }

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    return this.toPublicFromStaff(user, staff);
  }

  async updateMe(auth: AuthUser, dto: UpdateMeDto): Promise<PublicUser> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');

    if (user.role === 'client') {
      const client = await this.clientModel.findById(auth.clientId);
      if (!client) throw new UnauthorizedException('Client profile not found.');
      if (dto.name !== undefined) client.name = dto.name;
      if (dto.email !== undefined) client.email = dto.email.toLowerCase();
      await client.save();
      return this.toPublicFromClient(user, client);
    }

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');
    if (dto.name !== undefined) staff.name = dto.name;
    if (dto.email !== undefined) {
      const taken = await this.staffModel.findOne({
        salonId: staff.salonId,
        email: dto.email.toLowerCase(),
        _id: { $ne: staff._id },
      });
      if (taken) throw new ConflictException('This email is already in use.');
      staff.email = dto.email.toLowerCase();
    }
    if (dto.phone !== undefined) staff.phone = dto.phone;
    await staff.save();
    return this.toPublicFromStaff(user, staff);
  }

  // ─── Password ────────────────────────────────────────────────────────────────

  async changePassword(auth: AuthUser, dto: ChangePasswordDto): Promise<void> {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException("Le nouveau mot de passe doit être différent de l'actuel.");
    }
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Mot de passe actuel incorrect.');
    user.passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await user.save();
  }

  async deactivateMe(auth: AuthUser): Promise<void> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');

    if (user.role === 'client') {
      user.isActive = false;
      await user.save();
      return;
    }

    const staff = await this.staffModel.findById(auth.staffId);
    if (!staff) throw new UnauthorizedException('Staff profile not found.');

    if (staff.role === 'owner') {
      const activeOwners = await this.staffModel.countDocuments({
        salonId: staff.salonId,
        role: 'owner',
        isActive: true,
        _id: { $ne: staff._id },
      });
      if (activeOwners === 0) {
        throw new BadRequestException('Cannot deactivate the sole owner. Transfer ownership first.');
      }
    }

    user.isActive = false;
    staff.isActive = false;
    staff.acceptingBookings = false;
    await Promise.all([user.save(), staff.save()]);
  }

  async updateExpoPushToken(auth: AuthUser, expoPushToken?: string | null): Promise<void> {
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    if (expoPushToken) user.expoPushToken = expoPushToken;
    else user.expoPushToken = undefined;
    await user.save();
  }

  async requestPasswordReset(dto: PasswordResetRequestDto): Promise<{ sent: boolean }> {
    const id = normalizeIdentifier(dto.identifier);
    const user = await this.userModel.findOne({ identifier: id.value, isActive: true });
    if (user) {
      const payload: ResetPayload = { sub: user._id.toString(), purpose: RESET_PURPOSE };
      const token = this.jwt.sign(payload, { expiresIn: RESET_TOKEN_TTL });
      const link = `${process.env.FRONTEND_ORIGIN ?? ''}/reset-password?token=${token}`;
      this.logger.log(`[password-reset] ${user.role} ${id.value} → ${link}`);
    }
    return { sent: true };
  }

  async confirmPasswordReset(dto: PasswordResetConfirmDto): Promise<{ reset: boolean }> {
    let payload: ResetPayload;
    try {
      payload = this.jwt.verify<ResetPayload>(dto.token);
    } catch {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    if (payload.purpose !== RESET_PURPOSE) throw new BadRequestException('Invalid reset token.');

    const user = await this.userModel.findById(payload.sub);
    if (!user) throw new BadRequestException('Invalid reset token.');
    user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await user.save();
    return { reset: true };
  }
}
