/**
 * SKILL Prompt 9, suite 1 — les 15 cas ISO. RÈGLE explicite de l'utilisateur : tout test
 * d'écriture RELIT depuis la base (driver natif `testDb.db`), jamais l'objet retourné par
 * Mongoose — c'est précisément ce qui avait masqué le bug locationId au Prompt 3.
 *
 * Fixtures : tenant A (locations A1, A2), tenant B (location B1), données dans chacune.
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
  seedAppointment,
  signStaffJwt,
  signClientJwt,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { runWithTenant, runAsGuest, TenantContext, getTenantContext } from '../src/common/tenant/tenant-context';
import { assertRegistryCoverage } from '../src/common/tenant/scoping-registry';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationsGateway } from '../src/notifications/notifications.gateway';
import { ClientProfileService } from '../src/identity/client-profile.service';

describe('tenant-isolation (ISO-01..14)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  let tenantA: string;
  let a1: string;
  let a2: string;
  let tenantB: string;
  let b1: string;

  let ownerA: { staffId: string; userId: string };
  let ownerAToken: string;
  let stylistA1Only: { staffId: string; userId: string };
  let clientA1: string;
  let serviceA: string;

  // Partie 3 (durcissement post-Sprint-1-v2) : un client identifié par le MÊME téléphone
  // dans A et B, lié via ClientProfile.tenantIds — RDV dans les deux tenants.
  let crossClientToken: string;
  let crossApptBId: string;

  function ctxFor(tenantId: string, locationId: string, locationIds: string[], role: TenantContext['role'] = 'owner'): TenantContext {
    return { tenantId, locationId, locationIds, role, plan: 'starter', features: {}, limits: {} };
  }

  beforeAll(async () => {
    testDb = await startTestDb('tenant_isolation');
    testApp = await bootApp();

    const salonA = await seedSalon(testDb.db, { slug: 'iso-tenant-a', locationSlugs: ['a1', 'a2'] });
    tenantA = salonA.tenantId;
    a1 = salonA.locations[0].id;
    a2 = salonA.locations[1].id;

    const salonB = await seedSalon(testDb.db, { slug: 'iso-tenant-b', locationSlugs: ['b1'] });
    tenantB = salonB.tenantId;
    b1 = salonB.locations[0].id;

    ownerA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [a1, a2], defaultLocationId: a1 });
    ownerAToken = signStaffJwt({ sub: ownerA.userId, salonId: tenantA, role: 'owner', staffId: ownerA.staffId });
    stylistA1Only = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [a1], defaultLocationId: a1 });
    await seedStaff(testDb.db, { tenantId: tenantB, role: 'owner', locationIds: [b1], defaultLocationId: b1 });

    const cA1 = await seedClient(testDb.db, { tenantId: tenantA, phone: '+21620000101', name: 'Client A1' });
    clientA1 = cA1.clientId;
    await seedClient(testDb.db, { tenantId: tenantB, phone: '+21620000102', name: 'Client B' });

    const svcA = await seedService(testDb.db, { tenantId: tenantA, name: 'Service A' });
    serviceA = svcA.serviceId;
    await seedService(testDb.db, { tenantId: tenantB, name: 'Service B' });

    await seedAppointment(testDb.db, {
      tenantId: tenantA,
      locationId: a1,
      stylistId: ownerA.staffId,
      clientId: clientA1,
      start: new Date('2026-09-01T09:00:00.000Z'),
      end: new Date('2026-09-01T09:30:00.000Z'),
    });
    await seedAppointment(testDb.db, {
      tenantId: tenantA,
      locationId: a2,
      stylistId: ownerA.staffId,
      clientId: clientA1,
      start: new Date('2026-09-01T10:00:00.000Z'),
      end: new Date('2026-09-01T10:30:00.000Z'),
    });

    // Partie 3 : client cross-tenant (même téléphone/userId, un Client par tenant, liés via
    // ClientProfile.tenantIds — même mécanisme que ClientProfileService.getGlobalHistory).
    const crossPhone = '+21620000999';
    const crossUserId = new Types.ObjectId().toString();
    const stylistB = await seedStaff(testDb.db, { tenantId: tenantB, role: 'stylist', locationIds: [b1], defaultLocationId: b1 });
    const crossClientA = await seedClient(testDb.db, { tenantId: tenantA, phone: crossPhone, name: 'Cross Client', userId: crossUserId });
    const crossClientB = await seedClient(testDb.db, { tenantId: tenantB, phone: crossPhone, name: 'Cross Client', userId: crossUserId });

    const clientProfiles = testApp.app.get(ClientProfileService);
    await clientProfiles.attachProfile(tenantA, crossClientA.clientId, crossPhone, { name: 'Cross Client', userId: crossUserId });
    await clientProfiles.attachProfile(tenantB, crossClientB.clientId, crossPhone, { name: 'Cross Client', userId: crossUserId });

    await seedAppointment(testDb.db, {
      tenantId: tenantA,
      locationId: a1,
      stylistId: ownerA.staffId,
      clientId: crossClientA.clientId,
      start: new Date('2026-09-05T09:00:00.000Z'),
      end: new Date('2026-09-05T09:30:00.000Z'),
    });
    const apptB = await seedAppointment(testDb.db, {
      tenantId: tenantB,
      locationId: b1,
      stylistId: stylistB.staffId,
      clientId: crossClientB.clientId,
      start: new Date('2026-09-06T09:00:00.000Z'),
      end: new Date('2026-09-06T09:30:00.000Z'),
    });
    crossApptBId = apptB.appointmentId;

    crossClientToken = signClientJwt({ sub: crossUserId, salonId: tenantA, clientId: crossClientA.clientId });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('ISO-01: a query on a scoped collection with no TenantContext throws', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    await expect(ClientModel.find({}).exec()).rejects.toThrow(/No tenant context available/);
  });

  it('ISO-02: owner A listing each scoped collection sees 0 documents from tenant B', async () => {
    const [clientsRes, servicesRes, teamRes] = await Promise.all([
      fetchJson(`${testApp.baseUrl}/clients`, { headers: authHeader(ownerAToken) }),
      fetchJson(`${testApp.baseUrl}/services`, { headers: authHeader(ownerAToken) }),
      fetchJson(`${testApp.baseUrl}/team`, { headers: authHeader(ownerAToken) }),
    ]);
    expect(clientsRes.status).toBe(200);
    expect((clientsRes.body.data as any[]).some((c) => c.name === 'Client B')).toBe(false);
    expect(servicesRes.status).toBe(200);
    expect((servicesRes.body.data as any[]).some((s) => s.name === 'Service B')).toBe(false);
    expect(teamRes.status).toBe(200);
    expect((teamRes.body.data as any[]).every((s) => s.name !== undefined)).toBe(true);
  });

  it('ISO-03: a filter forged with { salonId: B } from context A throws ForbiddenException', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    await expect(
      runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () => ClientModel.find({ salonId: tenantB }).exec()),
    ).rejects.toThrow(/Cross-tenant query blocked/);
  });

  it('ISO-04: header X-Location-Id = B1 from context A → 403', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/locations`, {
      headers: { ...authHeader(ownerAToken), 'x-location-id': b1 },
    });
    expect(res.status).toBe(403);
    expect(res.body.data?.code ?? res.body.message).toBeTruthy();
  });

  it('ISO-05: context A + locationId A1 → no A2 data in LOCATION_SCOPED collections', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/appointments?date=2026-09-01`, {
      headers: { ...authHeader(ownerAToken), 'x-location-id': a1 },
    });
    expect(res.status).toBe(200);
    const starts = (res.body.data as any[]).map((a) => new Date(a.start).toISOString());
    expect(starts).toContain('2026-09-01T09:00:00.000Z'); // A1's appointment
    expect(starts).not.toContain('2026-09-01T10:00:00.000Z'); // A2's appointment, must be absent
  });

  it('ISO-06: context A + locationId A1 → clients and services from A2 are still VISIBLE (tenant scope, not location)', async () => {
    // clients/services ne portent pas de locationId — scopés au tenant entier, jamais filtrés
    // par la location active. Le seul client de A a été créé sans notion de location.
    const res = await fetchJson(`${testApp.baseUrl}/clients`, {
      headers: { ...authHeader(ownerAToken), 'x-location-id': a1 },
    });
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).some((c) => c.name === 'Client A1')).toBe(true);
  });

  it('ISO-07: create without an explicit salonId → salonId and locationId are injected (re-read from DB)', async () => {
    const ServiceModel = testApp.app.get(getModelToken('Service'));
    const created = await runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () =>
      ServiceModel.create({ name: 'Injected Service', price: 10, durationMin: 15 }),
    );
    const reread = await testDb.db.collection('services').findOne({ _id: new Types.ObjectId(created._id.toString()) });
    expect(reread?.salonId).toBe(tenantA);

    const ScheduleModel = testApp.app.get(getModelToken('Schedule'));
    const createdSchedule = await runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () =>
      ScheduleModel.create({ stylistId: new Types.ObjectId(ownerA.staffId), weekly: [], overrides: [] }),
    );
    const rereadSchedule = await testDb.db.collection('schedules').findOne({ _id: new Types.ObjectId(createdSchedule._id.toString()) });
    expect(rereadSchedule?.salonId).toBe(tenantA);
    expect(rereadSchedule?.locationId).toBe(a1); // LOCATION_SCOPED : locationId aussi injecté
  });

  it('ISO-08: create with salonId = B forced in the body → ForbiddenException, nothing persists', async () => {
    const ServiceModel = testApp.app.get(getModelToken('Service'));
    await expect(
      runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () =>
        ServiceModel.create({ name: 'Should Not Persist', price: 10, durationMin: 15, salonId: tenantB }),
      ),
    ).rejects.toThrow(/Cross-tenant write blocked/);
    const leaked = await testDb.db.collection('services').findOne({ name: 'Should Not Persist' });
    expect(leaked).toBeNull();
  });

  it('ISO-09: aggregate without $match → a scope stage is injected at the front', async () => {
    const ServiceModel = testApp.app.get(getModelToken('Service'));
    const rows = await runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () =>
      ServiceModel.aggregate([{ $count: 'n' }]).exec(),
    );
    // Sans injection de scope, ce count porterait sur TOUTES les collections services (A+B).
    // Avec injection, il ne doit compter que les services du tenant A.
    const realCountA = await testDb.db.collection('services').countDocuments({ salonId: tenantA });
    expect(rows[0]?.n ?? 0).toBe(realCountA);
  });

  it('ISO-10: salonId passed as a Types.ObjectId in a filter → InternalServerErrorException (Invariant #1)', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    await expect(
      runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () => ClientModel.find({ salonId: new Types.ObjectId(tenantA) }).exec()),
    ).rejects.toThrow(/must be a plain string|salonId/i);
  });

  it('ISO-11: a stylist attached to A1 only is invisible in A2 availability', async () => {
    const res = await fetchJson(
      `${testApp.baseUrl}/iso-tenant-a/availability?date=2026-09-02&locationId=${a2}&serviceId=${serviceA}`,
    );
    expect(res.status).toBe(200);
    const stylistIds = (res.body.data as any[]).map((s) => s.stylistId);
    expect(stylistIds).not.toContain(stylistA1Only.staffId);
  });

  it('ISO-12: a notification dispatched on A only targets room salon:{A}, never B', async () => {
    const gateway = testApp.app.get(NotificationsGateway);
    const notifications = testApp.app.get(NotificationsService);
    const spy = jest.spyOn(gateway, 'emitToRoom').mockImplementation(() => {});

    await runWithTenant(ctxFor(tenantA, a1, [a1, a2]), () =>
      notifications.dispatch({ salonId: tenantA, role: 'owner', broadcast: true, type: 'test.event', title: 'x', body: 'y' }),
    );

    const roomsUsed = spy.mock.calls.map((call) => call[0]);
    expect(roomsUsed).toContain(`salon:${tenantA}`);
    expect(roomsUsed).not.toContain(`salon:${tenantB}`);
    expect(roomsUsed.some((room) => room.includes(tenantB))).toBe(false);
    spy.mockRestore();
  });

  it('ISO-13: a suspended tenant → GET 200, POST/PATCH/DELETE 402', async () => {
    await testDb.db.collection('salons').updateOne({ _id: new Types.ObjectId(tenantA) }, { $set: { status: 'suspended' } });
    try {
      const readRes = await fetchJson(`${testApp.baseUrl}/locations`, { headers: authHeader(ownerAToken) });
      expect(readRes.status).toBe(200);

      const writeRes = await fetchJson(`${testApp.baseUrl}/locations`, {
        method: 'POST',
        headers: { ...authHeader(ownerAToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X', slug: 'x-suspended' }),
      });
      expect(writeRes.status).toBe(402);
    } finally {
      await testDb.db.collection('salons').updateOne({ _id: new Types.ObjectId(tenantA) }, { $set: { status: 'active' } });
    }
  });

  it('ISO-14: assertRegistryCoverage throws if a model is in no scope list', () => {
    expect(() => assertRegistryCoverage(['clients', 'services', 'a_future_unclassified_collection'])).toThrow(
      /a_future_unclassified_collection/,
    );
  });

  it('bonus: getTenantContext() itself throws outside any boundary (sanity check underlying ISO-01)', () => {
    expect(() => getTenantContext()).toThrow(/No tenant context available/);
  });

  // ── Durcissement post-Sprint-1-v2 Partie 1 (trou trouvé au Prompt 6, fermé avant Sprint 2)
  // : whitelist structurelle GUEST_READABLE, même principe que le WeakSet `isDiscoveryContext`
  // du Prompt 5.

  it('GUEST-01: a runAsGuest context reading a non-whitelisted collection (clients) throws structurally', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    await expect(runAsGuest(tenantA, a1, () => ClientModel.find({}).exec())).rejects.toThrow(
      /Guest mode cannot read non-whitelisted collection: clients/,
    );
  });

  it('GUEST-02: a runAsGuest context CAN read a whitelisted collection (services), still scoped to its own tenant', async () => {
    const ServiceModel = testApp.app.get(getModelToken('Service'));
    const rows = await runAsGuest(tenantA, a1, () => ServiceModel.find({}).exec());
    expect(rows.length).toBeGreaterThan(0);
    expect((rows as any[]).every((r) => r.salonId === tenantA)).toBe(true);
  });

  it('GUEST-03: a hand-built context with role:"guest" (never posed via runAsGuest) is NOT treated as guest — the WeakSet mark cannot be forged from outside', async () => {
    const ClientModel = testApp.app.get(getModelToken('Client'));
    // Objet littéral portant role:'guest' — PAS dans le WeakSet privé `guestContexts` (seul
    // runAsGuest() y ajoute). Le plugin ne le traite donc pas comme guest : pas de whitelist
    // GUEST_READABLE appliquée, juste le scope tenant normal — qui laisse passer `clients`
    // pour ce tenant, exactement comme le ferait n'importe quel autre rôle.
    const forged: TenantContext = { tenantId: tenantA, locationId: a1, locationIds: [a1, a2], role: 'guest', plan: 'starter', features: {}, limits: {} };
    const rows = await runWithTenant(forged, () => ClientModel.find({}).exec());
    expect((rows as any[]).length).toBeGreaterThan(0);
  });

  // GUEST-04 — élargissement de GUEST_READABLE à staffs/staffprofiles/schedules (dispo
  // publique) : la LECTURE de la collection est autorisée, mais les CHAMPS sensibles ne
  // doivent jamais en sortir. pinHash/pinAttempts/pinLockedUntil ont select:false au niveau
  // du schéma (protection structurelle, indépendante du contexte) — vérifié ici. baseRate/
  // commissionPct (paie, StaffProfile) n'ont PAS select:false — protégés uniquement par la
  // projection défensive ajoutée dans `loadStylistContext()` (`.select('name week')` /
  // `.select('userId capabilities level')`), même principe que CATALOG_PUBLIC_FIELDS
  // (Partie 2) : un backstop à la lecture, pas une confiance aveugle dans la forme de sortie.
  it('GUEST-04: public availability queries staffs/staffprofiles with a defensive projection — pinHash/pinAttempts/baseRate/commissionPct never load', async () => {
    await testDb.db.collection('staffs').updateOne(
      { _id: new Types.ObjectId(stylistA1Only.staffId) },
      { $set: { pinHash: 'should-never-load', pinAttempts: 3, pinLockedUntil: new Date() } },
    );
    await testDb.db.collection('staffprofiles').insertOne({
      salonId: tenantA,
      userId: new Types.ObjectId(stylistA1Only.staffId),
      level: 'senior',
      capabilities: [],
      baseRate: 999,
      commissionPct: 50,
      isPublicOnLanding: true,
      publicTitle: '',
      seniorityTag: 'Senior',
      landingOrder: 0,
    });

    // Même forme de requête que `BookingService.loadStylistContext()` (privée, non testable
    // directement) — vérifie la projection au niveau où elle compte réellement : le document
    // chargé en mémoire serveur, pas seulement la forme de sortie du contrôleur.
    const StaffModel = testApp.app.get(getModelToken('Staff'));
    const StaffProfileModel = testApp.app.get(getModelToken('StaffProfile'));
    const staffDocs = await runAsGuest(tenantA, a1, () =>
      StaffModel.find({ _id: stylistA1Only.staffId }).select('name week').exec(),
    );
    const profileDocs = await runAsGuest(tenantA, a1, () =>
      StaffProfileModel.find({}).select('userId capabilities level').exec(),
    );

    const staffDoc = staffDocs[0] as any;
    expect(staffDoc.pinHash).toBeUndefined();
    expect(staffDoc.pinAttempts).toBeUndefined();
    expect(staffDoc.pinLockedUntil).toBeUndefined();

    const profileDoc = (profileDocs as any[]).find((p) => p.userId.toString() === stylistA1Only.staffId);
    expect(profileDoc).toBeDefined();
    expect(profileDoc.baseRate).toBeUndefined();
    expect(profileDoc.commissionPct).toBeUndefined();
    expect(profileDoc.level).toBe('senior'); // toujours présent — nécessaire à l'affichage

    // Bout en bout : la vraie route publique ne les recopie évidemment pas non plus.
    const res = await fetchJson(`${testApp.baseUrl}/iso-tenant-a/availability?date=2026-09-02&locationId=${a1}&serviceId=${serviceA}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('should-never-load');
    expect(body).not.toContain('999');
  });

  // ── Durcissement post-Sprint-1-v2 Partie 3 (trou trouvé au Prompt 6b, fermé avant Sprint 2)
  // : listMine()/cancel() réécrits sur le pattern getGlobalHistory — tenants résolus via
  // ClientProfile.tenantIds, appels scopés par tenant, jamais un bypass.

  it('CROSS-01: listMine() aggregates appointments across BOTH tenants for a client with a linked ClientProfile', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/appointments/mine?scope=upcoming`, { headers: authHeader(crossClientToken) });
    expect(res.status).toBe(200);
    const salonIds = (res.body.data as any[]).map((a) => a.salonId);
    expect(salonIds).toContain(tenantA);
    expect(salonIds).toContain(tenantB);
  });

  it('CROSS-02: cancel() finds and cancels an appointment living in a DIFFERENT tenant than the current :salonSlug (scoped search, no bypass), re-read from DB', async () => {
    // Requête faite via le slug de A (:salonSlug résout un contexte guest tenantA), mais le
    // RDV visé (crossApptBId) vit dans B — doit être trouvé via ClientProfile.tenantIds.
    const res = await fetchJson(`${testApp.baseUrl}/iso-tenant-a/appointments/${crossApptBId}/cancel`, {
      method: 'PATCH',
      headers: { ...authHeader(crossClientToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);

    const reread = await testDb.db.collection('appointments').findOne({ _id: new Types.ObjectId(crossApptBId) });
    expect(reread?.status).toBe('cancelled');
    expect(reread?.salonId).toBe(tenantB); // toujours dans SON tenant, jamais migré vers A

    // `cancel()` dispatch aussi APPOINTMENT_CANCELLED en fire-and-forget (`void`) — même
    // raison que les tests storefront-guest : laisse-le se terminer avant `afterAll`.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
