import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../internal/internal-auth.guard';
import { EntitlementsService } from './entitlements.service';

interface InvalidateBody {
  tenantId: string;
}

/**
 * Webhook d'invalidation (SKILL Prompt 7, point 5) — POST /internal/entitlements/invalidate.
 * Déjà hors TenantContextMiddleware (`internal/(.*)` exclu, AppModule). Authentifié par
 * `InternalAuthGuard` (Prompt 8) — remplace le check HMAC ad-hoc écrit ici en Prompt 7
 * (notée provisoire dès l'origine ; substitution mécanique, mêmes en-têtes).
 */
@ApiExcludeController()
@Controller('internal/entitlements')
@UseGuards(InternalAuthGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Post('invalidate')
  invalidate(@Body() body: InvalidateBody): { ok: true } {
    if (!body?.tenantId) throw new BadRequestException('tenantId is required.');
    this.entitlements.invalidate(body.tenantId);
    return { ok: true };
  }
}
