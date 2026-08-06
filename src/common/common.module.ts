import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtGuard } from './guards/jwt.guard';
import { OptionalJwtGuard } from './guards/optional-jwt.guard';
import { RolesGuard } from './guards/roles.guard';
import { PosScopeGuard } from './guards/pos-scope.guard';
import { DestructiveGuard } from './guards/destructive.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        return {
          secret: process.env.JWT_SECRET,
          signOptions: { expiresIn: process.env.JWT_EXPIRES },
        };
      },
    }),
  ],
  providers: [
    JwtGuard,
    OptionalJwtGuard,
    RolesGuard,
    PosScopeGuard,
    // DP-SWEEP : global, no-op sauf sur les routes @Destructive() — voir sa docstring.
    { provide: APP_GUARD, useClass: DestructiveGuard },
  ],
  exports: [JwtModule, JwtGuard, OptionalJwtGuard, RolesGuard, PosScopeGuard],
})
export class CommonModule {}
