import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiOperation({ summary: 'List notifications for the current user' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const data = await this.notifications.list(user);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiResponse({ status: 201, description: 'Marked read.' })
  @Post(':id/read')
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.notifications.markRead(user, id);
    return { data, message: 'Marked read.' };
  }

  @ApiOperation({ summary: 'Mark all notifications as read for the current user' })
  @ApiResponse({ status: 201, description: 'All read.' })
  @Post('read-all')
  async readAll(@CurrentUser() user: AuthUser) {
    const data = await this.notifications.readAll(user);
    return { data, message: 'All read.' };
  }
}
