import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { EntitlementsService } from './entitlements.service';
import { EntitlementsController } from './entitlements.controller';
import { FeatureGuard } from './guards/feature.guard';
import { LimitGuard } from './guards/limit.guard';
import { FlagsService } from './flags.service';

/**
 * `@Global()` — même raisonnement que `CommonModule` (JwtGuard/RolesGuard) : `FeatureGuard`/
 * `LimitGuard` sont référencés par CLASSE dans `@UseGuards(...)` depuis de nombreux modules
 * indépendants (Team, Finance, Orders, Locations, Booking). `LimitGuard` n'a plus besoin de
 * `MongooseModule.forFeature` ici — il résout Staff/Location via la connexion partagée
 * (`@InjectConnection`), pas via `@InjectModel` (voir sa docstring : un `@InjectModel()`
 * déclaré dans un module tiers ne se résolvait pas de façon fiable pour un guard consommé
 * par classe depuis un autre module, constaté empiriquement).
 */
@Global()
@Module({
  imports: [NotificationsModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsService, FeatureGuard, LimitGuard, FlagsService],
  exports: [EntitlementsService, FeatureGuard, LimitGuard, FlagsService],
})
export class EntitlementsModule {}
