/**
 * Paie & RH (SKILL_owner_paie_rh, Prompt 4) — preuve d'intégration sur MongoMemoryReplSet
 * réel (transactions vraies, jamais mockées). Couvre les 8 points du prompt :
 *   1. Cycle avance (owner direct / staff pending / decide→approved)
 *   2. preview() : commission recalculée sur des Payment semés, openAdvances correct
 *   3. pay() happy path : SalaryPayment créé, netPaid exact, avances settled
 *   4. Atomicité P7 : erreur injectée entre payment-create et settle → rollback total
 *   5. Doublon période → 409, aucun doublon persisté
 *   6. Net négatif → 400, rien persisté
 *   7. Isolation cross-tenant (paie), positive control
 *   8. Scope self (/payroll/me, /advances/me)
 *
 * Toutes les périodes utilisées sont dans un futur lointain (2099) — indépendant de la date
 * réelle d'exécution du test, pour que le filtre `createdAt <= fin de période` (openAdvances)
 * ne dépende jamais de "aujourd'hui".
 */
import { ObjectId } from 'mongodb';
import { getModelToken } from '@nestjs/mongoose';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  signStaffJwt,
  authHeader,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('payroll (advances + payroll, Prompt 4)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  let tenantId: string;
  let loc1: string;
  let loc2: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistAUserId: string;
  let stylistAStaffId: string;

  let tenantB: string;
  let locB: string;
  let ownerBUserId: string;
  let ownerBStaffId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;
  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });
  const stylistAToken = () => signStaffJwt({ sub: stylistAUserId, salonId: tenantId, role: 'stylist', staffId: stylistAStaffId });
  const ownerBToken = () => signStaffJwt({ sub: ownerBUserId, salonId: tenantB, role: 'owner', staffId: ownerBStaffId });

  beforeAll(async () => {
    testDb = await startTestDb('payroll_module');
    testApp = await bootApp();

    const salon = await seedSalon(testDb.db, { slug: 'payroll-salon', locationSlugs: ['principal', 'annexe'] });
    tenantId = salon.tenantId;
    loc1 = salon.locations[0].id;
    loc2 = salon.locations[1].id;

    const owner = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [loc1, loc2],
      defaultLocationId: loc1,
      name: 'Patron',
    });
    ownerUserId = owner.userId;
    ownerStaffId = owner.staffId;

    const stylistA = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [loc1, loc2],
      defaultLocationId: loc1,
      name: 'Sarra',
    });
    stylistAUserId = stylistA.userId;
    stylistAStaffId = stylistA.staffId;

    // Salon B — pour le test d'isolation cross-tenant (#7).
    const salonB = await seedSalon(testDb.db, { slug: 'payroll-salon-b' });
    tenantB = salonB.tenantId;
    locB = salonB.locations[0].id;
    const ownerB = await seedStaff(testDb.db, { tenantId: tenantB, role: 'owner', locationIds: [locB], defaultLocationId: locB, name: 'Patron B' });
    ownerBUserId = ownerB.userId;
    ownerBStaffId = ownerB.staffId;
  });

  afterAll(async () => {
    // Ce fichier est le premier à exercer `session.withTransaction()` via de vraies requêtes
    // HTTP contre un `MongoMemoryReplSet` (les autres suites n'ont jamais déclenché de
    // transaction réelle) — un court délai avant la fermeture évite une course où le driver
    // Mongo tente de fermer le client pendant qu'une session/transaction vient tout juste de
    // se terminer côté serveur (`MongoClientClosedError` sinon, observé de façon répétable
    // ici et nulle part ailleurs dans la suite).
    await new Promise((resolve) => setTimeout(resolve, 250));
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function seedStaffProfile(opts: { tenantId: string; staffId: string; baseSalary: number; commissionPct?: number }) {
    await testDb.db.collection('staffprofiles').insertOne({
      salonId: opts.tenantId,
      userId: new ObjectId(opts.staffId),
      level: 'senior',
      capabilities: [],
      baseRate: 0,
      commissionPct: opts.commissionPct ?? 10,
      baseSalary: opts.baseSalary,
      isPublicOnLanding: true,
      publicTitle: '',
      seniorityTag: 'Senior',
      landingOrder: 0,
    });
  }

  async function seedPayment(opts: {
    tenantId: string;
    locationId: string;
    stylistId: string;
    commission: number;
    productCommission?: number;
    date: Date;
    refunded?: boolean;
  }) {
    await testDb.db.collection('payments').insertOne({
      salonId: opts.tenantId,
      locationId: opts.locationId,
      stylistId: new ObjectId(opts.stylistId),
      items: [{ kind: 'service', refId: '', name: 'Coupe', qty: 1, unitPrice: 1000 }],
      amount: 1000,
      tip: 0,
      commission: opts.commission,
      productCommission: opts.productCommission ?? 0,
      method: 'cash',
      date: opts.date,
      refunded: opts.refunded ?? false,
    });
  }

  // ─── 1. Cycle avance ────────────────────────────────────────────────────────

  let advanceOwnerGrantedId: string;
  let advancePendingThenApprovedId: string;

  it('1a. owner grants an advance directly → status approved', async () => {
    const res = await fetchJson(url('/advances'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ staffId: stylistAStaffId, amount: 50_000, reason: 'avance directe' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('approved');
    advanceOwnerGrantedId = res.body.data._id;
  });

  it('1b. staff self-request → status pending', async () => {
    const res = await fetchJson(url('/advances'), {
      method: 'POST',
      headers: jsonHeaders(stylistAToken()),
      body: JSON.stringify({ amount: 20_000, reason: 'demande staff' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    advancePendingThenApprovedId = res.body.data._id;
  });

  it('1c. owner decides (approve) the pending request → status approved', async () => {
    const res = await fetchJson(url(`/advances/${advancePendingThenApprovedId}/decide`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });

  // ─── Fixtures financières pour la période payroll principale (2099-06) ───────

  beforeAll(async () => {
    await seedStaffProfile({ tenantId, staffId: stylistAStaffId, baseSalary: 500_000, commissionPct: 10 });
    // Deux Payment non-remboursés, dans la période, RÉPARTIS sur les 2 locations du salon —
    // prouve que la paie agrège tout le salon (TENANT_SCOPED), pas juste la location active.
    await seedPayment({ tenantId, locationId: loc1, stylistId: stylistAStaffId, commission: 1000, productCommission: 200, date: new Date('2099-06-05T10:00:00Z') });
    await seedPayment({ tenantId, locationId: loc2, stylistId: stylistAStaffId, commission: 1000, productCommission: 200, date: new Date('2099-06-20T10:00:00Z') });
    // Doit être EXCLU : remboursé.
    await seedPayment({ tenantId, locationId: loc1, stylistId: stylistAStaffId, commission: 5000, date: new Date('2099-06-10T10:00:00Z'), refunded: true });
    // Doit être EXCLU : hors période (mois suivant).
    await seedPayment({ tenantId, locationId: loc1, stylistId: stylistAStaffId, commission: 5000, date: new Date('2099-07-01T10:00:00Z') });
  });

  // ─── 2. Preview ─────────────────────────────────────────────────────────────

  it('2. preview aggregates commission across locations, excludes refunded/out-of-period, lists open advances', async () => {
    const res = await fetchJson(url(`/payroll/preview?staffId=${stylistAStaffId}&year=2099&month=6`), { headers: authHeader(ownerToken()) });
    expect(res.status).toBe(200);
    const preview = res.body.data;
    expect(preview.baseSalary).toBe(500_000);
    expect(preview.commissionTotal).toBe(2400); // (1000+200) + (1000+200), refunded/out-of-period excluded
    expect(preview.openAdvances).toHaveLength(2); // the two approved advances from step 1
    expect(preview.openAdvances.map((a: { amount: number }) => a.amount).sort()).toEqual([20_000, 50_000]);
    expect(preview.suggestedNet).toBe(500_000 + 2400 - 70_000); // 432400 — real signed value, not clamped
  });

  // ─── 3. Pay happy path ──────────────────────────────────────────────────────

  let firstPayslipId: string;

  it('3. pay() happy path: creates SalaryPayment with exact netPaid, settles only the selected advance', async () => {
    const res = await fetchJson(url('/payroll'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ staffId: stylistAStaffId, year: 2099, month: 6, settleAdvanceIds: [advanceOwnerGrantedId] }),
    });
    expect(res.status).toBe(201);
    const payment = res.body.data;
    expect(payment.baseSalary).toBe(500_000);
    expect(payment.commissionTotal).toBe(2400);
    expect(payment.netPaid).toBe(500_000 + 2400 - 50_000); // 452400
    expect(payment.advancesDeducted).toEqual([{ advanceId: advanceOwnerGrantedId, amount: 50_000 }]);
    firstPayslipId = payment._id;

    const settled = await testDb.db.collection('salaryadvances').findOne({ _id: new ObjectId(advanceOwnerGrantedId) });
    expect(settled?.status).toBe('settled');
    expect(settled?.settledInPayrollId).toBe(firstPayslipId);

    // The OTHER advance (staff self-request, approved) must remain untouched — only the
    // explicitly selected advance is settled.
    const untouched = await testDb.db.collection('salaryadvances').findOne({ _id: new ObjectId(advancePendingThenApprovedId) });
    expect(untouched?.status).toBe('approved');
  });

  // ─── 4. Atomicité P7 ────────────────────────────────────────────────────────

  describe('4. transaction atomicity (P7)', () => {
    let stylistBStaffId: string;
    let stylistBUserId: string;
    let advanceBId: string;

    beforeAll(async () => {
      const stylistB = await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [loc1], defaultLocationId: loc1, name: 'Bochra' });
      stylistBStaffId = stylistB.staffId;
      stylistBUserId = stylistB.userId;
      await seedStaffProfile({ tenantId, staffId: stylistBStaffId, baseSalary: 300_000 });
      await seedPayment({ tenantId, locationId: loc1, stylistId: stylistBStaffId, commission: 500, date: new Date('2099-07-05T10:00:00Z') });

      const advRes = await fetchJson(url('/advances'), {
        method: 'POST',
        headers: jsonHeaders(ownerToken()),
        body: JSON.stringify({ staffId: stylistBStaffId, amount: 10_000 }),
      });
      advanceBId = advRes.body.data._id;
    });

    it('injected failure between payment-create and advance-settle rolls back the ENTIRE transaction', async () => {
      const advanceModel = testApp.app.get(getModelToken('SalaryAdvance'));
      const spy = jest.spyOn(advanceModel, 'updateMany').mockImplementationOnce(() => {
        throw new Error('injected mid-transaction failure');
      });

      const res = await fetchJson(url('/payroll'), {
        method: 'POST',
        headers: jsonHeaders(ownerToken()),
        body: JSON.stringify({ staffId: stylistBStaffId, year: 2099, month: 7, settleAdvanceIds: [advanceBId] }),
      });
      // Unexpected Error (not a business HttpException) → clean 500, never a raw crash (P0 §9).
      expect(res.status).toBe(500);

      const payslip = await testDb.db.collection('salarypayments').findOne({ staffId: stylistBStaffId, 'period.year': 2099, 'period.month': 7 });
      expect(payslip).toBeNull(); // the SalaryPayment created just before the injected failure must NOT survive

      const advance = await testDb.db.collection('salaryadvances').findOne({ _id: new ObjectId(advanceBId) });
      expect(advance?.status).toBe('approved'); // never settled

      spy.mockRestore();
    });

    it('positive control: without the injected failure, the SAME payout succeeds and persists both writes', async () => {
      const res = await fetchJson(url('/payroll'), {
        method: 'POST',
        headers: jsonHeaders(ownerToken()),
        body: JSON.stringify({ staffId: stylistBStaffId, year: 2099, month: 7, settleAdvanceIds: [advanceBId] }),
      });
      expect(res.status).toBe(201);
      expect(res.body.data.netPaid).toBe(300_000 + 500 - 10_000);

      const advance = await testDb.db.collection('salaryadvances').findOne({ _id: new ObjectId(advanceBId) });
      expect(advance?.status).toBe('settled');
    });

    it('#8 scope self: stylist B sees only their own payslip/advance, never stylist A\'s', async () => {
      const bToken = signStaffJwt({ sub: stylistBUserId, salonId: tenantId, role: 'stylist', staffId: stylistBStaffId });

      const payslips = await fetchJson(url('/payroll/me'), { headers: authHeader(bToken) });
      expect(payslips.status).toBe(200);
      expect(payslips.body.data).toHaveLength(1);
      expect(payslips.body.data[0].staffId).toBe(stylistBStaffId);

      const advances = await fetchJson(url('/advances/me'), { headers: authHeader(bToken) });
      expect(advances.status).toBe(200);
      expect(advances.body.data.every((a: { staffId: string }) => a.staffId === stylistBStaffId)).toBe(true);
    });

    it('owner: GET /payroll?staffId= (no period) returns that staff\'s full history, never another staff\'s payslip', async () => {
      const res = await fetchJson(url(`/payroll?staffId=${stylistBStaffId}`), { headers: authHeader(ownerToken()) });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].staffId).toBe(stylistBStaffId);
      expect(res.body.data.every((p: { staffId: string }) => p.staffId === stylistBStaffId)).toBe(true);
    });
  });

  // ─── 5. Doublon période ─────────────────────────────────────────────────────

  it('5. re-paying the same {staff, period} → 409, no duplicate SalaryPayment persisted', async () => {
    const res = await fetchJson(url('/payroll'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ staffId: stylistAStaffId, year: 2099, month: 6 }),
    });
    expect(res.status).toBe(409);

    const count = await testDb.db.collection('salarypayments').countDocuments({ staffId: stylistAStaffId, 'period.year': 2099, 'period.month': 6 });
    expect(count).toBe(1);
  });

  // ─── 6. Net négatif ─────────────────────────────────────────────────────────

  it('6. advances exceeding what is due → 400, nothing persisted, advance stays approved (P15)', async () => {
    const stylistC = await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [loc1], defaultLocationId: loc1, name: 'Chaima' });
    await seedStaffProfile({ tenantId, staffId: stylistC.staffId, baseSalary: 1_000 });

    const advRes = await fetchJson(url('/advances'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ staffId: stylistC.staffId, amount: 999_999 }),
    });
    const advanceId = advRes.body.data._id;

    const res = await fetchJson(url('/payroll'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ staffId: stylistC.staffId, year: 2099, month: 8, settleAdvanceIds: [advanceId] }),
    });
    expect(res.status).toBe(400);

    const count = await testDb.db.collection('salarypayments').countDocuments({ staffId: stylistC.staffId });
    expect(count).toBe(0);
    const advance = await testDb.db.collection('salaryadvances').findOne({ _id: new ObjectId(advanceId) });
    expect(advance?.status).toBe('approved');
  });

  // ─── 7. Isolation cross-tenant ──────────────────────────────────────────────

  describe('7. cross-tenant isolation (paie)', () => {
    it('owner of salon B cannot preview or pay a staff member of salon A', async () => {
      const previewRes = await fetchJson(url(`/payroll/preview?staffId=${stylistAStaffId}&year=2099&month=6`), { headers: authHeader(ownerBToken()) });
      expect(previewRes.status).toBe(404);

      const payRes = await fetchJson(url('/payroll'), {
        method: 'POST',
        headers: jsonHeaders(ownerBToken()),
        body: JSON.stringify({ staffId: stylistAStaffId, year: 2099, month: 9 }),
      });
      expect(payRes.status).toBe(404);

      const leaked = await testDb.db.collection('salarypayments').countDocuments({ salonId: tenantB });
      expect(leaked).toBe(0);
    });

    it('positive control: owner of salon B CAN pay their own staff (guard is tenant-scoped, not a blanket 404)', async () => {
      const ownStaff = await seedStaff(testDb.db, { tenantId: tenantB, role: 'stylist', locationIds: [locB], defaultLocationId: locB, name: 'Own staff B' });
      await seedStaffProfile({ tenantId: tenantB, staffId: ownStaff.staffId, baseSalary: 100_000 });

      const res = await fetchJson(url('/payroll'), {
        method: 'POST',
        headers: jsonHeaders(ownerBToken()),
        body: JSON.stringify({ staffId: ownStaff.staffId, year: 2099, month: 9 }),
      });
      expect(res.status).toBe(201);
      expect(res.body.data.netPaid).toBe(100_000);
    });
  });
});
