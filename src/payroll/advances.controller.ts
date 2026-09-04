import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdvancesService } from './advances.service';
import { CreateAdvanceDto, DecideAdvanceDto, ListAdvancesQueryDto } from './dto/payroll.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Avances sur salaire (SKILL_owner_paie_rh, P6/P11). Écriture décisionnelle (accorder
 * directement, approuver/refuser) = owner uniquement. Un staff (manager/stylist/colorist)
 * peut seulement déposer une demande (`POST`, → pending) et lire SES propres avances
 * (`GET /advances/me`, #9) — jamais l'overview salon.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('advances')
@UseGuards(JwtGuard, RolesGuard)
export class AdvancesController {
  constructor(private readonly advances: AdvancesService) {}

  @ApiOperation({ summary: 'Grant (owner) or request (staff) a salary advance' })
  @ApiResponse({ status: 201, description: 'Advance created.' })
  @Post()
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAdvanceDto) {
    const data = await this.advances.create(user, dto);
    return { data, message: 'Advance created.' };
  }

  @ApiOperation({ summary: 'Approve or reject a pending advance (owner only)' })
  @ApiResponse({ status: 200, description: 'Advance decided.' })
  @Patch(':id/decide')
  @Roles('owner')
  async decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideAdvanceDto) {
    const data = await this.advances.decide(user, id, dto);
    return { data, message: 'Advance decided.' };
  }

  @ApiOperation({ summary: 'List all advances for the salon (owner overview)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  @Roles('owner')
  async list(@Query() query: ListAdvancesQueryDto) {
    const data = await this.advances.listForOwner(query);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List my own advances (#9)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('me')
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async listMine(@CurrentUser() user: AuthUser) {
    const data = await this.advances.listForStaff(user);
    return { data, message: 'OK' };
  }
}
