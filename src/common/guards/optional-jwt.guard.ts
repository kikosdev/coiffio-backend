import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Sprint 2 v2 Prompt 2 : `req.user` est désormais résolu-ou-absent par
 * `TenantContextMiddleware` (voir `JwtGuard` pour le détail) — ce guard n'a plus rien à
 * décoder lui-même, il laisse simplement toujours passer (routes publiques qui se
 * comportent différemment si authentifiées, ex. panier storefront).
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
