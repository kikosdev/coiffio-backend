import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService, PublicUser } from './auth.service';
import {
  ChangePasswordDto,
  CreateStaffAuthDto,
  LoginDto,
  LoginPinDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterDto,
  UpdateMeDto,
} from './dto/auth.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { getSalonScope } from '../common/scope/salon-scope';

const COOKIE_NAME = 'access_token';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setAuthCookie(res: Response, token: string): void {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 7,
      path: '/',
    });
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.login(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Signed in successfully.' };
  }

  @Post('login-pin')
  async loginPin(
    @Body() dto: LoginPinDto,
  ): Promise<{ data: { token: string; staff: { id: string; name: string; first: string; color: string } }; message: string }> {
    const data = await this.auth.loginPin(dto);
    return { data, message: 'Signed in to POS.' };
  }

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.register(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Account created successfully.' };
  }

  @Post('register/client')
  async registerClient(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.register(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Account created successfully.' };
  }

  @Post('staff')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner')
  async createStaff(
    @Req() req: Request,
    @Body() dto: CreateStaffAuthDto,
  ): Promise<{ data: { user: PublicUser }; message: string }> {
    const { salonId } = getSalonScope(req);
    const data = await this.auth.createStaff(salonId, dto);
    return { data, message: 'Staff account created.' };
  }

  @Post('password-reset/request')
  async requestReset(
    @Body() dto: PasswordResetRequestDto,
  ): Promise<{ data: { sent: boolean }; message: string }> {
    const data = await this.auth.requestPasswordReset(dto);
    return { data, message: 'If the account exists, a reset link has been sent.' };
  }

  @Post('password-reset/confirm')
  async confirmReset(
    @Body() dto: PasswordResetConfirmDto,
  ): Promise<{ data: { reset: boolean }; message: string }> {
    const data = await this.auth.confirmPasswordReset(dto);
    return { data, message: 'Password updated. You can now sign in.' };
  }

  @Get('me')
  @UseGuards(JwtGuard)
  async me(@CurrentUser() user: AuthUser): Promise<{ data: PublicUser; message: string }> {
    const data = await this.auth.me(user);
    return { data, message: 'OK' };
  }

  @Patch('me')
  @UseGuards(JwtGuard)
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMeDto,
  ): Promise<{ data: PublicUser; message: string }> {
    const data = await this.auth.updateMe(user, dto);
    return { data, message: 'Profile updated.' };
  }

  @Patch('me/password')
  @UseGuards(JwtGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ data: { ok: boolean }; message: string }> {
    await this.auth.changePassword(user, dto);
    return { data: { ok: true }, message: 'Mot de passe mis à jour.' };
  }

  @Post('logout')
  @UseGuards(JwtGuard)
  logout(@Res({ passthrough: true }) res: Response): { data: { ok: boolean }; message: string } {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { data: { ok: true }, message: 'Signed out.' };
  }
}
