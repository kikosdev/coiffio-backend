import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Sprint 2 v2 Prompt 2 : ne décode plus le JWT lui-même. `TenantContextMiddleware`
 * (Express-level, s'exécute AVANT tout guard Nest) est désormais le SEUL endroit qui
 * décode le token et peuple `req.user` — la résolution du tenant/rôle actif demande la
 * logique memberships (header/sous-domaine/membership unique), et la refaire ici
 * indépendamment produirait un `req.user` DIFFÉRENT (potentiellement divergent) de celui
 * que `TenantContext` utilise pour scoper les requêtes Mongo. Ce guard ne fait donc plus
 * que vérifier qu'une résolution a eu lieu — 401 sinon (token absent/invalide/expiré, ou
 * résolution tenant qui aurait déjà throw plus haut dans le pipeline).
 */
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!req.user) throw new UnauthorizedException('Authentication required.');
    return true;
  }
}

export function extractToken(req: Request): string | null {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.access_token;
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
