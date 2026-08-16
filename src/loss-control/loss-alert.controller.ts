import { Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LossAlert, LossAlertDocument } from './schemas/loss-alert.schema';
import { ListLossAlertsQueryDto } from './dto/loss-alert.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/** LC-6/LC-10 (SKILL_loss_control_doses.md, Prompt 5) — owner-only. */
@ApiTags('Loss Control')
@ApiBearerAuth()
@Controller('loss-control/alerts')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner')
export class LossAlertController {
  constructor(@InjectModel(LossAlert.name) private readonly alertModel: Model<LossAlertDocument>) {}

  @ApiOperation({ summary: 'List loss control alerts, optionally filtered by read status and kind' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(@Query() query: ListLossAlertsQueryDto): Promise<{ data: LossAlertDocument[]; message: string }> {
    const filter: Record<string, unknown> = {};
    if (query.read !== undefined) filter.read = query.read === 'true';
    if (query.kind) filter.kind = query.kind;
    const data = await this.alertModel.find(filter).sort({ createdAt: -1 }).limit(200);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Mark a loss control alert as read' })
  @ApiResponse({ status: 200, description: 'Alert marked read.' })
  @Post(':id/read')
  async markRead(@Param('id') id: string): Promise<{ data: LossAlertDocument; message: string }> {
    const alert = await this.alertModel.findOne({ _id: id });
    if (!alert) throw new NotFoundException('Alert not found.');
    alert.read = true;
    await alert.save();
    return { data: alert, message: 'Alert marked read.' };
  }
}
