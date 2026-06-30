const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function detectIdentifierType(raw: string): 'email' | 'phone' {
  return EMAIL_RE.test(raw.trim()) ? 'email' : 'phone';
}

/**
 * Normalise l'identifiant de login.
 * Email → lowercase. Téléphone tunisien → +216XXXXXXXX canonique.
 * Garantit que "22 123 456", "+21622123456", "0021622123456" matchent la même ligne.
 */
export function normalizeIdentifier(raw: string): { value: string; type: 'email' | 'phone' } {
  const v = raw.trim();
  if (detectIdentifierType(v) === 'email') {
    return { value: v.toLowerCase(), type: 'email' };
  }
  let digits = v.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00216')) digits = '+' + digits.slice(2);
  else if (digits.startsWith('216')) digits = '+' + digits;
  else if (!digits.startsWith('+')) digits = '+216' + digits;
  return { value: digits, type: 'phone' };
}
