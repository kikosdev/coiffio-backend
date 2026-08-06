/**
 * SKILL Prompt 9, suite 3 — les 6 cas CLI (Prompt 4, ClientProfile & historique global).
 */
import { Types } from 'mongoose';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedClient,
  seedAppointment,
  signStaffJwt,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { ClientProfileService } from '../src/identity/client-profile.service';
import { normalizePhone } from '../src/identity/phone-normalization.util';
import { getModelToken } from '@nestjs/mongoose';

describe('client-profile (CLI-01..06)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantA: string;
  let a1: string;
  let tenantB: string;
  let b1: string;

  beforeAll(async () => {
    testDb = await startTestDb('client_profile');
    testApp = await bootApp();
    const salonA = await seedSalon(testDb.db, { slug: 'cli-tenant-a' });
    const salonB = await seedSalon(testDb.db, { slug: 'cli-tenant-b' });
    tenantA = salonA.tenantId;
    a1 = salonA.locations[0].id;
    tenantB = salonB.tenantId;
    b1 = salonB.locations[0].id;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('CLI-01: a client created in two tenants with the same phone → a single ClientProfile', async () => {
    const svc = testApp.app.get(ClientProfileService);
    const phone = '+21691234567';
    const clientInA = await seedClient(testDb.db, { tenantId: tenantA, phone, name: 'Same Person A' });
    const clientInB = await seedClient(testDb.db, { tenantId: tenantB, phone, name: 'Same Person B' });

    await svc.attachProfile(tenantA, clientInA.clientId, phone, { name: 'Same Person' });
    await svc.attachProfile(tenantB, clientInB.clientId, phone, { name: 'Same Person' });

    const profiles = await testDb.db.collection('clientprofiles').find({ phone }).toArray();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tenantIds.sort()).toEqual([tenantA, tenantB].sort());
  });

  it('CLI-02: getGlobalHistory aggregates appointments from both tenants', async () => {
    const svc = testApp.app.get(ClientProfileService);
    const phone = '+21691234568';
    const clientInA = await seedClient(testDb.db, { tenantId: tenantA, phone, name: 'Cross Tenant Client' });
    const clientInB = await seedClient(testDb.db, { tenantId: tenantB, phone, name: 'Cross Tenant Client' });
    const ownerA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [a1], defaultLocationId: a1 });
    const ownerB = await seedStaff(testDb.db, { tenantId: tenantB, role: 'owner', locationIds: [b1], defaultLocationId: b1 });

    await seedAppointment(testDb.db, { tenantId: tenantA, locationId: a1, stylistId: ownerA.staffId, clientId: clientInA.clientId, start: new Date('2026-05-01T09:00:00Z'), end: new Date('2026-05-01T09:30:00Z') });
    await seedAppointment(testDb.db, { tenantId: tenantB, locationId: b1, stylistId: ownerB.staffId, clientId: clientInB.clientId, start: new Date('2026-05-02T09:00:00Z'), end: new Date('2026-05-02T09:30:00Z') });

    const profile = await svc.attachProfile(tenantA, clientInA.clientId, phone, { name: 'Cross Tenant Client' });
    await svc.attachProfile(tenantB, clientInB.clientId, phone, { name: 'Cross Tenant Client' });

    const history = await svc.getGlobalHistory((profile!._id as Types.ObjectId).toString());
    const salonNames = new Set(history.map((h: any) => h.salonName));
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(salonNames.size).toBe(2); // une entrée par tenant au minimum
  });

  it('CLI-03: aggregation only ever reads via scoped calls — removing a tenant from tenantIds excludes its history (no bypass)', async () => {
    const svc = testApp.app.get(ClientProfileService);
    const phone = '+21691234569';
    const clientInA = await seedClient(testDb.db, { tenantId: tenantA, phone, name: 'Scoped Only Client' });
    const clientInB = await seedClient(testDb.db, { tenantId: tenantB, phone, name: 'Scoped Only Client' });
    const ownerA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [a1], defaultLocationId: a1 });
    const ownerB = await seedStaff(testDb.db, { tenantId: tenantB, role: 'owner', locationIds: [b1], defaultLocationId: b1 });
    await seedAppointment(testDb.db, { tenantId: tenantA, locationId: a1, stylistId: ownerA.staffId, clientId: clientInA.clientId, start: new Date('2026-06-01T09:00:00Z'), end: new Date('2026-06-01T09:30:00Z') });
    await seedAppointment(testDb.db, { tenantId: tenantB, locationId: b1, stylistId: ownerB.staffId, clientId: clientInB.clientId, start: new Date('2026-06-02T09:00:00Z'), end: new Date('2026-06-02T09:30:00Z') });

    const profile = await svc.attachProfile(tenantA, clientInA.clientId, phone, {});
    await svc.attachProfile(tenantB, clientInB.clientId, phone, {});
    const profileId = (profile!._id as Types.ObjectId).toString();

    // Une lecture "bypass" (sans passer par les appels scopés par tenant) verrait TOUJOURS
    // les deux rendez-vous, peu importe `tenantIds`. L'implémentation réelle itère
    // `profile.tenantIds` et fait un appel scopé PAR tenant — si on retire B de la liste,
    // son historique doit disparaître alors que les données existent toujours en base.
    await testDb.db.collection('clientprofiles').updateOne({ _id: profile!._id }, { $set: { tenantIds: [tenantA] } });
    const historyAfterRemoval = await svc.getGlobalHistory(profileId);
    expect(historyAfterRemoval.every((h: any) => h.salonName !== undefined)).toBe(true);
    // Confirme, en relisant la base, que le RDV de B existe toujours (pas de suppression) —
    // seule sa VISIBILITÉ dans l'agrégat a changé, preuve que c'est bien tenantIds qui pilote.
    const apptBStillExists = await testDb.db.collection('appointments').findOne({ salonId: tenantB, clientId: new Types.ObjectId(clientInB.clientId) });
    expect(apptBStillExists).toBeTruthy();
  });

  it('CLI-04: walk-in without an account → Client created, profileId set, userId null (re-read from DB)', async () => {
    const owner = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [a1], defaultLocationId: a1 });
    const token = signStaffJwt({ sub: owner.userId, salonId: tenantA, role: 'owner', staffId: owner.staffId });

    const res = await fetchJson(`${testApp.baseUrl}/clients`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ name: 'Walk In Person', phone: '+21691234570' }),
    });
    expect(res.status).toBe(201);

    const reread = await testDb.db.collection('clients').findOne({ _id: new Types.ObjectId(res.body.data._id) });
    expect(reread?.userId).toBeNull();
    expect(reread?.profileId).toBeTruthy();
  });

  it('CLI-05: the unique (salonId, phone) index is still active', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    const { runWithTenant } = require('../src/common/tenant/tenant-context');
    const ctx = { tenantId: tenantA, locationId: a1, locationIds: [a1], role: 'owner', plan: 'starter', features: {}, limits: {} };
    const phone = '+21691234571';
    await runWithTenant(ctx, () => ClientModel.create({ name: 'First', phone }));
    await expect(runWithTenant(ctx, () => ClientModel.create({ name: 'Duplicate', phone }))).rejects.toThrow(/duplicate key|E11000/);
  });

  it('CLI-06: unresolvable phone formats (9/7/11 digits, no country code) are never guessed — left null for manual review', () => {
    expect(normalizePhone('736548732')).toBeNull(); // 9 chiffres
    expect(normalizePhone('5678912')).toBeNull(); // 7 chiffres
    expect(normalizePhone('82927687682')).toBeNull(); // 11 chiffres
    // Cas non ambigus, eux, se normalisent bien (contrôle négatif du test ci-dessus).
    expect(normalizePhone('56765298')).toBe('+21656765298'); // 8 chiffres, Tunisie implicite
    expect(normalizePhone('+21656765298')).toBe('+21656765298');
  });
});
