import { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Augmente `Express.User` avec notre payload JWT (peuplé par JwtGuard / passport-jwt).
 * Permet à `req.user` d'être typé `AuthUser` partout (getSalonScope, @CurrentUser).
 */
declare global {
   
  namespace Express {
    interface User extends AuthUser {}
  }
}

export {};
