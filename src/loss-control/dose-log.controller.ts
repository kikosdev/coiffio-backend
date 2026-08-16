import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DoseLogService } from './dose-log.service';
import { CorrectDoseLogDto } from './dto/dose-log.dto';
import { DoseLogDocument } from './schemas/dose-log.schema';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * LC-4 (SKILL_loss_control_doses.md, Prompt 2) : correction owner-only APRÈS verrouillage.
 * `JwtGuard`+`RolesGuard` ici, PAS `PosScopeGuard` — action owner, pas comptoir.
 */
@ApiTags('Loss Control')
@ApiBearerAuth()
@Controller('doses')
@UseGuards(JwtGuard, RolesGuard)
export class DoseLogController {
  constructor(private readonly doseLogs: DoseLogService) {}

  @ApiOperation({ summary: 'Correct a locked dose declaration (owner-only, traced)' })
  @ApiResponse({ status: 200, description: 'Correction enregistrée.' })
  @Patch(':id')
  @Roles('owner')
  async correct(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CorrectDoseLogDto,
  ): Promise<{ data: DoseLogDocument; message: string }> {
    const data = await this.doseLogs.correct(id, user.staffId ?? user.sub, dto.dosesDeclared, dto.correctionNote);
    return { data, message: 'Correction enregistrée.' };
  }
}
