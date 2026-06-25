import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { LeaveService } from './leave.service';
import { CreateLeaveRequestDto, ListLeaveQueryDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Leave / shift-swap (Sprint 3). Soumission = staff (stylist pour soi) ; file
 * d'approbation + approbation/refus = owner·manager (matrice). L'approbation applique
 * le BLOCK + force reassign (#6) : si des bookings collisionnent → **409** avec la liste
 * des conflits, sans rien approuver.
 */
@Controller('leave-requests')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get()
  async list(@Req() req: Request, @CurrentUser() user: AuthUser, @Query() query: ListLeaveQueryDto) {
    const data = await this.leave.list(getSalonScope(req), user, query.status);
    return { data, message: 'OK' };
  }

  @Post()
  async create(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() dto: CreateLeaveRequestDto) {
    const data = await this.leave.create(getSalonScope(req), user, dto);
    return { data, message: 'Leave request submitted.' };
  }

  @Post(':id/approve')
  @Roles('owner', 'manager')
  async approve(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    // En cas de conflit, le service lève un 409 { conflicts } (jamais d'auto-résolution, #6).
    const data = await this.leave.approve(getSalonScope(req), user, id);
    return { data, message: 'Leave approved.' };
  }

  @Post(':id/reject')
  @Roles('owner', 'manager')
  async reject(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.leave.reject(getSalonScope(req), user, id);
    return { data, message: 'Leave request rejected.' };
  }
}
