import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService, LatestVisit } from './clients.service';
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
  constructor(private readonly clients: ClientsService) {}

  @ApiOperation({ summary: "Get the current client's most recent visit" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('latest-visit')
  async latestVisit(
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: LatestVisit | null; message: string }> {
    const data = await this.clients.getLatestVisit(user.clientId as string);
    return { data, message: 'OK' };
  }
}
