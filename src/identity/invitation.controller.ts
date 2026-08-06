import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InvitationService } from './invitation.service';
import { AcceptInvitationDto, CreateInvitationDto, ListInvitationsQueryDto } from './dto/invitation.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { currentScope } from '../common/scope/salon-scope';
import { LimitGuard } from '../common/entitlements/guards/limit.guard';
import { EnforcesLimit } from '../common/entitlements/decorators/enforces-limit.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Backoffice (owner/manager, JWT) + public (token d'invitation, aucun JWT) dans le même
 * contrôleur — chaque garde est posée PAR MÉTHODE (pas au niveau classe, contrairement à
 * `TeamController`) puisque les routes `accept/:token` n'en portent structurellement aucun.
 */
@ApiTags('Invitations')
@Controller('invitations')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @ApiOperation({ summary: 'Invite a new staff member (owner/manager)' })
  @ApiResponse({ status: 201, description: 'Invitation created and sent.' })
  @ApiBearerAuth()
  @Post()
  @UseGuards(JwtGuard, RolesGuard, LimitGuard)
  @Roles('owner', 'manager')
  @EnforcesLimit('staffMax')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateInvitationDto) {
    const { salonId } = currentScope();
    const data = await this.invitations.create(salonId, user.role, user.sub, dto);
    return { data, message: 'Invitation created and sent.' };
  }

  @ApiOperation({ summary: 'List invitations for the current tenant (owner/manager)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async list(@Query() query: ListInvitationsQueryDto) {
    const { salonId } = currentScope();
    const data = await this.invitations.list(salonId, query.status);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Revoke a pending invitation (owner/manager)' })
  @ApiResponse({ status: 200, description: 'Invitation revoked.' })
  @ApiBearerAuth()
  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  @Destructive()
  async revoke(@Param('id') id: string) {
    const { salonId } = currentScope();
    const data = await this.invitations.revoke(salonId, id);
    return { data, message: 'Invitation revoked.' };
  }

  @ApiOperation({ summary: 'Resend an invitation (owner/manager, rate-limited to 1/min)' })
  @ApiResponse({ status: 200, description: 'Invitation resent.' })
  @ApiBearerAuth()
  @Post(':id/resend')
  @UseGuards(JwtGuard, RolesGuard, ThrottlerGuard)
  @Roles('owner', 'manager')
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  async resend(@Param('id') id: string) {
    const { salonId } = currentScope();
    const data = await this.invitations.resend(salonId, id);
    return { data, message: 'Invitation resent.' };
  }

  @ApiOperation({ summary: 'Preview an invitation by its token (public)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiResponse({ status: 410, description: 'Invitation expired, revoked, or already accepted.' })
  @Get('accept/:token')
  async preview(@Param('token') token: string) {
    const data = await this.invitations.preview(token);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Accept an invitation (public) — creates the account/session' })
  @ApiResponse({ status: 201, description: 'Invitation accepted.' })
  @ApiResponse({ status: 410, description: 'Invitation expired, revoked, or already accepted.' })
  @Post('accept/:token')
  async accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    const data = await this.invitations.accept(token, dto.password);
    return { data, message: 'Invitation accepted.' };
  }
}
