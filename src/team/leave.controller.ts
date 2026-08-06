import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LeaveService } from './leave.service';
import { CreateLeaveRequestDto, ListLeaveQueryDto } from './dto/team.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Leave / shift-swap (Sprint 3). Soumission = staff (stylist pour soi) ; file
 * d'approbation + approbation/refus = owner·manager (matrice). L'approbation applique
 * le BLOCK + force reassign (#6) : si des bookings collisionnent → **409** avec la liste
 * des conflits, sans rien approuver.
 */
@ApiTags('Leave')
@ApiBearerAuth()
@Controller('leave-requests')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @ApiOperation({ summary: 'List leave requests for the salon (scoped to self for stylists)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: ListLeaveQueryDto) {
    const data = await this.leave.list(user, query.status);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Submit a new leave request' })
  @ApiResponse({ status: 201, description: 'Leave request submitted.' })
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveRequestDto) {
    const data = await this.leave.create(user, dto);
    return { data, message: 'Leave request submitted.' };
  }

  @ApiOperation({ summary: 'Approve a leave request (owner/manager only)' })
  @ApiResponse({ status: 201, description: 'Leave approved.' })
  @Post(':id/approve')
  @Roles('owner', 'manager')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // En cas de conflit, le service lève un 409 { conflicts } (jamais d'auto-résolution, #6).
    const data = await this.leave.approve(user, id);
    return { data, message: 'Leave approved.' };
  }

  @ApiOperation({ summary: 'Reject a leave request (owner/manager only)' })
  @ApiResponse({ status: 201, description: 'Leave request rejected.' })
  @Post(':id/reject')
  @Roles('owner', 'manager')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.leave.reject(user, id);
    return { data, message: 'Leave request rejected.' };
  }
}
