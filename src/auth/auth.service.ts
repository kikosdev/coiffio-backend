import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument, UserRole, StaffJob, LoyaltyTier } from '../schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  async registerClient(dto: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    phone?: string;
  }) {
    const exists = await this.userModel.findOne({ email: dto.email });
    if (exists) throw new ConflictException('Email already in use');

    const password = await bcrypt.hash(dto.password, 12);
    const user = await this.userModel.create({
      ...dto,
      password,
      role: UserRole.CLIENT,
      loyaltyTier: LoyaltyTier.INITIEE,
    });
    return this.signToken(user);
  }

  async createStaff(dto: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    phone?: string;
    job?: StaffJob;
    staffId?: string;
  }) {
    const exists = await this.userModel.findOne({ email: dto.email });
    if (exists) throw new ConflictException('Email already in use');

    const password = await bcrypt.hash(dto.password, 12);
    const user = await this.userModel.create({
      ...dto,
      password,
      role: UserRole.STAFF,
      staffId: dto.staffId ? new Types.ObjectId(dto.staffId) : undefined,
    });
    return this.signToken(user);
  }

  async login(email: string, password: string) {
    const user = await this.userModel.findOne({ email });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.signToken(user);
  }

  async getMe(userId: string) {
    const user = await this.userModel.findById(userId).select('-password');
    if (!user) throw new UnauthorizedException();
    return user;
  }

  async updateRole(id: string, role: UserRole, requestorRole: UserRole) {
    if (requestorRole !== UserRole.OWNER) throw new ForbiddenException();
    const user = await this.userModel.findByIdAndUpdate(id, { role }, { new: true }).select('-password');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async deactivate(id: string) {
    const user = await this.userModel.findByIdAndUpdate(id, { isActive: false }, { new: true }).select('-password');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException();

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    return { message: 'Password updated' };
  }

  private signToken(user: UserDocument) {
    const payload = {
      sub:     user._id.toString(),
      email:   user.email,
      role:    user.role,
      staffId: user.staffId?.toString(),
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id:            user._id,
        firstName:     user.firstName,
        lastName:      user.lastName,
        email:         user.email,
        role:          user.role,
        job:           user.job,
        staffId:       user.staffId,
        loyaltyTier:   user.loyaltyTier,
        loyaltyPoints: user.loyaltyPoints,
      },
    };
  }
}
