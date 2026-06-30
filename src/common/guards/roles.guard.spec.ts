import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AuthUser, Role } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Vérifie que RolesGuard applique la matrice de permissions (SKILL.md) à partir
 * du décorateur @Roles. Sans dépendance externe : node:test + assert.
 * Lancer : `npx ts-node --transpile-only src/common/guards/roles.guard.spec.ts`
 */

// Fabrique un ExecutionContext minimal portant un user et des rôles requis.
function makeContext(required: Role[] | undefined, user: AuthUser | undefined): {
  ctx: ExecutionContext;
  reflector: Reflector;
} {
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

test('owner passes a @Roles("owner") route', () => {
  const { ctx, reflector } = makeContext(['owner'], owner);
  const guard = new RolesGuard(reflector);
  assert.equal(guard.canActivate(ctx), true);
});

test('stylist is blocked from a @Roles("owner") route', () => {
  const { ctx, reflector } = makeContext(['owner'], stylist);
  const guard = new RolesGuard(reflector);
  assert.throws(() => guard.canActivate(ctx), ForbiddenException);
});

test('stylist passes a @Roles("owner","manager","stylist") route', () => {
  const { ctx, reflector } = makeContext(['owner', 'manager', 'stylist'], stylist);
  const guard = new RolesGuard(reflector);
  assert.equal(guard.canActivate(ctx), true);
});

test('no @Roles metadata => any authenticated user passes', () => {
  const { ctx, reflector } = makeContext(undefined, stylist);
  const guard = new RolesGuard(reflector);
  assert.equal(guard.canActivate(ctx), true);
});
