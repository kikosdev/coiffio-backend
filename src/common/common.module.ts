import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtGuard } from './guards/jwt.guard';
import { OptionalJwtGuard } from './guards/optional-jwt.guard';
import { RolesGuard } from './guards/roles.guard';
import { PosScopeGuard } from './guards/pos-scope.guard';

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
  providers: [JwtGuard, OptionalJwtGuard, RolesGuard, PosScopeGuard],
  exports: [JwtModule, JwtGuard, OptionalJwtGuard, RolesGuard, PosScopeGuard],
})
export class CommonModule {}
