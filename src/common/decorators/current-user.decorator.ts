import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export type Role = 'owner' | 'manager' | 'stylist' | 'colorist' | 'client';

export interface AuthUser {
  sub: string;       // users._id (Identity Service)
  salonId: string;   // résolu au login depuis le profil (Staff.salonId ou Client.salonId)
  role: Role;
  name?: string;
  email?: string;
  phone?: string;
  accountType: 'staff' | 'client';
  staffId?: string;  // Staff._id — présent si role ∈ {owner, manager, stylist, colorist}
  clientId?: string; // Client._id — présent si role = client
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
