import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalService } from './internal.service';
import { OwnerLookupQueryDto } from './dto/internal.dto';

/**
 * [P2 owner multi-salon] Lookup d'identité owner pour le Control Plane. Contrôleur SÉPARÉ de
 * `InternalController` (`internal/tenants`) parce que la ressource est différente — un user,
 * pas un tenant — et que le préfixe de route l'impose (`internal/owners`).
 *
 * Même `InternalAuthGuard` que tout `/internal/*`, réutilisé tel quel (aucune variante) :
 * HMAC `timestamp + '.' + rawBody`, rotation de secret incluse.
 *
 * ⚠️ GET SANS CORPS — le piège de la leçon Sprint 3 P6 : le body-parser d'Express ne
 * s'exécute pas sur un GET sans `Content-Type`, donc `req.rawBody` est `undefined` et le
 * guard retombe sur `Buffer.from(JSON.stringify(req.body ?? {}))`, c'est-à-dire la chaîne
 * littérale `'{}'` — PAS `''`. Tout appelant doit signer `'{}'` sans l'envoyer (la spec fetch
 * interdit un corps sur un GET). Le `dp-client` du CP le fait déjà correctement depuis le
 * correctif de `getUsage()` ; c'est prouvé ici contre le VRAI guard, jamais contre un mock.
 */
@ApiExcludeController()
@Controller('internal/owners')
@UseGuards(InternalAuthGuard)
export class OwnersController {
  constructor(private readonly internal: InternalService) {}

  @Get('lookup')
  async lookup(@Query() query: OwnerLookupQueryDto) {
    return this.internal.lookupOwner(query.identifier);
  }
}
