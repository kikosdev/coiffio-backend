import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

/**
 * [Sprint 3 v2, Prompt 9] Câblage global (préfixe, cookies, validation, enveloppe, filtre
 * d'erreurs) extrait de `main.ts` pour être appelé aussi bien par le boot de PROD que par
 * `test/utils/test-app.ts` (`bootApp()`). Avant ce prompt, les deux endroits dupliquaient
 * indépendamment `new ValidationPipe({ whitelist: true, transform: true })` — les deux
 * étaient identiques par coïncidence, pas par construction : rien n'empêchait `main.ts` de
 * dériver sans que les tests (qui passeraient quand même, sur LEUR propre copie) ne le
 * révèlent jamais. Un seul point de câblage supprime structurellement ce risque de dérive
 * silencieuse. CORS et Swagger restent dans `main.ts` seul — jamais exercés par les tests
 * d'intégration (pas de test contre une vraie origine cross-site), donc rien à dupliquer.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
}
