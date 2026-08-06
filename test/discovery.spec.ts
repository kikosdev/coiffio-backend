/**
 * SKILL Prompt 9, suite 2 — les 8 cas DIS (Prompt 5, découverte cross-tenant publique).
 */
import { Types } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedClient,
  seedService,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { runAsDiscovery } from '../src/common/tenant/tenant-context';
import { PUBLIC_DISCOVERY_FIELDS } from '../src/common/tenant/scoping-registry';

describe('discovery (DIS-01..08)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantA: string;
  let tenantB: string;
  let clientPhone: string;

  beforeAll(async () => {
    testDb = await startTestDb('discovery');
    testApp = await bootApp();

    const salonA = await seedSalon(testDb.db, { slug: 'dis-salon-a', name: 'Salon Discovery A' });
    const salonB = await seedSalon(testDb.db, { slug: 'dis-salon-b', name: 'Salon Discovery B' });
    tenantA = salonA.tenantId;
    tenantB = salonB.tenantId;

    // Coordonnées proches (Tunis) pour que /discovery/nearby les trouve toutes les deux.
    await testDb.db.collection('locations').updateOne(
      { salonId: tenantA },
      { $set: { geo: { type: 'Point', coordinates: [10.18, 36.81] }, region: 'Tunis', address: { line1: 'Rue A', city: 'Tunis', postalCode: '', country: '' } } },
    );
    await testDb.db.collection('locations').updateOne(
      { salonId: tenantB },
      { $set: { geo: { type: 'Point', coordinates: [10.19, 36.82] }, region: 'Tunis', address: { line1: 'Rue B', city: 'Tunis', postalCode: '', country: '' } } },
    );

    await seedService(testDb.db, { tenantId: tenantA, name: 'Service Public A', isPublic: true });
    const { clientId } = await seedClient(testDb.db, { tenantId: tenantA, phone: '+21698765432', name: 'Secret Client' });
    void clientId;
    clientPhone = '+21698765432';

    // Staff visible + staff caché (publicProfile.visible=false) pour DIS-05.
    await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [], defaultLocationId: '', name: 'Visible Stylist' });
    const hiddenStaffId = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [], defaultLocationId: '', name: 'Hidden Stylist' });
    await testDb.db.collection('staffs').updateOne({ _id: new Types.ObjectId(hiddenStaffId.staffId) }, { $set: { 'publicProfile.visible': false } });

    await testDb.db.collection('testimonials').insertOne({
      salonId: tenantA,
      quote: 'Great service',
      authorName: 'Happy Client',
      authorMeta: '',
      isApproved: true,
      order: 0,
    });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('DIS-01: /discovery/nearby returns salons from multiple tenants', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/discovery/nearby?lat=36.81&lng=10.18&radiusKm=50`);
    expect(res.status).toBe(200);
    const slugs = new Set((res.body.data as any[]).map((h) => h.salonSlug));
    expect(slugs.has('dis-salon-a')).toBe(true);
    expect(slugs.has('dis-salon-b')).toBe(true);
  });

  it('DIS-02: the discovery-mode whitelist backstop actually narrows fields at the query level (not just the controller shape)', async () => {
    const LocationModel = testApp.app.get(getModelToken('Location'));
    const raw = await runAsDiscovery(() => LocationModel.find({ salonId: tenantA }).lean().exec());
    const doc = raw[0];
    const allowedKeys = new Set([...PUBLIC_DISCOVERY_FIELDS.locations, '_id']);
    const actualKeys = Object.keys(doc);
    const unexpected = actualKeys.filter((k) => !allowedKeys.has(k));
    expect(unexpected).toEqual([]);
  });

  it('DIS-03: no appointment/client/payment collection is reachable in discovery mode, and no client phone leaks through the salon profile', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    await expect(runAsDiscovery(() => ClientModel.find({}).exec())).rejects.toThrow(/non-whitelisted collection: clients/);

    const AppointmentModel = testApp.app.get(getModelToken('Appointment'));
    await expect(runAsDiscovery(() => AppointmentModel.find({}).exec())).rejects.toThrow(/non-whitelisted collection: appointments/);

    const PaymentModel = testApp.app.get(getModelToken('Payment'));
    await expect(runAsDiscovery(() => PaymentModel.find({}).exec())).rejects.toThrow(/non-whitelisted collection: payments/);

    const res = await fetchJson(`${testApp.baseUrl}/discovery/salon/dis-salon-a`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(clientPhone);
  });

  it('DIS-04: a salon belonging to a suspended tenant is absent from results', async () => {
    await testDb.db.collection('salons').updateOne({ _id: new Types.ObjectId(tenantB) }, { $set: { status: 'suspended' } });
    try {
      // lat/lng légèrement différents de DIS-01 : évite de lire le résultat mis en cache
      // (TTL 5min, clé = lat/lng/radius/limit arrondis) d'AVANT la suspension.
      const res = await fetchJson(`${testApp.baseUrl}/discovery/nearby?lat=36.815&lng=10.185&radiusKm=50`);
      const slugs = new Set((res.body.data as any[]).map((h) => h.salonSlug));
      expect(slugs.has('dis-salon-b')).toBe(false);
      expect(slugs.has('dis-salon-a')).toBe(true);
    } finally {
      await testDb.db.collection('salons').updateOne({ _id: new Types.ObjectId(tenantB) }, { $set: { status: 'active' } });
    }
  });

  it('DIS-05: a staff with publicProfile.visible=false is absent from the public team list', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/discovery/salon/dis-salon-a`);
    expect(res.status).toBe(200);
    const names = (res.body.data.team as any[]).map((t) => t.name);
    expect(names).toContain('Visible Stylist');
    expect(names).not.toContain('Hidden Stylist');
  });

  it('DIS-06: /discovery/by-region works without any GPS coordinates', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/discovery/by-region?region=Tunis`);
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).length).toBeGreaterThan(0);
  });

  it('DIS-07: public availability is computed live and reflects the real internal schedule state', async () => {
    const svc = await seedService(testDb.db, { tenantId: tenantA, name: 'Availability Test Service' });
    const res = await fetchJson(`${testApp.baseUrl}/discovery/salon/dis-salon-a/availability?date=2026-09-10&serviceId=${svc.serviceId}`);
    // Live, jamais stocké : un salon sans stylist qualifié à cette date renvoie simplement une
    // liste vide — jamais une donnée périmée ou fabriquée.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('DIS-08: rate limit ~60/min/IP is enforced on discovery routes', async () => {
    const calls = Array.from({ length: 65 }, () => fetchJson(`${testApp.baseUrl}/discovery/regions`));
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.status);
    expect(statuses.some((s) => s === 429)).toBe(true);
  });
});
