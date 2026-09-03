import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalService } from './internal.service';
import { UpdateSalonSponsorshipDto } from './dto/internal.dto';

/**
 * [SKILL_discovery_enrichment_sponsored, Prompt 4] Contrôleur SÉPARÉ de `InternalController`
 * (`internal/tenants`) — même raison que `OwnersController` (`internal/owners`) : la
 * ressource est `salons`, pas `tenants`, et le préfixe de route l'impose. Même
 * `InternalAuthGuard` que tout `/internal/*`, réutilisé tel quel. Déjà hors
 * `TenantContextMiddleware` (`internal/(.*)` exclu, `app.module.ts`) — `Salon` est UNSCOPED
 * de toute façon, donc aucun contexte tenant n'est requis pour cette écriture.
 */
@ApiExcludeController()
@Controller('internal/salons')
@UseGuards(InternalAuthGuard)
export class SalonsInternalController {
  constructor(private readonly internal: InternalService) {}

  @Patch(':slug/sponsorship')
  async updateSponsorship(@Param('slug') slug: string, @Body() dto: UpdateSalonSponsorshipDto) {
    return this.internal.updateSponsorship(slug, dto);
  }
}
