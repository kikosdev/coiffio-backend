import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaisseService } from './caisse.service';
import {
  CaisseDayQueryDto,
  CaisseHistoryQueryDto,
  CloseSessionDto,
  CreateCashMovementDto,
  OpenSessionDto,
} from './dto/caisse.dto';
import { PosScopeGuard, PosUser } from '../common/guards/pos-scope.guard';
import { CurrentPosUser } from '../common/decorators/current-pos-user.decorator';
import { FeatureGuard } from '../common/entitlements/guards/feature.guard';
import { RequiresFeature } from '../common/entitlements/decorators/requires-feature.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Caisse Journal — contrôle de la caisse physique du salon depuis le POS.
 *
 * `PosScopeGuard` (et non `JwtGuard` + `RolesGuard`) : le poste comptoir tourne le plus
 * souvent sur un token PIN `scope: 'pos'`, qui n'a pas de rôle. Le staff ouvre la caisse
 * et saisit les mouvements ; la CLÔTURE exige un JWT owner/manager — arbitré dans
 * `CaisseService` via `posUser.scope`, la seule information de privilège que le guard
 * expose.
 */
@ApiTags('Caisse')
@ApiBearerAuth()
@Controller('caisse')
@UseGuards(PosScopeGuard, FeatureGuard)
@RequiresFeature('pos')
export class CaisseController {
  constructor(private readonly caisse: CaisseService) {}

  @ApiOperation({ summary: 'Get the cash journal for a day: session, running totals and chronological entries' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('journal')
  async journal(@CurrentPosUser() posUser: PosUser, @Query() q: CaisseDayQueryDto) {
    const data = await this.caisse.getDay(posUser, q.date);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List past cash sessions with their variance (owner/manager only)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('sessions')
  async sessions(@CurrentPosUser() posUser: PosUser, @Query() q: CaisseHistoryQueryDto) {
    const data = await this.caisse.history(posUser, q.limit);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: "Open today's cash session with an opening float" })
  @ApiResponse({ status: 201, description: 'Caisse ouverte.' })
  @Post('session/open')
  async open(@CurrentPosUser() posUser: PosUser, @Body() dto: OpenSessionDto) {
    const data = await this.caisse.open(posUser, dto);
    return { data, message: 'Caisse ouverte.' };
  }

  @ApiOperation({ summary: 'Record a manual cash movement (in/out) on the open session' })
  @ApiResponse({ status: 201, description: 'Mouvement enregistré.' })
  @Post('session/movements')
  async movement(@CurrentPosUser() posUser: PosUser, @Body() dto: CreateCashMovementDto) {
    const data = await this.caisse.addMovement(posUser, dto);
    return { data, message: 'Mouvement enregistré.' };
  }

  @ApiOperation({ summary: 'Close the day: freeze counted vs expected cash and the variance (owner/manager only)' })
  @ApiResponse({ status: 201, description: 'Caisse clôturée.' })
  @Post('session/close')
  @Destructive()
  async close(@CurrentPosUser() posUser: PosUser, @Body() dto: CloseSessionDto) {
    const data = await this.caisse.close(posUser, dto);
    return { data, message: 'Caisse clôturée.' };
  }
}
