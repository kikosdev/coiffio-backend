import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DoseLogService, DoseLogList } from './dose-log.service';
import { DeclareDosesDto } from './dto/dose-log.dto';
import { DoseLogDocument } from './schemas/dose-log.schema';
import { PosScopeGuard, PosUser } from '../common/guards/pos-scope.guard';
import { CurrentPosUser } from '../common/decorators/current-pos-user.decorator';
import { FeatureGuard } from '../common/entitlements/guards/feature.guard';
import { RequiresFeature } from '../common/entitlements/decorators/requires-feature.decorator';

/**
 * LC-3/LC-4 (SKILL_loss_control_doses.md, Prompt 2). `PosScopeGuard`, JAMAIS
 * `JwtGuard`+`RolesGuard` — un poste comptoir connecté par PIN n'a pas de `role` (précédent
 * documenté sur `GET /pos/config`, `pos.controller.ts`).
 */
@ApiTags('POS')
@ApiBearerAuth()
@Controller('pos')
@UseGuards(PosScopeGuard, FeatureGuard)
@RequiresFeature('pos')
export class PosDoseLogController {
  constructor(private readonly doseLogs: DoseLogService) {}

  @ApiOperation({ summary: 'Declare (or update) product doses consumed for an appointment' })
  @ApiResponse({ status: 201, description: 'Doses declared.' })
  @Post('appointments/:id/doses')
  async declare(
    @CurrentPosUser() caller: PosUser,
    @Param('id') id: string,
    @Body() dto: DeclareDosesDto,
  ): Promise<{ data: DoseLogDocument[]; message: string }> {
    const data = await this.doseLogs.declare(id, caller.staffId, dto.lines);
    return { data, message: 'Doses declared.' };
  }

  @ApiOperation({ summary: 'Get declared doses and the expected theoretical for an appointment' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('appointments/:id/doses')
  async list(@Param('id') id: string): Promise<{ data: DoseLogList; message: string }> {
    const data = await this.doseLogs.list(id);
    return { data, message: 'OK' };
  }
}
