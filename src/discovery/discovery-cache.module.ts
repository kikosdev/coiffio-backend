import { Module } from '@nestjs/common';
import { DiscoveryCacheService } from './discovery-cache.service';

/** Module dédié minimal (pas de schémas, pas de dépendances) — importable depuis n'importe
 *  quel module qui doit invalider le cache discovery sans hériter de tout `DiscoveryModule`. */
@Module({
  providers: [DiscoveryCacheService],
  exports: [DiscoveryCacheService],
})
export class DiscoveryCacheModule {}
