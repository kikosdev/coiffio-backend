import { Controller, Get, Patch, Delete, Param, Query, UseGuards, Request } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';

interface AuthRequest {
  user: { sub: string };
}

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  findMine(@Request() req: AuthRequest, @Query('page') page?: string) {
    return this.svc.findMine(req.user.sub, page ? parseInt(page) : 0);
  }

  @Get('unread-count')
  unreadCount(@Request() req: AuthRequest) {
    return this.svc.unreadCount(req.user.sub).then(count => ({ count }));
  }

  @Patch('read-all')
  markAllRead(@Request() req: AuthRequest) {
    return this.svc.markAllRead(req.user.sub);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.svc.markRead(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
