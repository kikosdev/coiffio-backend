/**
 * ⚠️ RÈGLE À VALIDER — SKILL_saas_sprint1_tenant_isolation_v2, Prompt 4, point durci #3.
 * Non devinée en silence : voici exactement ce qu'elle fait, à confirmer avant que
 * `ClientProfile.phone` (clé d'identité globale, unique) ne dépende de cette fonction.
 *
 * Constat déclencheur : `56765298` en base, sans indicatif ni `+` — les formats de
 * `clients.phone` sont hétérogènes (espaces, `+216`, sans indicatif, `00`, longueurs
 * variables 8 à 11 chiffres). Une clé d'identité globale ne peut pas tenir sur ça brut.
 *
 * Règle choisie (conservatrice — ne devine QUE le cas non ambigu) :
 *   1. Supprime espaces, tirets, points, parenthèses.
 *   2. Commence par '+' → gardé tel quel si la forme est `+` suivi de 8 à 15 chiffres.
 *   3. Commence par '00' → converti en '+' (convention internationale usuelle),
 *      même validation de longueur.
 *   4. Exactement 8 chiffres, sans indicatif → préfixé `+216` (Tunisie — le salon
 *      opère en Africa/Tunis, TND ; c'est l'hypothèse implicite de tout le système,
 *      pas une invention de cette fonction).
 *   5. Tout le reste (9, 10, 11+ chiffres sans indicatif, formats non reconnus)
 *      → retourne `null`. PAS de préfixe deviné sur une longueur ambiguë — le
 *      numéro part en conflit pour revue manuelle plutôt que d'être mal assigné
 *      à un pays au hasard.
 *
 * Conséquence connue sur les données actuelles : "736548732" (9 chiffres) et
 * "82927687682" (11 chiffres) ne normaliseront PAS — ils resteront `null` et donc
 * sans ClientProfile tant qu'ils ne sont pas corrigés à la main ou que la règle
 * n'est pas élargie sciemment.
 */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('+')) {
    return /^\+\d{8,15}$/.test(cleaned) ? cleaned : null;
  }

  if (cleaned.startsWith('00')) {
    const withPlus = '+' + cleaned.slice(2);
    return /^\+\d{8,15}$/.test(withPlus) ? withPlus : null;
  }

  if (/^\d{8}$/.test(cleaned)) {
    return '+216' + cleaned;
  }

  return null;
}
