import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { TeamService } from './team.service';
import { CreateStaffDto, UpdateStaffDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Team (Sprint 3). Matrice : roster = owner·manager·stylist (besoin opérationnel — la paie
 * n'est jamais jointe pour un stylist, #9) ; créer/supprimer un compte = owner only ;
 * éditer profil/level/capabilities = owner·manager. `me/standing` = chiffres du stylist
 * courant UNIQUEMENT (#9). Enveloppe + scope partout.
 */
@Controller('team')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  async list(@Req() req: Request, @CurrentUser('role') role: string) {
    const data = await this.team.listStaff(getSalonScope(req), role);
    return { data, message: 'OK' };
  }

  /** #9 — paie/commission/tips du stylist courant uniquement (l'identité vient du JWT). */
  @Get('me/standing')
  async standing(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.team.myStanding(getSalonScope(req), user);
    return { data, message: 'OK' };
  }

  @Post()
  @Roles('owner')
  async create(@Req() req: Request, @Body() dto: CreateStaffDto) {
    const data = await this.team.createStaff(getSalonScope(req), dto);
    return { data, message: 'Staff account created.' };
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateStaffDto) {
    const data = await this.team.updateStaff(getSalonScope(req), id, dto);
    return { data, message: 'Staff account updated.' };
  }

  @Delete(':id')
  @Roles('owner')
  async deactivate(@Req() req: Request, @Param('id') id: string) {
    const data = await this.team.deactivateStaff(getSalonScope(req), id);
    return { data, message: 'Staff account deactivated.' };
  }
}
