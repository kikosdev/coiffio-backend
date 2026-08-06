import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DESTRUCTIVE_KEY } from '../decorators/destructive.decorator';
import { tenantStorage } from '../tenant/tenant-context';

/**
 * DP-SWEEP (Sprint 3 v2 CP, prérequis du Prompt 5 impersonation) — le plumbing
 * impersonation (JWT→contexte→log) existait déjà (`TenantContextMiddleware`), mais rien
 * ne bloquait une action destructrice faite SOUS impersonation. Ce guard ferme ce trou.
 *
 * Enregistré GLOBALEMENT (`APP_GUARD`, `common.module.ts`) plutôt qu'ajouté route par
 * route via `@UseGuards()` — le balayage exhaustif exigé par l'audit (15 routes, 10
 * contrôleurs) rendrait un ajout manuel de guard par contrôleur trop facile à oublier sur
 * une future route. Un seul guard global, no-op partout sauf sur les routes marquées
 * `@Destructive()` (même pattern que `FeatureGuard`).
 *
 * Lit `tenantStorage.getStore()` DIRECTEMENT (pas `getTenantContext()`, qui throw si aucun
 * contexte n'existe) — DÉLIBÉRÉMENT tolérant à l'absence de contexte : certaines routes
 * marquées `@Destructive()` (ex. `booking.controller.ts` `cancel()`) établissent leur
 * TenantContext PLUS TARD, à l'intérieur du handler, via `guestScope.run()` (annulation
 * client par lien signé, sans JWT) — à ce stade (avant le handler), aucun contexte
 * n'existe encore pour cette requête précise. Une requête sans contexte au moment du guard
 * ne PEUT structurellement pas porter `impersonatedBy` (ce champ n'existe que sur un JWT
 * staff authentifié, résolu par le middleware AVANT ce guard) — donc "pas de contexte" ⇒
 * "pas impersonation" est un raccourci sûr, pas une échappatoire.
 */
@Injectable()
export class DestructiveGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isDestructive = this.reflector.getAllAndOverride<boolean>(DESTRUCTIVE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isDestructive) return true;

    const ctx = tenantStorage.getStore();
    if (ctx?.impersonatedBy) {
      throw new ForbiddenException({
        code: 'IMPERSONATION_READONLY',
        message: 'This action is blocked during an impersonated session.',
      });
    }
    return true;
  }
}
