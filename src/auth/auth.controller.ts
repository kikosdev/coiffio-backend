import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService, PublicUser } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterDto,
  UpdateMeDto,
} from './dto/auth.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const COOKIE_NAME = 'access_token';

/** Toutes les routes renvoient l'enveloppe { data, message, statusCode } (convention #1). */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setAuthCookie(res: Response, token: string): void {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 jours
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

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.register(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Account created successfully.' };
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
