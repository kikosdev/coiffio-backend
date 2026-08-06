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

/**
 * Sprint 2 v2 Prompt 2 : la branche "privilégiée" (owner/manager avec un JWT régulier, pas
 * un token POS) lisait `role`/`salonId`/`staffId` en redécodant le JWT indépendamment —
 * ça cassait dès que ces champs ont quitté la racine du token (memberships[] désormais).
 * Lit maintenant `req.user`, déjà résolu par `TenantContextMiddleware` (qui s'exécute
 * avant ce guard — middleware Express, avant tout guard Nest) : c'est la SEULE source
 * fiable du rôle/tenant ACTIF de cette requête. Le token POS lui-même n'a pas de
 * Membership associé (verrouillé, hors du système memberships) — sa forme reste
 * INCHANGÉE, redécodée ici directement comme avant (voir la docstring de
 * `TenantContextMiddleware.handlePosToken` pour l'écart entre le SKILL et la forme réelle
 * de `PosTokenPayload`).
 */
@Injectable()
export class PosScopeGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { posUser?: PosUser; user?: AuthUser }>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Authentication required.');

    let decoded: Record<string, unknown>;
    try {
      decoded = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    if (decoded.scope === 'pos') {
      const p = decoded as unknown as PosTokenPayload;
      req.posUser = { staffId: p.staffId, salonId: p.salonId, scope: 'pos' };
      return true;
    }

    // JWT régulier : req.user déjà résolu par TenantContextMiddleware pour CETTE requête.
    const isPrivileged = !!req.user && ['owner', 'manager'].includes(req.user.role);
    if (!isPrivileged) {
      throw new UnauthorizedException('POS scope or owner/manager role required.');
    }
    req.posUser = {
      staffId: req.user!.staffId ?? req.user!.sub,
      salonId: req.user!.salonId,
      scope: 'owner',
    };
    return true;
  }
}
