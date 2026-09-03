import { Injectable } from '@nestjs/common';
import { MemoryCache } from '../common/utils/memory-cache.util';

/**
 * Instance PARTAGÉE du cache discovery (SKILL_discovery_enrichment_sponsored, Prompt 6,
 * Partie A) — extrait de `DiscoveryService` (qui instanciait son propre `MemoryCache`
 * privé) pour qu'`InternalService.updateSponsorship()` puisse invalider les mêmes clés
 * après écriture, sans que `InternalModule` ait besoin d'importer tout `DiscoveryModule`
 * (qui tire `BookingModule` et les schémas Location/Service/Testimonial/Staff).
 */
@Injectable()
export class DiscoveryCacheService extends MemoryCache {}
