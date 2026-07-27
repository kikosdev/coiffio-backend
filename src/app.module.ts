import { Logger, MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { InjectConnection, MongooseModule } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import mongoose from 'mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { tenantScopePlugin, assertPluginApplied } from './common/tenant/tenant-scope.plugin';
import { assertRegistryCoverage } from './common/tenant/scoping-registry';
import { CommonModule } from './common/common.module';
import { HttpLoggerMiddleware } from './common/middleware/http-logger.middleware';
import { AuthModule } from './auth/auth.module';
import { ClientsModule } from './clients/clients.module';
import { ServicesModule } from './services/services.module';
import { TeamModule } from './team/team.module';
import { BookingModule } from './booking/booking.module';
import { FinanceModule } from './finance/finance.module';
import { StockModule } from './stock/stock.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OverviewModule } from './overview/overview.module';
import { SettingsModule } from './settings/settings.module';
import { PublicModule } from './public/public.module';
import { SalesModule } from './sales/sales.module';
import { SalonsModule } from './salons/salons.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { LocationsModule } from './locations/locations.module';
import { IdentityModule } from './identity/identity.module';
import { TenantModule } from './common/tenant/tenant.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { AppController } from './app.controller';

@Module({
  imports: [
    CommonModule,
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGO_URI,
        // mongoose.plugin() AVANT la connexion (spec Prompt 3). Vérifié empiriquement au
        // boot (log 'Tenant scoping OK' + assertPluginApplied) : les schémas, bien que
        // construits plus tôt à l'import des fichiers, ne sont réellement compilés en
        // Model qu'ici via connection.model() (déclenché par MongooseModule.forFeature),
        // c'est ce moment-là que Mongoose applique les plugins globaux — pas la
        // construction du Schema elle-même. Ce placement littéral est donc correct.
        connectionFactory: (connection: Connection) => {
          mongoose.plugin(tenantScopePlugin);
          return connection;
        },
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    AuthModule,
    ClientsModule,
    ServicesModule,
    TeamModule,
    BookingModule,
    FinanceModule,
    StockModule,
    OrdersModule,
    NotificationsModule,
    OverviewModule,
    SettingsModule,
    PublicModule,
    SalesModule,
    SalonsModule,
    MarketplaceModule,
    LocationsModule,
    IdentityModule,
    TenantModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  onModuleInit(): void {
    const modelNames = this.connection.modelNames();
    const models = modelNames.map((name) => this.connection.model<unknown>(name));
    assertRegistryCoverage(models.map((m) => m.collection.name));
    assertPluginApplied(models);
    new Logger('Bootstrap').log(
      `Tenant scoping OK — ${models.length} model(s) covered by the registry and the scope plugin: ${models.map((m) => m.modelName).join(', ')}.`,
    );
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes('*');

    // Sprint 1 v2, Prompt 2. ⚠️ Voir le rapport de livraison avant de déployer : tant que
    // migrate-create-primary-locations.ts n'a pas tourné en --apply en prod, aucun tenant
    // n'a de location primaire, et toute requête authentifiée hors des exclusions
    // ci-dessous échouera à résoudre un locationId (throw NotFoundException). Le
    // middleware ne fait rien pour les requêtes sans JWT valide (voir sa docstring) —
    // ces exclusions ne sont donc strictement nécessaires que pour le cas d'un cookie/
    // token périmé encore présent sur ces routes de pré-authentification.
    consumer
      .apply(TenantContextMiddleware)
      .exclude('health', 'internal/(.*)', 'discovery/(.*)', 'auth/login', 'auth/register')
      .forRoutes('*');
  }
}
