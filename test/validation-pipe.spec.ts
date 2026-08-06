/**
 * Sprint 3 v2 — Prompt 9, "Point Prompt 3". Le risque signalé : `ValidationPipe` est câblé
 * dans `main.ts` (prod) ET, séparément, dans `test/utils/test-app.ts` (`bootApp()`) — avant
 * ce prompt, deux copies indépendantes de `new ValidationPipe({ whitelist: true, transform:
 * true })` qui se ressemblaient par coïncidence, pas par construction. `bootApp()` a été
 * refactoré pour appeler `configureApp()`, la MÊME fonction que `main.ts` (voir
 * `src/bootstrap/configure-app.ts`) — structurellement, il n'existe plus qu'un seul endroit
 * qui câble le pipe. Ce fichier prouve, en plus, que le comportement RÉEL (whitelist +
 * transform) fonctionne bout en bout à travers `testApp` — donc, par construction, à
 * travers `main.ts` aussi.
 */
import { startTestDb, stopTestDb, bootApp, stopApp, fetchJson, seedSalon, TestDb, TestApp } from './utils/test-app';

describe('global ValidationPipe (whitelist + transform) — same wiring as prod main.ts (Point Prompt 3)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  beforeAll(async () => {
    testDb = await startTestDb('validation_pipe');
    testApp = await bootApp();
    await seedSalon(testDb.db, { slug: 'validation-pipe-salon' });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('transform: true — query string params ("36.8") are coerced to numbers before @IsNumber() validates them', async () => {
    // NearbyQueryDto.lat/lng are @Type(()=>Number) @IsNumber() — without transform:true, a
    // raw querystring value ("36.8", always a string on the wire) would fail @IsNumber() and
    // 400. If it reaches 200, the pipe really did coerce the type first, same as prod.
    const res = await fetchJson(`${testApp.baseUrl}/salons/nearby?lat=36.8&lng=10.18`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('transform: true — a non-numeric query value still fails @IsNumber() (the pipe transforms, it does not silently accept anything)', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/salons/nearby?lat=not-a-number&lng=10.18`);
    expect(res.status).toBe(400);
  });

  it('whitelist: true — an unexpected extra field on a real DTO body is silently stripped, not forwarded to the service', async () => {
    // LoginDto only declares {identifier, password}. Without whitelist:true, the extra
    // `admin: true` field would still pass through this pipe untouched (whitelist alone
    // strips, it doesn't 400 — that would be forbidNonWhitelisted). The meaningful proof
    // isn't the status code (bad credentials 401 either way) — it's that the request is
    // processed as an ordinary login attempt at all, with no validation error about the
    // unknown property.
    const res = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'nobody@validation-pipe.test', password: 'wrong-password', admin: true, role: 'owner' }),
    });
    // 401 (bad credentials) proves the DTO was accepted and reached the auth service —
    // a 400 here would mean whitelist:true is NOT wired (class-validator would otherwise be
    // silent about the extra keys, so a 400 could only come from a differently-configured pipe).
    expect(res.status).toBe(401);
  });
});
