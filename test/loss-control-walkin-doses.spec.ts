/**
 * LC-3/A4 (SKILL_loss_control_doses.md, Prompt 3-bis) — doses inline dans le ticket walk-in.
 * Ferme le trou ouvert au Prompt 3 : `createWalkinSale()` crée ET clôt l'Appointment dans le
 * même appel atomique, donc `assertDeclaredIfRequired()` (qui lit `DoseLog` en base) ne peut
 * jamais s'appliquer à ce chemin — `dto.doses` remplace la fenêtre de déclaration manquante.
 *   [1] Walk-in + doses inline → 201, Appointment(completed) + DoseLog(lockedAt posé
 *       immédiatement) + Payment + Sale, tous créés ensemble.
 *   [2] Blocage : alertsEnabled=true + service dosable + doses ABSENTES → 409 actionnable.
 *   [3] Non-blocage : alertsEnabled=false, mêmes conditions → 201.
 *   [4] Non-blocage : service SANS doseConfig, alertsEnabled=true → 201.
 *   [5] ATOMICITÉ (LA preuve clé) : échec APRÈS création des DoseLog (rupture de stock) →
 *       AUCUN document ne subsiste (appointments/doselogs/payments/sales inchangés).
 *   [6] Non-régression : payAppointment() (RDV planifié) inchangé, A4 toujours actif.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedAppointment,
  signStaffJwt,
  signPosJwt,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control walk-in inline doses (Prompt 3-bis)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistStaffId: string;
  let productId: ObjectId;
  let serviceDosableId: string;
  let serviceNonDosableId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_walkin_doses');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-walkin-doses-salon' });
    tenantId = salon.tenantId;
    locationId = salon.locations[0].id;

    const owner = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Patron',
    });
    ownerUserId = owner.userId;
    ownerStaffId = owner.staffId;

    const stylist = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Sarra',
    });
    stylistStaffId = stylist.staffId;

    productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Coloration Majirel',
      price: 25,
      stock: 10,
      dosesPerUnit: 4,
      isConsumable: true,
      active: true,
    });

    const dosableId = new ObjectId();
    serviceDosableId = dosableId.toString();
    const nonDosableId = new ObjectId();
    serviceNonDosableId = nonDosableId.toString();
    await testDb.db.collection('services').insertMany([
      {
        _id: dosableId,
        salonId: tenantId,
        name: 'Coloration',
        category: '',
        gender: 'universal',
        price: 60,
        durationMin: 60,
        bufferMin: 0,
        color: '#B89968',
        active: true,
        isFeatured: false,
        featuredOrder: 0,
        isPublic: true,
        doseConfig: [{ productId: productId.toString(), doses: 2 }],
      },
      {
        _id: nonDosableId,
        salonId: tenantId,
        name: 'Brushing sec',
        category: '',
        gender: 'universal',
        price: 20,
        durationMin: 20,
        bufferMin: 0,
        color: '#B89968',
        active: true,
        isFeatured: false,
        featuredOrder: 0,
        isPublic: true,
        doseConfig: [],
      },
    ]);

    await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ openingFloat: 100 }),
    });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  function stylistPosToken() {
    return signPosJwt({ staffId: stylistStaffId, salonId: tenantId, role: 'stylist' });
  }
  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });

  async function setAlertsEnabled(enabled: boolean) {
    const res = await fetchJson(url('/settings/loss-control'), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ alertsEnabled: enabled }),
    });
    expect(res.status).toBe(200);
  }

  it('[3] alertsEnabled=false: dosable service, doses absent from body → walk-in goes through (201)', async () => {
    await setAlertsEnabled(false);
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20111000',
        items: [{ kind: 'service', refId: serviceDosableId, name: 'Coloration', qty: 1, unitPrice: 60 }],
      }),
    });
    expect(res.status).toBe(201);
     
    console.log('PROOF [3] alertsEnabled=false, doses absent -> status:', res.status);
  });

  it('[2] alertsEnabled=true: dosable service, doses ABSENT from body → blocked (409, actionable)', async () => {
    await setAlertsEnabled(true);
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20111001',
        items: [{ kind: 'service', refId: serviceDosableId, name: 'Coloration', qty: 1, unitPrice: 60 }],
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Coloration');
    expect(res.body.message).toContain('2 doses');

    // Rien n'a été créé — le blocage est AVANT la transaction.
    const appts = await testDb.db.collection('appointments').countDocuments({ salonId: tenantId });
    expect(appts).toBe(1); // seul le walk-in du test [3] existe à ce stade
     
    console.log('PROOF [2] alertsEnabled=true, doses absent -> status:', res.status, 'message:', res.body.message);
  });

  it('[4] alertsEnabled=true but the service has NO doseConfig → walk-in goes through (201)', async () => {
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20111002',
        items: [{ kind: 'service', refId: serviceNonDosableId, name: 'Brushing sec', qty: 1, unitPrice: 20 }],
      }),
    });
    expect(res.status).toBe(201);
     
    console.log('PROOF [4] alertsEnabled=true, no doseConfig -> status:', res.status);
  });

  it('[1] walk-in with inline doses → Appointment + DoseLog(locked) + Payment + Sale, all created together', async () => {
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        received: 60,
        clientPhone: '20111003',
        clientName: 'Amine',
        items: [{ kind: 'service', refId: serviceDosableId, name: 'Coloration', qty: 1, unitPrice: 60 }],
        doses: [{ productId: productId.toString(), dosesDeclared: 3 }],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.doseLogsDeclared).toBe(1);

    const { appointmentId, paymentId } = res.body.data;

    const appt = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(appt).toMatchObject({ source: 'walkin', status: 'completed' });

    const doseLog = await testDb.db.collection('doselogs').findOne({ appointmentId, productId: productId.toString() });
    expect(doseLog).toMatchObject({ dosesDeclared: 3, dosesExpected: 2, variancePct: 50, stylistId: stylistStaffId });
    expect(doseLog!.lockedAt).toBeTruthy(); // verrouillé IMMÉDIATEMENT — même appel atomique

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(paymentId) });
    expect(payment).toMatchObject({ appointmentId: new ObjectId(appointmentId), amount: 60 });

    const sale = await testDb.db.collection('sales').findOne({ paymentId: new ObjectId(paymentId) });
    expect(sale).toMatchObject({ source: 'pos', total: 60 });

     
    console.log('PROOF [1] Appointment:', JSON.stringify(appt));
     
    console.log('PROOF [1] DoseLog:', JSON.stringify(doseLog));
     
    console.log('PROOF [1] Payment:', JSON.stringify(payment));
     
    console.log('PROOF [1] Sale:', JSON.stringify(sale));
  });

  it('[5] KEY: a stock failure AFTER DoseLog creation rolls back EVERYTHING (Appointment + DoseLog included)', async () => {
    const brokeProductId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: brokeProductId,
      salonId: tenantId,
      locationId,
      name: 'Cire coiffante',
      price: 15,
      stock: 0,
      active: true,
    });

    const beforeAppts = await testDb.db.collection('appointments').countDocuments({ salonId: tenantId });
    const beforeDoseLogs = await testDb.db.collection('doselogs').countDocuments({ salonId: tenantId });
    const beforePayments = await testDb.db.collection('payments').countDocuments({ salonId: tenantId });
    const beforeSales = await testDb.db.collection('sales').countDocuments({ salonId: tenantId });

    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20111004',
        items: [
          { kind: 'service', refId: serviceDosableId, name: 'Coloration', qty: 1, unitPrice: 60 },
          { kind: 'product', refId: brokeProductId.toString(), name: 'Cire coiffante', qty: 1, unitPrice: 15 },
        ],
        doses: [{ productId: productId.toString(), dosesDeclared: 2 }],
      }),
    });
    expect(res.status).toBe(409); // ConflictException, rupture de stock (checkoutWithStock, APRÈS le DoseLog)

    const afterAppts = await testDb.db.collection('appointments').countDocuments({ salonId: tenantId });
    const afterDoseLogs = await testDb.db.collection('doselogs').countDocuments({ salonId: tenantId });
    const afterPayments = await testDb.db.collection('payments').countDocuments({ salonId: tenantId });
    const afterSales = await testDb.db.collection('sales').countDocuments({ salonId: tenantId });

     
    console.log(
      `PROOF [5] appointments ${beforeAppts} -> ${afterAppts}, doselogs ${beforeDoseLogs} -> ${afterDoseLogs}, ` +
        `payments ${beforePayments} -> ${afterPayments}, sales ${beforeSales} -> ${afterSales}`,
    );
    expect(afterAppts).toBe(beforeAppts);
    expect(afterDoseLogs).toBe(beforeDoseLogs);
    expect(afterPayments).toBe(beforePayments);
    expect(afterSales).toBe(beforeSales);
  });

  it('[6] non-regression: payAppointment() (scheduled RDV) still blocks/unblocks via A4, unaffected by walk-in changes', async () => {
    const start = new Date();
    const end = new Date(start.getTime() + 60 * 60_000);
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: new ObjectId().toString(),
      start,
      end,
      status: 'booked',
      services: [serviceDosableId],
    });

    const blocked = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('Coloration');

    const declare = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: productId.toString(), dosesDeclared: 2 }] }),
    });
    expect(declare.status).toBe(201);

    const unblocked = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(unblocked.status).toBe(201);
     
    console.log('PROOF [6] payAppointment blocked then unblocked:', blocked.status, '->', unblocked.status);
  });
});
