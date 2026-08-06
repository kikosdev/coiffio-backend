import { SetMetadata } from '@nestjs/common';

export const DESTRUCTIVE_KEY = 'destructive';

/** Marque une route comme irréversible/destructrice (delete, refund, désactivation,
 *  annulation...) — `DestructiveGuard` la bloque (403 IMPERSONATION_READONLY) quand la
 *  requête porte `impersonatedBy` (DP-SWEEP, Sprint 3 v2, prérequis du Prompt 5 CP). */
export const Destructive = () => SetMetadata(DESTRUCTIVE_KEY, true);
