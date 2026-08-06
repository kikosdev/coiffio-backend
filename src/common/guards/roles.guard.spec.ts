import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AuthUser, Role } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Vérifie que RolesGuard applique la matrice de permissions (SKILL.md) à partir du
 *  décorateur @Roles. Unitaire, sans DB (migré de node:test vers Jest — Prompt 9). */

function makeContext(required: Role[] | undefined, user: AuthUser | undefined): { ctx: ExecutionContext; reflector: Reflector } {
  const reflector = {
    getAllAndOverride: (key: string) => (key === ROLES_KEY ? required : undefined),
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;

  return { ctx, reflector };
}

const owner: AuthUser = { sub: '1', salonId: 's', role: 'owner', name: 'Owner', email: 'owner@test.com', accountType: 'staff' };
const stylist: AuthUser = { sub: '2', salonId: 's', role: 'stylist', name: 'Stylist', email: 'stylist@test.com', accountType: 'staff' };

describe('RolesGuard', () => {
  it('owner passes a @Roles("owner") route', () => {
    const { ctx, reflector } = makeContext(['owner'], owner);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('stylist is blocked from a @Roles("owner") route', () => {
    const { ctx, reflector } = makeContext(['owner'], stylist);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('stylist passes a @Roles("owner","manager","stylist") route', () => {
    const { ctx, reflector } = makeContext(['owner', 'manager', 'stylist'], stylist);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('no @Roles metadata => any authenticated user passes', () => {
    const { ctx, reflector } = makeContext(undefined, stylist);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
