import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export type Role = 'owner' | 'manager' | 'stylist' | 'colorist' | 'client';

export interface AuthUser {
  sub: string; // staff or user id
  salonId: string;
  role: Role;
  name?: string;
  email?: string;
  phone?: string;
  accountType: 'staff' | 'client';
}

/**
 * Récupère le user authentifié injecté par JwtGuard / OptionalJwtGuard.
 * Usage : `@CurrentUser() user: AuthUser` ou `@CurrentUser('role') role: Role`.
 */
export const CurrentUser = createParamDecorator(
  (key: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | AuthUser[keyof AuthUser] | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = req.user;
    if (!user) return undefined;
    return key ? user[key] : user;
  },
);
