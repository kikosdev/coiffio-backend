/**
 * Sprint 3 v2 — Prompt 9, Delta 4. Rotation symétrique du secret partagé CP↔DP.
 * `InternalAuthGuard` (CP→DP) accepte désormais `CP_SHARED_SECRET` OU
 * `CP_SHARED_SECRET_PREVIOUS` — la preuve : une rotation de secret ne coupe PAS la
 * communication CP→DP tant que l'opérateur n'a pas retiré l'ancien secret de la config.
 * Utilise le webhook `POST /internal/entitlements/invalidate` (déjà derrière
 * `InternalAuthGuard`) comme route d'exercice — n'importe quelle route `/internal/*`
 * aurait fait l'affaire, celle-ci est la plus simple à signer (pas de rawBody complexe).
 */
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  signInternalWithSecret,
  CP_SHARED_SECRET,
  TestDb,
  TestApp,
} from './utils/test-app';

const OLD_SECRET = 'old-secret-before-rotation';
const UNRELATED_SECRET = 'never-configured-anywhere';

describe('InternalAuthGuard — CP_SHARED_SECRET rotation (Delta 4, Sprint 3 v2 Prompt 9)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  beforeAll(async () => {
    testDb = await startTestDb('hmac_rotation');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
    delete process.env.CP_SHARED_SECRET_PREVIOUS;
  });

  afterEach(() => {
    delete process.env.CP_SHARED_SECRET_PREVIOUS;
  });

  async function invalidate(signature: string, timestamp: string, body: string) {
    return fetchJson(`${testApp.baseUrl}/internal/entitlements/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cp-signature': signature, 'x-cp-timestamp': timestamp },
      body,
    });
  }

  it('no rotation in progress: current secret works, an arbitrary old secret does not', async () => {
    const body = JSON.stringify({ tenantId: 'rot-t1' });
    const current = signInternalWithSecret(body, CP_SHARED_SECRET);
    const okRes = await invalidate(current.signature, current.timestamp, body);
    expect(okRes.status).toBe(201);

    const stale = signInternalWithSecret(body, OLD_SECRET);
    const rejected = await invalidate(stale.signature, stale.timestamp, body);
    expect(rejected.status).toBe(401);
  });

  it('rotation window open (CP_SHARED_SECRET_PREVIOUS set): BOTH the new and the old secret are accepted — no communication cut', async () => {
    process.env.CP_SHARED_SECRET_PREVIOUS = OLD_SECRET;
    const body = JSON.stringify({ tenantId: 'rot-t2' });

    // The CP has already rotated and signs with the NEW secret — still works.
    const withNew = signInternalWithSecret(body, CP_SHARED_SECRET);
    const newRes = await invalidate(withNew.signature, withNew.timestamp, body);
    expect(newRes.status).toBe(201);

    // A request signed just before the rotation (still on the OLD secret, e.g. in flight
    // when the CP switched) is STILL accepted — this is the whole point of Delta 4.
    const withOld = signInternalWithSecret(body, OLD_SECRET);
    const oldRes = await invalidate(withOld.signature, withOld.timestamp, body);
    expect(oldRes.status).toBe(201);
  });

  it('rotation window open: a secret that is neither current nor previous is still rejected', async () => {
    process.env.CP_SHARED_SECRET_PREVIOUS = OLD_SECRET;
    const body = JSON.stringify({ tenantId: 'rot-t3' });
    const withUnrelated = signInternalWithSecret(body, UNRELATED_SECRET);
    const res = await invalidate(withUnrelated.signature, withUnrelated.timestamp, body);
    expect(res.status).toBe(401);
  });

  it('rotation window closed (CP_SHARED_SECRET_PREVIOUS removed after the operator confirms): the old secret stops working again', async () => {
    process.env.CP_SHARED_SECRET_PREVIOUS = OLD_SECRET;
    const body = JSON.stringify({ tenantId: 'rot-t4' });
    const duringRotation = signInternalWithSecret(body, OLD_SECRET);
    expect((await invalidate(duringRotation.signature, duringRotation.timestamp, body)).status).toBe(201);

    delete process.env.CP_SHARED_SECRET_PREVIOUS;
    const afterRotation = signInternalWithSecret(body, OLD_SECRET);
    expect((await invalidate(afterRotation.signature, afterRotation.timestamp, body)).status).toBe(401);
  });
});
