import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService, LatestVisit } from './clients.service';
import { ClientProfileService, GlobalHistoryEntry } from '../identity/client-profile.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Self-service client (mobile app) — distinct de ClientsController (CRM staff).
 */
@ApiTags('Clients')
@ApiBearerAuth()
@Controller('clients/me')
@UseGuards(JwtGuard, RolesGuard)
@Roles('client')
export class ClientMeController {
  constructor(
    private readonly clients: ClientsService,
    private readonly clientProfiles: ClientProfileService,
  ) {}

  @ApiOperation({ summary: "Get the current client's most recent visit" })
  @ApiResponse({ status: 200, description: 'OK' })
  /**
   * Clefé sur `user.sub` (identité), plus sur `user.clientId` : un client n'a pas de Membership,
   * donc pas de `clientId`/`salonId` résolus — et un client réserve chez plusieurs salons, donc
   * "dernière visite" est une question cross-tenant, pas une question par-salon.
   */
  @Get('latest-visit')
  async latestVisit(
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: LatestVisit | null; message: string }> {
    const data = await this.clients.getLatestVisitForUser(user.sub);
    return { data, message: 'OK' };
  }

  // Spec Prompt 4 : "GET /me/history". Placé sous /clients/me/* pour rester cohérent
  // avec le préfixe déjà établi par latest-visit ci-dessus, plutôt qu'un /me/history
  // isolé à la racine.
  @ApiOperation({ summary: "Get the current client's global history across all tenants (ClientProfile)" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('history')
  async history(
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: GlobalHistoryEntry[]; message: string }> {
    // Idem : résolu depuis l'identité, jamais depuis un tenant actif (voir latest-visit).
    const data = await this.clientProfiles.getHistoryForUser(user.sub);
    return { data, message: 'OK' };
  }
}
