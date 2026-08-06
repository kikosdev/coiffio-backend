/**
 * Sprint 2 v2 — Prompt 7 (consolidation). Prouve `src/scripts/migrate-create-memberships.ts`
 * (Prompt 1) de façon permanente — jusqu'ici seulement prouvé via des scripts jetables sur
 * `multitenant`.
 *
 * Le script était initialement un CLI autonome pur (`main()` exécuté au top-level du module),
 * donc pas importable tel quel. Plutôt que de le spawn en sous-processus contre le même
 * `mongodb-memory-server` (essayé en premier : source d'une flakiness de connexion non
 * déterministe, diagnostiquée en profondeur côté OS Windows — plusieurs heures de cette
 * session, jamais résolue de façon fiable même avec retry borné), le script a été refactoré :
 * `assertSafeTarget()` (garde-fou prod) et `runMigration()` (cœur métier) sont désormais
 * exportés séparément de `main()` (qui ne s'auto-exécute plus que via `require.main === module`).
 * Ce test les appelle directement, en-process, sur l'app Nest déjà bootée par `bootApp()` —
 * la même app que le reste de la suite d'intégration utilise, contre le même replset en
 * mémoire, sans jamais ouvrir de connexion Mongo séparée.
 */
import { ObjectId } from 'mongodb';
import { startTestDb, stopTestDb, bootApp, stopApp, TestDb, TestApp } from './utils/test-app';
import { assertSafeTarget, runMigration, ReportRow } from '../src/scripts/migrate-create-memberships';

function summarize(report: ReportRow[], phase: 'staff' | 'client') {
  return {
    created: report.filter((r) => r.phase === phase && r.action === 'created').length,
    skipped: report.filter((r) => r.phase === phase && r.action === 'skipped').length,
  };
}

describe('migration-memberships (Sprint 2 v2 Prompt 1, prouvé en Prompt 7)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  const salonId = new ObjectId().toString();
  const locationId = new ObjectId();
  let ownerStaffId: ObjectId;
  let stylistStaffId: ObjectId;
  let stylistUserId: ObjectId;
  let clientWithUserId: ObjectId;
  let clientUserId: ObjectId;
  let walkInClientId: ObjectId;

  beforeAll(async () => {
    testDb = await startTestDb('migration_memberships');
    testApp = await bootApp();

    await testDb.db.collection('salons').insertOne({ _id: new ObjectId(salonId), name: 'Migration Salon', slug: 'migration-salon', status: 'active' });
    await testDb.db.collection('locations').insertOne({ _id: locationId, salonId, name: 'Principal', slug: 'principal', isPrimary: true, active: true });

    // Staff owner + staff STYLIST (non-owner — role à prouver = staffs.role, jamais
    // users.role, qui est un bucket générique délibérément DIFFÉRENT ici).
    const ownerUserId = new ObjectId();
    ownerStaffId = new ObjectId();
    await testDb.db.collection('users').insertOne({ _id: ownerUserId, identifier: 'mig-owner@test.local', identifierType: 'email', passwordHash: 'x', role: 'owner', isActive: true });
    await testDb.db.collection('staffs').insertOne({
      _id: ownerStaffId, salonId, userId: ownerUserId, name: 'Migration Owner', email: 'mig-owner@test.local', phone: '',
      role: 'owner', color: '#000', isActive: true, locationIds: [locationId.toString()], defaultLocationId: locationId.toString(),
      acceptingBookings: true, posEnabled: false, publicProfile: { visible: true, order: 0 },
    });

    stylistUserId = new ObjectId();
    stylistStaffId = new ObjectId();
    await testDb.db.collection('users').insertOne({ _id: stylistUserId, identifier: 'mig-stylist@test.local', identifierType: 'email', passwordHash: 'x', role: 'staff', isActive: true });
    await testDb.db.collection('staffs').insertOne({
      _id: stylistStaffId, salonId, userId: stylistUserId, name: 'Migration Stylist', email: 'mig-stylist@test.local', phone: '',
      role: 'stylist', color: '#000', isActive: true, locationIds: [locationId.toString()], defaultLocationId: locationId.toString(),
      acceptingBookings: true, posEnabled: false, publicProfile: { visible: true, order: 0 },
    });

    // Client AVEC userId (Phase 2 doit créer un Membership) + client walk-in SANS userId
    // (doit être ignoré — filtré par le script lui-même, `userId: {$ne: null}`).
    clientUserId = new ObjectId();
    clientWithUserId = new ObjectId();
    await testDb.db.collection('users').insertOne({ _id: clientUserId, identifier: 'mig-client@test.local', identifierType: 'email', passwordHash: 'x', role: 'client', isActive: true });
    await testDb.db.collection('clients').insertOne({
      _id: clientWithUserId, salonId, userId: clientUserId, name: 'Migration Client', phone: '+21620800001', email: '', commsConsent: true, preferredChannel: 'email', notes: '', history: [],
    });
    walkInClientId = new ObjectId();
    await testDb.db.collection('clients').insertOne({
      _id: walkInClientId, salonId, userId: null, name: 'Walk-in Client', phone: '+21620800002', email: '', commsConsent: true, preferredChannel: 'email', notes: '', history: [],
    });
  }, 60_000);

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('dry-run (apply=false) → 0 écriture', async () => {
    const report = await runMigration(testApp.app, false);
    expect(report.length).toBeGreaterThan(0);
    const count = await testDb.db.collection('memberships').countDocuments();
    expect(count).toBe(0);
  }, 30_000);

  it('refuse de tourner si MONGO_URI cible une base nommée "salonos" (même en mémoire, garde-fou testé sans toucher au vrai prod)', () => {
    const salonosUri = testDb.replSet.getUri('salonos');
    expect(() => assertSafeTarget(salonosUri)).toThrow(/salonos/i);
    // Sanity : la vraie cible de ce test (multitenant en mémoire) ne déclenche pas le refus.
    expect(() => assertSafeTarget(process.env.MONGO_URI ?? '')).not.toThrow();
  });

  it('--apply → 1 Membership par staff (role = staffs.role, PAS users.role) + 1 par client-avec-userId, tenantId String, _id staffs inchangés', async () => {
    const report = await runMigration(testApp.app, true);
    expect(summarize(report, 'staff').created).toBe(2);
    expect(summarize(report, 'client').created).toBe(1);

    const ownerMembership = await testDb.db.collection('memberships').findOne({ staffId: ownerStaffId });
    expect(ownerMembership?.role).toBe('owner');
    expect(ownerMembership?.kind).toBe('staff');

    const stylistMembership = await testDb.db.collection('memberships').findOne({ staffId: stylistStaffId });
    expect(stylistMembership?.role).toBe('stylist'); // staffs.role
    const stylistUser = await testDb.db.collection('users').findOne({ _id: stylistUserId });
    expect(stylistUser?.role).toBe('staff'); // users.role — le bucket générique, DIFFÉRENT
    expect(stylistMembership?.role).not.toBe(stylistUser?.role);

    const clientMembership = await testDb.db.collection('memberships').findOne({ clientId: clientWithUserId });
    expect(clientMembership?.kind).toBe('client');
    expect(clientMembership?.role).toBe('client');

    const walkInMembership = await testDb.db.collection('memberships').findOne({ userId: null });
    expect(walkInMembership).toBeNull(); // le walk-in (sans userId) n'a jamais de Membership
    void walkInClientId;

    const allMemberships = await testDb.db.collection('memberships').find({}).toArray();
    expect(allMemberships).toHaveLength(3); // owner + stylist + client-avec-userId, PAS le walk-in
    for (const m of allMemberships) {
      expect(typeof m.tenantId).toBe('string'); // Invariant #1 — jamais un ObjectId
    }

    const ownerStaffAfter = await testDb.db.collection('staffs').findOne({ _id: ownerStaffId });
    const stylistStaffAfter = await testDb.db.collection('staffs').findOne({ _id: stylistStaffId });
    expect(ownerStaffAfter?._id.toString()).toBe(ownerStaffId.toString());
    expect(stylistStaffAfter?._id.toString()).toBe(stylistStaffId.toString());
  }, 30_000);

  it('rejeu (2e --apply) → 0 création (idempotent)', async () => {
    const before = await testDb.db.collection('memberships').countDocuments();
    const report = await runMigration(testApp.app, true);
    expect(summarize(report, 'staff').created).toBe(0);
    expect(summarize(report, 'client').created).toBe(0);
    const after = await testDb.db.collection('memberships').countDocuments();
    expect(after).toBe(before);
  }, 30_000);
});
