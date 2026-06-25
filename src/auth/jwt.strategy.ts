import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ConfigService } from '@nestjs/config';

/**
 * Sprint 1 — stratégie passport-jwt. Lit le token depuis le cookie `access_token`
 * ou le header Authorization Bearer, puis peuple `req.user` avec { sub, role, salonId, … }.
 * (Les guards `JwtGuard`/`OptionalJwtGuard` du module common vérifient déjà le token via
 * JwtService ; cette stratégie offre l'option `AuthGuard('jwt')` standard de Nest/passport.)
 */
function cookieExtractor(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.access_token ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

  constructor(private configService: ConfigService) {
  super({
    jwtFromRequest: ExtractJwt.fromExtractors([
      cookieExtractor,
      ExtractJwt.fromAuthHeaderAsBearerToken(),
    ]),
    ignoreExpiration: false,
    secretOrKey: configService.get<string>('JWT_SECRET'),
  });
}

  // La valeur retournée devient `req.user`.
  validate(payload: AuthUser): AuthUser {
    return {
      sub: payload.sub,
      salonId: payload.salonId,
      role: payload.role,
      name: payload.name,
      email: payload.email,
      accountType: payload.accountType ?? 'client',
    };
  }
}
