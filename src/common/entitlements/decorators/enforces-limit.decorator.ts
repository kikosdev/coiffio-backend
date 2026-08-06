import { SetMetadata } from '@nestjs/common';
import { LimitKey } from '../entitlements.types';

export const ENFORCES_LIMIT_KEY = 'enforcesLimit';

/** Déclare la limite HARD vérifiée avant d'exécuter le handler. Usage :
 *  `@EnforcesLimit('staffMax')`. Seules staffMax/locationsMax sont HARD (403 bloquant) —
 *  les quotas de volume (appointmentsMonth, smsQuota) sont SOFT et ne passent jamais par ce
 *  guard, voir `EntitlementsService.checkSoftLimit` appelé directement dans les services. */
export const EnforcesLimit = (limitKey: Extract<LimitKey, 'staffMax' | 'locationsMax'>) =>
  SetMetadata(ENFORCES_LIMIT_KEY, limitKey);
