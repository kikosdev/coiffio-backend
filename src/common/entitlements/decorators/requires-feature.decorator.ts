import { SetMetadata } from '@nestjs/common';
import { Feature } from '../entitlements.types';

export const REQUIRES_FEATURE_KEY = 'requiresFeature';

/** Déclare la feature requise sur un handler/contrôleur. Usage : `@RequiresFeature('pos')`. */
export const RequiresFeature = (feature: Feature) => SetMetadata(REQUIRES_FEATURE_KEY, feature);
