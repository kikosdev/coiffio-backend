import { JwtService } from '@nestjs/jwt';

/**
 * Extrait de `AuthService` (Sprint 4 Prompt 2) — le mécanisme de token "définir/réinitialiser
 * le mot de passe" est UNIQUE, partagé par deux déclencheurs différents : une demande
 * spontanée de l'utilisateur (`POST /auth/password-reset/request`) et l'email de bienvenue
 * envoyé automatiquement à la création d'un tenant (`InternalService.provisionTenant()`).
 * Même `purpose` dans les deux cas — `AuthService.confirmPasswordReset()` ne fait aucune
 * distinction, un lien de bienvenue non cliqué se comporte comme un lien de reset classique.
 */
export const RESET_PURPOSE = 'pwd_reset';

export interface ResetPayload {
  sub: string;
  purpose: string;
}

export function mintResetToken(jwt: JwtService, userId: string, ttl: string): string {
  const payload: ResetPayload = { sub: userId, purpose: RESET_PURPOSE };
  return jwt.sign(payload, { expiresIn: ttl });
}

export function resetPasswordLink(token: string): string {
  return `${process.env.FRONTEND_ORIGIN ?? ''}/reset-password?token=${token}`;
}
