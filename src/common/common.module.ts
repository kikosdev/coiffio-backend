import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtGuard } from './guards/jwt.guard';
import { OptionalJwtGuard } from './guards/optional-jwt.guard';
import { RolesGuard } from './guards/roles.guard';

/**
 * Module commun global : enregistre JwtModule (secret/exp depuis l'env) et expose
 * les guards réutilisables à toute l'application. Importé une fois dans AppModule.
 */
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
  providers: [JwtGuard, OptionalJwtGuard, RolesGuard],
  exports: [JwtModule, JwtGuard, OptionalJwtGuard, RolesGuard],
})
export class CommonModule {}
