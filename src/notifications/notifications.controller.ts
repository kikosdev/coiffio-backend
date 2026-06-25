import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { NotificationsService } from './notifications.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('notifications')
@UseGuards(JwtGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.notifications.list(getSalonScope(req), user);
    return { data, message: 'OK' };
  }

  @Post(':id/read')
  async read(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.notifications.markRead(getSalonScope(req), user, id);
    return { data, message: 'Marked read.' };
  }

  @Post('read-all')
  async readAll(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.notifications.readAll(getSalonScope(req), user);
    return { data, message: 'All read.' };
  }
}
