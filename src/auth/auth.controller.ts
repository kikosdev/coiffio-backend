import { Controller, Post, Get, Patch, Body, Param, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { UserRole, StaffJob } from '../schemas/user.schema';
import { JwtPayload } from './jwt.strategy';

interface AuthRequest {
  user: JwtPayload;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() body: { firstName: string; lastName: string; email: string; password: string; phone?: string }) {
    return this.authService.registerClient(body);
  }

  @Post('register/client')
  registerClient(@Body() body: { firstName: string; lastName: string; email: string; password: string; phone?: string }) {
    return this.authService.registerClient(body);
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body.email, body.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: AuthRequest) {
    return this.authService.getMe(req.user.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Post('staff')
  createStaff(
    @Body() body: {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
      phone?: string;
      job?: StaffJob;
      staffId?: string;
    },
  ) {
    return this.authService.createStaff(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @Patch('users/:id/role')
  updateRole(
    @Param('id') id: string,
    @Body() body: { role: UserRole },
    @Request() req: AuthRequest,
  ) {
    return this.authService.updateRole(id, body.role, req.user.role);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Patch('users/:id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.authService.deactivate(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(
    @Request() req: AuthRequest,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(req.user.sub, body.currentPassword, body.newPassword);
  }
}
