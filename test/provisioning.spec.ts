/**
 * Prompt 8 (API interne de provisioning), rendu permanent (Prompt 9). Conversion directe de
 * la preuve scratch validée par l'utilisateur : création complète, idempotence, rollback sur
 * échec injecté, HMAC invalide/anti-replay, suspend→402/lecture 200.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  internalHeaders,
  signInternal,
  signStaffJwt,
  authHeader,
  jsonHeaders,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('provisioning (Prompt 8)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  beforeAll(async () => {
    testDb = await startTestDb('provisioning');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function internalPost(path: string, payload: unknown) {
    const bodyStr = JSON.stringify(payload);
    return fetchJson(`${testApp.baseUrl}${path}`, { method: 'POST', headers: internalHeaders(bodyStr), body: bodyStr });
  }

  async function internalPatch(path: string, payload: unknown) {
    const bodyStr = JSON.stringify(payload);
    return fetchJson(`${testApp.baseUrl}${path}`, { method: 'PATCH', headers: internalHeaders(bodyStr), body: bodyStr });
  }

  it('POST /internal/tenants creates salon + primary location + owner + 4 default services + opening hours (re-read from DB)', async () => {
    const tenantId = new ObjectId().toString();
    const dto = {
      tenantId,
      slug: 'prov-suite-1',
      name: 'Provisioning Suite 1',
      timezone: 'Africa/Tunis',
      currency: 'TND',
      region: 'Tunis',
      owner: { name: 'Owner One', email: 'owner1@prov-suite.test', phone: '+21620000001', password: 'password123' },
    };
    const res = await internalPost('/internal/tenants', dto);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data).toMatchObject({ tenantId, slug: 'prov-suite-1' });

    const salon = await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantId) });
    expect(salon).toBeTruthy();
    expect(salon!.businessHours).toHaveLength(7);

    const location = await testDb.db.collection('locations').findOne({ salonId: tenantId, isPrimary: true });
    expect(location).toBeTruthy();
    expect(location!.openingHours).toHaveLength(7);

    const owner = await testDb.db.collection('staffs').findOne({ salonId: tenantId, role: 'owner' });
    expect(owner).toBeTruthy();
    expect(owner!.defaultLocationId).toBe(location!._id.toString());

    const user = await testDb.db.collection('users').findOne({ identifier: 'owner1@prov-suite.test' });
    expect(user?.role).toBe('owner');

    const services = await testDb.db.collection('services').find({ salonId: tenantId }).toArray();
    expect(services.map((s) => s.name).sort()).toEqual(['Barbe', 'Brushing', 'Couleur', 'Coupe']);
  });

  it('replaying the same tenantId is idempotent — no duplicates, same state returned', async () => {
    const tenantId = new ObjectId().toString();
    const dto = {
      tenantId,
      slug: 'prov-suite-2',
      name: 'Provisioning Suite 2',
      owner: { name: 'Owner Two', email: 'owner2@prov-suite.test', phone: '+21620000002', password: 'password123' },
    };
    const first = await internalPost('/internal/tenants', dto);
    const second = await internalPost('/internal/tenants', dto);

    expect(second.status).toBeLessThan(300);
    expect(second.body.data).toEqual(first.body.data);

    const [salonCount, locationCount, staffCount, serviceCount] = await Promise.all([
      testDb.db.collection('salons').countDocuments({ _id: new ObjectId(tenantId) }),
      testDb.db.collection('locations').countDocuments({ salonId: tenantId }),
      testDb.db.collection('staffs').countDocuments({ salonId: tenantId }),
      testDb.db.collection('services').countDocuments({ salonId: tenantId }),
    ]);
    expect({ salonCount, locationCount, staffCount, serviceCount }).toEqual({ salonCount: 1, locationCount: 1, staffCount: 1, serviceCount: 4 });
  });

  it('a failure injected mid-transaction (colliding owner email) rolls back everything — nothing persists', async () => {
    // Pré-condition réaliste : un compte avec cet email existe déjà (créé par un test
    // précédent de cette même suite) — l'écriture `users` échoue APRÈS que salon+location
    // aient déjà été écrits dans la MÊME transaction.
    const existingEmail = 'owner1@prov-suite.test';
    const failingTenantId = new ObjectId().toString();
    const dto = {
      tenantId: failingTenantId,
      slug: 'prov-suite-fail',
      name: 'Should Not Persist',
      owner: { name: 'Colliding Owner', email: existingEmail, phone: '+21620000099', password: 'password123' },
    };
    const res = await internalPost('/internal/tenants', dto);
    // [P1 owner multi-salon] Assert EXACT — cet assert était `>= 400`, ce qui masquait le
    // fait que la collision remontait en 500 (message Mongo brut). Un 500 fait retenter le
    // `dp-client` du CP 4 fois et compte pour son disjoncteur ; un 409 non.
    expect(res.status).toBe(409);
    expect(res.body.statusCode).toBe(409);
    expect(res.body.data?.code).toBe('OWNER_EMAIL_TAKEN');

    const [salon, location, staff, serviceCount] = await Promise.all([
      testDb.db.collection('salons').findOne({ _id: new ObjectId(failingTenantId) }),
      testDb.db.collection('locations').findOne({ salonId: failingTenantId }),
      testDb.db.collection('staffs').findOne({ salonId: failingTenantId }),
      testDb.db.collection('services').countDocuments({ salonId: failingTenantId }),
    ]);
    expect(salon).toBeNull();
    expect(location).toBeNull();
    expect(staff).toBeNull();
    expect(serviceCount).toBe(0);

    const usersWithEmail = await testDb.db.collection('users').countDocuments({ identifier: existingEmail });
    expect(usersWithEmail).toBe(1); // toujours le seul original, aucun doublon
  });

  // [P1 owner multi-salon] Sélectivité du mapping : la conversion E11000 → 409 ne vaut QUE
  // pour `users.identifier`. Un slug déjà pris est une autre collision d'unicité, avec son
  // propre sens — elle ne doit surtout pas être maquillée en OWNER_EMAIL_TAKEN. On n'assert
  // PAS son code de statut exact (le mapper serait un choix de conception à part entière,
  // hors périmètre de ce prompt) — seulement qu'elle n'usurpe pas l'identité du cas email.
  it('une collision sur un AUTRE index unique (slug de salon) n\'est jamais mappée en OWNER_EMAIL_TAKEN', async () => {
    const dto = {
      tenantId: new ObjectId().toString(),
      slug: 'prov-suite-1', // déjà pris par le premier test de cette suite
      name: 'Slug Collision',
      owner: { name: 'Fresh Owner', email: 'fresh-owner@prov-suite.test', phone: '+21620000098', password: 'password123' },
    };
    const res = await internalPost('/internal/tenants', dto);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.data?.code).not.toBe('OWNER_EMAIL_TAKEN');

    // L'email de cet owner était neuf : la transaction ayant échoué sur le slug, aucun user
    // ne doit avoir été créé (confirme au passage que l'échec vient bien du slug, pas d'ailleurs).
    const freshUser = await testDb.db.collection('users').findOne({ identifier: 'fresh-owner@prov-suite.test' });
    expect(freshUser).toBeNull();
  });

  it('invalid HMAC signature → 401, and creates nothing', async () => {
    const tenantId = new ObjectId().toString();
    const dto = { tenantId, slug: 'prov-suite-badsig', name: 'X', owner: { name: 'X', email: 'x@prov-suite.test', phone: '+21600000000', password: 'password123' } };
    const bodyStr = JSON.stringify(dto);
    const res = await fetchJson(`${testApp.baseUrl}/internal/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cp-signature': 'deadbeef'.repeat(8), 'x-cp-timestamp': String(Date.now()) },
      body: bodyStr,
    });
    expect(res.status).toBe(401);
    expect(await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantId) })).toBeNull();
  });

  it('timestamp skewed by 120s (otherwise valid signature) → 401 (anti-replay)', async () => {
    const tenantId = new ObjectId().toString();
    const dto = { tenantId, slug: 'prov-suite-stale', name: 'X', owner: { name: 'X', email: 'stale@prov-suite.test', phone: '+21600000001', password: 'password123' } };
    const bodyStr = JSON.stringify(dto);
    const staleTs = Date.now() - 120_000;
    const { signature } = signInternal(bodyStr, staleTs);
    const res = await fetchJson(`${testApp.baseUrl}/internal/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cp-signature': signature, 'x-cp-timestamp': String(staleTs) },
      body: bodyStr,
    });
    expect(res.status).toBe(401);
  });

  it('PATCH status=suspended blocks mutations (402) but not reads (200); reactivating unblocks', async () => {
    const tenantId = new ObjectId().toString();
    const dto = {
      tenantId,
      slug: 'prov-suite-suspend',
      name: 'Suspend Me',
      owner: { name: 'Owner Suspend', email: 'suspend@prov-suite.test', phone: '+21620000003', password: 'password123' },
    };
    const created = await internalPost('/internal/tenants', dto);
    const { locationId, ownerStaffId } = created.body.data;
    const user = await testDb.db.collection('users').findOne({ identifier: 'suspend@prov-suite.test' });

    const suspendRes = await internalPatch(`/internal/tenants/${tenantId}/status`, { status: 'suspended' });
    expect(suspendRes.status).toBe(200);

    const ownerToken = signStaffJwt({ sub: user!._id.toString(), salonId: tenantId, role: 'owner', staffId: ownerStaffId });

    const readRes = await fetchJson(`${testApp.baseUrl}/locations`, { headers: authHeader(ownerToken) });
    expect(readRes.status).toBe(200);

    const writeRes = await fetchJson(`${testApp.baseUrl}/locations`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ name: 'Secondaire', slug: 'secondaire' }),
    });
    expect(writeRes.status).toBe(402);
    expect(writeRes.body.data?.code).toBe('TENANT_SUSPENDED');

    const reactivateRes = await internalPatch(`/internal/tenants/${tenantId}/status`, { status: 'active' });
    expect(reactivateRes.status).toBe(200);

    const writeAfterRes = await fetchJson(`${testApp.baseUrl}/locations`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ name: 'Tertiaire', slug: 'tertiaire' }),
    });
    expect(writeAfterRes.status).toBe(201);
    void locationId;
  });

  it('GET usage includes lastAppointmentCreatedAt (the churn signal) and real staff/location counts', async () => {
    const tenantId = new ObjectId().toString();
    const dto = { tenantId, slug: 'prov-suite-usage', name: 'Usage', owner: { name: 'Owner Usage', email: 'usage@prov-suite.test', phone: '+21620000004', password: 'password123' } };
    await internalPost('/internal/tenants', dto);

    const usageSig = signInternal('{}');
    const usageRes = await fetchJson(`${testApp.baseUrl}/internal/tenants/${tenantId}/usage`, {
      headers: { 'x-cp-signature': usageSig.signature, 'x-cp-timestamp': usageSig.timestamp },
    });
    expect(usageRes.status).toBe(200);
    expect(usageRes.body.data).toMatchObject({ staffCount: 1, locationCount: 1 });
    expect('lastAppointmentCreatedAt' in usageRes.body.data).toBe(true);
  });
});
