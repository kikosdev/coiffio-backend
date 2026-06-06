import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../schemas/user.schema';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  staffId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'coiffio-secret-key'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    return {
      sub:     payload.sub,
      email:   payload.email,
      role:    payload.role,
      staffId: payload.staffId,
    };
  }
}
