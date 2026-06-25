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
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { AuthUser, Role } from '../common/decorators/current-user.decorator';
import {
  ChangePasswordDto,
  LoginDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterDto,
  UpdateMeDto,
} from './dto/auth.dto';

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL = '1h';
const RESET_PURPOSE = 'pwd_reset';

/** Vue publique — jamais le passwordHash. */
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
}

interface ResetPayload {
  sub: string;
  purpose: string;
  accountType: 'staff' | 'client';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    private readonly jwt: JwtService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────

  private toPublicFromStaff(staff: StaffDocument): PublicUser {
    return {
      id: staff._id.toString(),
      salonId: staff.salonId.toString(),
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role as Role,
      color: staff.color,
      isActive: staff.isActive,
      registered: true,
      accountType: 'staff',
    };
  }

  private toPublicFromUser(user: UserDocument): PublicUser {
    return {
      id: user._id.toString(),
      salonId: user.salonId.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role as Role,
      isActive: user.isActive,
      registered: user.registered,
      accountType: 'client',
    };
  }

  private signTokenForStaff(staff: StaffDocument): string {
    const payload: AuthUser = {
      sub: staff._id.toString(),
      salonId: staff.salonId.toString(),
      role: staff.role as Role,
      name: staff.name,
      email: staff.email,
      accountType: 'staff',
    };
    return this.jwt.sign(payload);
  }

  private signTokenForUser(user: UserDocument): string {
    const payload: AuthUser = {
      sub: user._id.toString(),
      salonId: user.salonId.toString(),
      role: user.role as Role,
      name: user.name,
      email: user.email,
      phone: user.phone,
      accountType: 'client',
    };
    return this.jwt.sign(payload);
  }

  /** Résout le salonId pour une requête publique (register). */
  private async resolveSalonId(): Promise<Types.ObjectId> {
    const fromEnv = process.env.DEFAULT_SALON_ID;
    if (fromEnv && Types.ObjectId.isValid(fromEnv)) return new Types.ObjectId(fromEnv);
    const salon = await this.salonModel.findOne().sort({ createdAt: 1 });
    if (!salon) {
      throw new BadRequestException('No salon configured. Run the seed first.');
    }
    return salon._id as Types.ObjectId;
  }

  // ─── Endpoints ──────────────────────────────────────────────────────────

  /**
   * Login unifié : cherche dans Staff d'abord (staff login), puis dans User (client login).
   */
  async login(dto: LoginDto): Promise<{ token: string; user: PublicUser }> {
    const email = dto.email.toLowerCase();

    // Check Staff collection first.
    const staff = await this.staffModel.findOne({ email });
    if (staff) {
      if (!staff.isActive) throw new UnauthorizedException('This account is disabled.');
      if (!staff.passwordHash) throw new UnauthorizedException('Invalid email or password.');
      const ok = await bcrypt.compare(dto.password, staff.passwordHash);
      if (!ok) throw new UnauthorizedException('Invalid email or password.');
      return { token: this.signTokenForStaff(staff), user: this.toPublicFromStaff(staff) };
    }

    // Fall back to User (client) collection.
    const user = await this.userModel.findOne({ email });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    if (!user.isActive) throw new UnauthorizedException('This account is disabled.');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid email or password.');
    return { token: this.signTokenForUser(user), user: this.toPublicFromUser(user) };
  }

  /**
   * Register : crée un client uniquement. Merge-on-phone (Décision #10).
   */
  async register(dto: RegisterDto): Promise<{ token: string; user: PublicUser }> {
    const email = dto.email.toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Staff cannot self-register via this endpoint.
    const staffConflict = await this.staffModel.findOne({ email });
    if (staffConflict) {
      throw new ConflictException('An account with this email already exists.');
    }

    // Collision email sur un compte déjà registered.
    const byEmail = await this.userModel.findOne({ email });
    if (byEmail && byEmail.passwordHash) {
      throw new ConflictException('An account with this email already exists.');
    }

    // Merge-on-phone : guest existant → on l'enrichit.
    const byPhone = await this.userModel.findOne({ phone: dto.phone });
    if (byPhone) {
      if (byPhone.passwordHash) {
        throw new ConflictException('An account with this phone already exists.');
      }
      byPhone.name = dto.name;
      byPhone.email = email;
      byPhone.passwordHash = passwordHash;
      byPhone.registered = true;
      byPhone.role = 'client';
      await byPhone.save();
      return { token: this.signTokenForUser(byPhone), user: this.toPublicFromUser(byPhone) };
    }

    const salonId = await this.resolveSalonId();
    const created = await this.userModel.create({
      salonId,
      name: dto.name,
      email,
      phone: dto.phone,
      passwordHash,
      role: 'client',
      isActive: true,
      registered: true,
    });
    return { token: this.signTokenForUser(created), user: this.toPublicFromUser(created) };
  }

  async requestPasswordReset(dto: PasswordResetRequestDto): Promise<{ sent: boolean }> {
    const email = dto.email.toLowerCase();

    // Check Staff first.
    const staff = await this.staffModel.findOne({ email });
    if (staff && staff.passwordHash) {
      const payload: ResetPayload = { sub: staff._id.toString(), purpose: RESET_PURPOSE, accountType: 'staff' };
      const token = this.jwt.sign(payload, { expiresIn: RESET_TOKEN_TTL });
      const link = `${process.env.FRONTEND_ORIGIN ?? ''}/reset-password?token=${token}`;
      this.logger.log(`[password-reset] staff email to ${staff.email} → ${link}`);
      return { sent: true };
    }

    const user = await this.userModel.findOne({ email });
    if (user && user.passwordHash) {
      const payload: ResetPayload = { sub: user._id.toString(), purpose: RESET_PURPOSE, accountType: 'client' };
      const token = this.jwt.sign(payload, { expiresIn: RESET_TOKEN_TTL });
      const link = `${process.env.FRONTEND_ORIGIN ?? ''}/reset-password?token=${token}`;
      this.logger.log(`[password-reset] client email to ${user.email} → ${link}`);
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
    if (payload.purpose !== RESET_PURPOSE) {
      throw new BadRequestException('Invalid reset token.');
    }
    const newHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    if (payload.accountType === 'staff') {
      const staff = await this.staffModel.findById(payload.sub);
      if (!staff) throw new BadRequestException('Invalid reset token.');
      staff.passwordHash = newHash;
      await staff.save();
    } else {
      const user = await this.userModel.findById(payload.sub);
      if (!user) throw new BadRequestException('Invalid reset token.');
      user.passwordHash = newHash;
      user.registered = true;
      await user.save();
    }

    return { reset: true };
  }

  async me(auth: AuthUser): Promise<PublicUser> {
    if (auth.accountType === 'staff') {
      const staff = await this.staffModel.findById(auth.sub);
      if (!staff) throw new UnauthorizedException('Account not found.');
      return this.toPublicFromStaff(staff);
    }
    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    return this.toPublicFromUser(user);
  }

  async updateMe(auth: AuthUser, dto: UpdateMeDto): Promise<PublicUser> {
    if (auth.accountType === 'staff') {
      const staff = await this.staffModel.findById(auth.sub);
      if (!staff) throw new UnauthorizedException('Account not found.');
      if (dto.email && dto.email.toLowerCase() !== staff.email) {
        const taken = await this.staffModel.findOne({ email: dto.email.toLowerCase() });
        if (taken && taken._id.toString() !== staff._id.toString()) {
          throw new ConflictException('This email is already in use.');
        }
        staff.email = dto.email.toLowerCase();
      }
      if (dto.name !== undefined) staff.name = dto.name;
      if (dto.phone !== undefined) staff.phone = dto.phone;
      await staff.save();
      return this.toPublicFromStaff(staff);
    }

    const user = await this.userModel.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Account not found.');
    if (dto.email && dto.email.toLowerCase() !== user.email) {
      const taken = await this.userModel.findOne({ email: dto.email.toLowerCase() });
      if (taken && taken._id.toString() !== user._id.toString()) {
        throw new ConflictException('This email is already in use.');
      }
      user.email = dto.email.toLowerCase();
    }
    if (dto.name !== undefined) user.name = dto.name;
    if (dto.phone !== undefined) user.phone = dto.phone;
    await user.save();
    return this.toPublicFromUser(user);
  }

  async changePassword(auth: AuthUser, dto: ChangePasswordDto): Promise<void> {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('Le nouveau mot de passe doit être différent de l\'actuel.');
    }

    if (auth.accountType === 'staff') {
      const staff = await this.staffModel.findById(auth.sub);
      if (!staff || !staff.passwordHash) throw new UnauthorizedException('Account not found.');
      const ok = await bcrypt.compare(dto.currentPassword, staff.passwordHash);
      if (!ok) throw new UnauthorizedException('Mot de passe actuel incorrect.');
      staff.passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
      await staff.save();
    } else {
      const user = await this.userModel.findById(auth.sub);
      if (!user || !user.passwordHash) throw new UnauthorizedException('Account not found.');
      const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
      if (!ok) throw new UnauthorizedException('Mot de passe actuel incorrect.');
      user.passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
      await user.save();
    }
  }
}
