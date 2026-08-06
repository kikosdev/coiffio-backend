import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export type Role = 'owner' | 'manager' | 'stylist' | 'colorist' | 'client';

/**
 * Sprint 2 v2 Prompt 2 : le JWT lui-même ne porte plus `salonId`/`role` à la racine (voir
 * `AuthTokenPayload` ci-dessous) — mais `AuthUser` (ce que `@CurrentUser()`/`req.user`
 * exposent aux contrôleurs) GARDE cette forme, pour ne rien casser des dizaines de call
 * sites existants qui lisent `user.role`/`user.salonId`/`user.staffId`/`user.clientId`
 * directement. La différence : ces champs sont désormais RÉSOLUS PAR
 * `TenantContextMiddleware` (depuis le membership actif de la requête), plus jamais
 * décodés tels quels depuis le JWT — `JwtGuard`/`OptionalJwtGuard` ne font plus que
 * vérifier que cette résolution a eu lieu (voir leurs docstrings).
 * `name`/`email`/`phone`/`accountType` restent optionnels : plus jamais peuplés par le
 * middleware (le nouveau JWT ne les porte pas — audit du 2026-08-02 : `email`/`accountType`
 * n'ont aucun lecteur réel, `name`/`phone` en ont un chacun, déjà protégés par un fallback
 * (`user.name ?? user.sub`) ou une garde (`if (user.phone)`) — dégradation sans casse.
 */
export interface AuthUser {
  sub: string;       // users._id (Identity Service)
  salonId: string;   // tenant ACTIF de cette requête — résolu par TenantContextMiddleware
  role: Role;         // rôle DANS ce tenant — résolu depuis le Membership actif, jamais users.role
  name?: string;
  email?: string;
  phone?: string;
  accountType: 'staff' | 'client';
  staffId?: string;  // Staff._id — présent si role ∈ {owner, manager, stylist, colorist}
  clientId?: string; // Client._id — présent si role = client
  impersonatedBy?: string;    // Prompt 8 — présent uniquement sur un JWT émis par POST /internal/tenants/:id/impersonate
  impersonationReason?: string;
}

/** Une entrée de `AuthTokenPayload.memberships[]` — ce que `MembershipService` projette
 *  dans le JWT à l'émission (login/register), copie figée du Membership actif à ce moment. */
export interface MembershipClaim {
  tenantId: string;
  role: Role;
  staffId?: string;
  clientId?: string;
  locationIds: string[];
  defaultLocationId?: string;
}

/**
 * Forme RÉELLE du JWT émis par `AuthService.issueToken()` (Sprint 2 v2 Prompt 2) — ce que
 * `TenantContextMiddleware` décode en premier lieu. PLUS de `salonId`/`role` racine : le
 * tenant actif est résolu PAR REQUÊTE (header/sous-domaine/membership unique), jamais figé
 * au login. `memberships` sert à IDENTIFIER le format d'un token (voir le fallback legacy
 * dans le middleware) et à peupler le payload d'erreur `TENANT_REQUIRED` ; la résolution
 * d'autorisation elle-même relit TOUJOURS les memberships actifs depuis la base (via
 * `MembershipService`, caché 60s) — jamais uniquement cette copie figée du JWT, pour qu'une
 * révocation se propage en ≤60s plutôt qu'attendre l'expiration du token (7j).
 */
export interface AuthTokenPayload {
  sub: string;
  memberships: MembershipClaim[];
  impersonatedBy?: string;
  impersonationReason?: string;
}

/**
 * Forme de l'ANCIEN JWT (avant ce déploiement), encore valide jusqu'à 7j après (JWT_EXPIRES
 * — pas de refresh token ce sprint, décision explicite, voir Prompt 2). Fallback transitoire
 * lu par `TenantContextMiddleware` UNIQUEMENT si `memberships` est absent du payload décodé.
 * ⚠️ À supprimer 7 jours après le déploiement de ce changement en prod.
 */
export interface LegacyAuthPayload {
  sub: string;
  salonId: string;
  role: Role;
  staffId?: string;
  clientId?: string;
  impersonatedBy?: string;
  impersonationReason?: string;
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
