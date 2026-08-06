import { ResolvedEntitlements } from './entitlements.types';

/**
 * Plan de secours "starter" — utilisé pour TOUT tenant tant que le Control Plane (Sprint 3)
 * n'existe pas, donc en pratique pour 100% du trafic pendant tout le Sprint 1. Décision
 * explicite (utilisateur, Prompt 7) : starter reprend tout ce qui est DÉJÀ en prod aujourd'hui
 * (pos/ecommerce/mobileApp/analytics) — aucune régression sur le salon pilote, qui utilise
 * déjà POS + storefront + rapports. Seules customDomain/api sont false : rien n'en dépend
 * aujourd'hui, ce sont de vrais paliers premium futurs.
 *
 * Limites HARD généreuses (staffMax=10, locationsMax=3) : large marge au-dessus de l'usage
 * réel constaté (4 staff, 0 location) — le guard est actif et prouvable sans risquer de
 * bloquer une croissance normale avant que le CP existe pour vendre un palier supérieur.
 * Limites SOFT larges (appointmentsMonth=500, smsQuota=200) : au-dessus de tout usage
 * plausible pour un starter — le seuil 80%/100% reste un signal utile, jamais un blocage.
 */
export const STARTER_ENTITLEMENTS: ResolvedEntitlements = {
  plan: 'starter',
  features: {
    pos: true,
    ecommerce: true,
    mobileApp: true,
    analytics: true,
    customDomain: false,
    api: false,
  },
  limits: {
    staffMax: 10,
    locationsMax: 3,
    appointmentsMonth: 500,
    smsQuota: 200,
  },
  status: 'active',
  // [Delta 3] Aucun flag actif en fallback — un tenant sans CP joignable ne doit jamais
  // hériter d'un comportement expérimental qu'aucun admin n'a explicitement activé pour lui.
  flags: {},
  source: 'fallback',
};

/** TTL du cache mémoire pour un résultat de secours — borne la fréquence du log d'erreur
 *  (une fois par fenêtre, pas une fois par requête) sans jamais dépasser la fraîcheur réelle
 *  d'un token vérifié (qui utilise sa propre exp - now, cf. entitlements.service.ts). */
export const FALLBACK_CACHE_TTL_MS = 5 * 60_000;
