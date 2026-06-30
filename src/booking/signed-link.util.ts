import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Lien signé (Décision #12) — magic-link de suivi/annulation pour un guest, sans login.
 * On signe l'`appointmentId` avec un HMAC-SHA256 dérivé du JWT_SECRET. Le client reçoit
 * `{ id, token }` (BookSummary) ; l'annulation publique vérifie ce token.
 */
function secret(): string {
  return process.env.JWT_SECRET || 'dev-secret';
}

export function signAppointment(appointmentId: string): string {
  return createHmac('sha256', secret()).update(appointmentId).digest('base64url');
}

export function verifyAppointmentToken(appointmentId: string, token: string): boolean {
  if (!token) return false;
  const expected = signAppointment(appointmentId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
