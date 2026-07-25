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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  UpdateExpoPushTokenDto,
  UpdateMeDto,
} from './dto/auth.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { getSalonScope } from '../common/scope/salon-scope';

const COOKIE_NAME = 'access_token';

@ApiTags('Auth')
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

  @ApiOperation({ summary: 'Sign in with email/phone + password (client or staff)' })
  @ApiResponse({ status: 201, description: 'Signed in successfully; sets the access_token cookie.' })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.login(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Signed in successfully.' };
  }

  @ApiOperation({ summary: 'Sign in to the POS kiosk with a staff PIN' })
  @ApiResponse({ status: 201, description: 'Signed in to POS.' })
  @Post('login-pin')
  async loginPin(
    @Body() dto: LoginPinDto,
  ): Promise<{ data: { token: string; staff: { id: string; name: string; first: string; color: string } }; message: string }> {
    const data = await this.auth.loginPin(dto);
    return { data, message: 'Signed in to POS.' };
  }

  @ApiOperation({ summary: 'Register a new client account' })
  @ApiResponse({ status: 201, description: 'Account created successfully; sets the access_token cookie.' })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.register(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Account created successfully.' };
  }

  @ApiOperation({ summary: 'Register a new client account (alias route used by the booking flow)' })
  @ApiResponse({ status: 201, description: 'Account created successfully; sets the access_token cookie.' })
  @Post('register/client')
  async registerClient(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { token: string; user: PublicUser }; message: string }> {
    const result = await this.auth.register(dto);
    this.setAuthCookie(res, result.token);
    return { data: result, message: 'Account created successfully.' };
  }

  @ApiOperation({ summary: 'Create a staff account for the current salon (owner only)' })
  @ApiResponse({ status: 201, description: 'Staff account created.' })
  @ApiBearerAuth()
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

  @ApiOperation({ summary: 'Request a password reset link/code for an account' })
  @ApiResponse({ status: 201, description: 'If the account exists, a reset link has been sent.' })
  @Post('password-reset/request')
  async requestReset(
    @Body() dto: PasswordResetRequestDto,
  ): Promise<{ data: { sent: boolean }; message: string }> {
    const data = await this.auth.requestPasswordReset(dto);
    return { data, message: 'If the account exists, a reset link has been sent.' };
  }

  @ApiOperation({ summary: 'Confirm a password reset using the emailed token' })
  @ApiResponse({ status: 201, description: 'Password updated. You can now sign in.' })
  @Post('password-reset/confirm')
  async confirmReset(
    @Body() dto: PasswordResetConfirmDto,
  ): Promise<{ data: { reset: boolean }; message: string }> {
    const data = await this.auth.confirmPasswordReset(dto);
    return { data, message: 'Password updated. You can now sign in.' };
  }

  @ApiOperation({ summary: 'Get the currently authenticated user/staff profile' })
  @ApiResponse({ status: 200, description: 'Current account profile.' })
  @ApiBearerAuth()
  @Get('me')
  @UseGuards(JwtGuard)
  async me(@CurrentUser() user: AuthUser): Promise<{ data: PublicUser; message: string }> {
    const data = await this.auth.me(user);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Update the currently authenticated user/staff profile' })
  @ApiResponse({ status: 200, description: 'Profile updated.' })
  @ApiBearerAuth()
  @Patch('me')
  @UseGuards(JwtGuard)
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMeDto,
  ): Promise<{ data: PublicUser; message: string }> {
    const data = await this.auth.updateMe(user, dto);
    return { data, message: 'Profile updated.' };
  }

  @ApiOperation({ summary: "Change the currently authenticated user's password" })
  @ApiResponse({ status: 200, description: 'Mot de passe mis à jour.' })
  @ApiBearerAuth()
  @Patch('me/password')
  @UseGuards(JwtGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ data: { ok: boolean }; message: string }> {
    await this.auth.changePassword(user, dto);
    return { data: { ok: true }, message: 'Mot de passe mis à jour.' };
  }

  @ApiOperation({ summary: "Deactivate the currently authenticated user's account" })
  @ApiResponse({ status: 200, description: 'Account deactivated.' })
  @ApiBearerAuth()
  @Patch('me/deactivate')
  @UseGuards(JwtGuard)
  async deactivateMe(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { ok: boolean }; message: string }> {
    await this.auth.deactivateMe(user);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { data: { ok: true }, message: 'Account deactivated.' };
  }

  @ApiOperation({ summary: "Store or clear the current user's Expo push token" })
  @ApiResponse({ status: 200, description: 'Push token updated.' })
  @ApiBearerAuth()
  @Patch('me/push-token')
  @UseGuards(JwtGuard)
  async updatePushToken(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateExpoPushTokenDto,
  ): Promise<{ data: { ok: boolean }; message: string }> {
    await this.auth.updateExpoPushToken(user, dto.expoPushToken);
    return { data: { ok: true }, message: 'Push token updated.' };
  }

  @ApiOperation({ summary: 'Sign out and clear the access_token cookie' })
  @ApiResponse({ status: 201, description: 'Signed out.' })
  @ApiBearerAuth()
  @Post('logout')
  @UseGuards(JwtGuard)
  logout(@Res({ passthrough: true }) res: Response): { data: { ok: boolean }; message: string } {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { data: { ok: true }, message: 'Signed out.' };
  }
}
