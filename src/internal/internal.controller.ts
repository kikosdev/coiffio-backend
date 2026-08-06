import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalService } from './internal.service';
import { ImpersonateDto, ProvisionTenantDto, UpdateTenantStatusDto } from './dto/internal.dto';

/**
 * API interne de provisioning (SKILL Prompt 8) — appelée par le Control Plane (Sprint 3,
 * pas encore construit). Seules routes non protégées par JWT ; sécurisées par
 * `InternalAuthGuard` (signature HMAC, pas d'authentification utilisateur). Déjà hors
 * `TenantContextMiddleware` (`internal/(.*)` exclu, `app.module.ts`).
 */
@ApiExcludeController()
@Controller('internal/tenants')
@UseGuards(InternalAuthGuard)
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Post()
  async provision(@Body() dto: ProvisionTenantDto) {
    return this.internal.provisionTenant(dto);
  }

  @Patch(':tenantId/status')
  async updateStatus(@Param('tenantId') tenantId: string, @Body() dto: UpdateTenantStatusDto) {
    return this.internal.updateTenantStatus(tenantId, dto.status);
  }

  @Post(':tenantId/impersonate')
  async impersonate(@Param('tenantId') tenantId: string, @Body() dto: ImpersonateDto) {
    return this.internal.impersonate(tenantId, dto);
  }

  @Get(':tenantId/usage')
  async usage(@Param('tenantId') tenantId: string) {
    return this.internal.usage(tenantId);
  }
}
