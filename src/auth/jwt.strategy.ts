import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ConfigService } from '@nestjs/config';

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

  validate(payload: AuthUser): AuthUser {
    return {
      sub:         payload.sub,
      salonId:     payload.salonId,
      role:        payload.role,
      name:        payload.name,
      email:       payload.email,
      phone:       payload.phone,
      accountType: payload.accountType ?? (payload.role === 'client' ? 'client' : 'staff'),
      staffId:     payload.staffId,
      clientId:    payload.clientId,
    };
  }
}
