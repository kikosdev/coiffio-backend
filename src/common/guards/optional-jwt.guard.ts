import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser } from '../decorators/current-user.decorator';
import { extractToken } from './jwt.guard';

/**
 * Convention #5 — laisse toujours passer la requête, mais attache `req.user`
 * si un token valide est présent (routes publiques qui se comportent différemment
 * quand authentifiées, ex. panier storefront).
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractToken(req);
    if (token) {
      try {
        req.user = await this.jwt.verifyAsync<AuthUser>(token);
      } catch {
        // token invalide → on reste anonyme, sans rejeter
        req.user = undefined;
      }
    }
    return true;
  }
}
