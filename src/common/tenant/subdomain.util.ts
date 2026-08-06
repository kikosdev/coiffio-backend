const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'admin']);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Extrait un slug de tenant candidat depuis le sous-domaine du Host de la requête
 * (`alpha.salonos.com` → `'alpha'`). Sprint 2 v2 Prompt 4 — aucune infra de hosting par
 * sous-domaine n'existe encore dans ce projet (Sprint 3/Control Plane), donc invérifiable
 * en conditions réelles pour l'instant : conçu pour être un NO-OP sûr partout où on peut
 * réellement tester aujourd'hui (`localhost`, `127.0.0.1`, tout hostname à 1 ou 2 labels)
 * plutôt qu'une supposition non prouvée. `resolveSalonId()` retombe alors sur le slug
 * explicite fourni par l'appelant (`RegisterDto.salonSlug`).
 *
 * ⚠️ `127.0.0.1` a 4 labels séparés par des points — sans l'exclusion IPv4 explicite
 * ci-dessous, `labels.length < 3` seul l'aurait laissé passer et renvoyé `'127'` comme
 * "slug" (piège trouvé en écrivant les tests de ce prompt, jamais atteint en prod mais
 * réel dès qu'un test tape `http://127.0.0.1:PORT`, ce que toute la suite fait).
 */
export function extractTenantSlugFromHost(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  if (IPV4_RE.test(hostname)) return undefined;
  const labels = hostname.split('.');
  if (labels.length < 3) return undefined; // localhost / domaine nu — pas de sous-domaine réel
  const candidate = labels[0].toLowerCase();
  if (!candidate || RESERVED_SUBDOMAINS.has(candidate)) return undefined;
  return candidate;
}
