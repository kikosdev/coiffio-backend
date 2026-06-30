import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { extractToken } from './jwt.guard';
import { PosTokenPayload } from '../../auth/dto/auth.dto';
import { AuthUser } from '../decorators/current-user.decorator';

export const POS_USER_KEY = 'posUser';

export interface PosUser {
  staffId: string;
  salonId: string;
  scope: 'pos' | 'owner';
}

@Injectable()
export class PosScopeGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { posUser?: PosUser }>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Authentication required.');

    let payload: PosTokenPayload | AuthUser;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const isPosToken = (payload as PosTokenPayload).scope === 'pos';
    const isPrivileged =
      !isPosToken &&
      ['owner', 'manager'].includes((payload as AuthUser).role ?? '');

    if (!isPosToken && !isPrivileged) {
      throw new UnauthorizedException('POS scope or owner/manager role required.');
    }

    if (isPosToken) {
      const p = payload as PosTokenPayload;
      req.posUser = { staffId: p.staffId, salonId: p.salonId, scope: 'pos' };
    } else {
      const p = payload as AuthUser;
      req.posUser = {
        staffId: p.staffId ?? p.sub,
        salonId: p.salonId,
        scope: 'owner',
      };
    }

    return true;
  }
}
