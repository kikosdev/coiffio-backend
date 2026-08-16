/**
 * LC-9 — modal d'investigation RDV + doses (SKILL_loss_control_doses.md, Prompt 7).
 *   [1] GET .../investigation sur un RDV planifié avec doses déclarées + Payment lié → détail
 *       complet et exact (client/services/stylist, doses, payment).
 *   [2] Même endpoint sur un walk-in (Prompt 0-bis/3-bis) → fonctionne identiquement, le
 *       Payment est retrouvé via appointmentId sur CE chemin aussi.
 *   [3] RDV sans DoseLog → doses:[], pas une erreur.
 *   [4] Une correction owner post-verrouillage (Prompt 2) apparaît (correctedBy/correctionNote).
 *   [5] CaisseEntry porte désormais entryType + appointmentId, et distingue un Payment d'une
 *       Sale orpheline (SalesService, jamais liée à un RDV).
 *   [6] RBAC owner-only sur l'endpoint d'investigation.
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
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control investigation modal (Prompt 7)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistStaffId: string;
  let stylistUserId: string;
  let productId: ObjectId;
  let serviceDosableId: string;
  let serviceNonDosableId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_investigation');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-investigation-salon' });
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
    stylistUserId = stylist.userId;

    productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Coloration Majirel',
      price: 25,
      stock: 100,
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
  const stylistStaffToken = () =>
    signStaffJwt({ sub: stylistUserId, salonId: tenantId, role: 'stylist', staffId: stylistStaffId });

  let plannedAppointmentId: string;
  let plannedDoseLogId: string;

  it('[1] a scheduled appointment with declared doses and a linked Payment returns full detail', async () => {
    const start = new Date();
    const end = new Date(start.getTime() + 60 * 60_000);
    const clientId = new ObjectId();
    await testDb.db.collection('clients').insertOne({
      _id: clientId,
      salonId: tenantId,
      name: 'Amine Client',
      phone: '+21620111222',
      email: '',
      commsConsent: true,
      preferredChannel: 'email',
      notes: '',
      history: [],
    });
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: clientId.toString(),
      start,
      end,
      status: 'booked',
      services: [serviceDosableId],
    });
    plannedAppointmentId = appointmentId;

    const declareRes = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: productId.toString(), dosesDeclared: 3 }] }),
    });
    expect(declareRes.status).toBe(201);
    plannedDoseLogId = declareRes.body.data[0].id ?? declareRes.body.data[0]._id;

    const payRes = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(payRes.status).toBe(201);

    const res = await fetchJson(url(`/loss-control/appointments/${appointmentId}/investigation`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.appointment).toMatchObject({
      id: appointmentId,
      status: 'completed',
      source: 'online',
      client: { name: 'Amine Client', phone: '+21620111222' },
      stylist: { id: stylistStaffId, name: 'Sarra' },
    });
    expect(data.appointment.services).toHaveLength(1);
    expect(data.appointment.services[0]).toMatchObject({ name: 'Coloration', price: 60, durationMin: 60 });

    expect(data.doses).toHaveLength(1);
    expect(data.doses[0]).toMatchObject({
      productId: productId.toString(),
      productName: 'Coloration Majirel',
      dosesDeclared: 3,
      dosesExpected: 2,
      variancePct: 50,
    });
    expect(data.doses[0].lockedAt).toBeTruthy(); // clôturé -> verrouillé

    expect(data.payment).toMatchObject({ amount: 60, method: 'cash' });
     
    console.log('PROOF [1] investigation:', JSON.stringify(data));
  });

  it('[2] the same endpoint works identically for a walk-in appointment (Payment.appointmentId set on that path too)', async () => {
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20999888',
        clientName: 'Walk-in Client',
        items: [{ kind: 'service', refId: serviceDosableId, name: 'Coloration', qty: 1, unitPrice: 60 }],
        doses: [{ productId: productId.toString(), dosesDeclared: 2 }],
      }),
    });
    expect(res.status).toBe(201);
    const { appointmentId } = res.body.data;

    const inv = await fetchJson(url(`/loss-control/appointments/${appointmentId}/investigation`), {
      headers: authHeader(ownerToken()),
    });
    expect(inv.status).toBe(200);
    expect(inv.body.data.appointment).toMatchObject({ source: 'walkin', status: 'completed' });
    expect(inv.body.data.appointment.client.name).toBe('Walk-in Client');
    expect(inv.body.data.doses).toHaveLength(1);
    expect(inv.body.data.payment).toMatchObject({ amount: 60, method: 'cash' });
     
    console.log('PROOF [2] walk-in investigation payment:', JSON.stringify(inv.body.data.payment));
  });

  it('[3] an appointment with no DoseLog returns doses:[], not an error', async () => {
    const start = new Date();
    const end = new Date(start.getTime() + 20 * 60_000);
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: new ObjectId().toString(),
      start,
      end,
      status: 'booked',
      services: [serviceNonDosableId],
    });

    await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });

    const res = await fetchJson(url(`/loss-control/appointments/${appointmentId}/investigation`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.doses).toEqual([]);
     
    console.log('PROOF [3] no doseConfig -> doses:', JSON.stringify(res.body.data.doses));
  });

  it('[4] an owner correction on a locked DoseLog shows up (correctedBy/correctionNote)', async () => {
    const correctRes = await fetchJson(url(`/doses/${plannedDoseLogId}`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ dosesDeclared: 2, correctionNote: 'Vérifié après coup, écart non confirmé.' }),
    });
    expect(correctRes.status).toBe(200);

    const res = await fetchJson(url(`/loss-control/appointments/${plannedAppointmentId}/investigation`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.doses[0]).toMatchObject({
      dosesDeclared: 2,
      correctedBy: ownerStaffId,
      correctionNote: 'Vérifié après coup, écart non confirmé.',
    });
     
    console.log('PROOF [4] corrected dose row:', JSON.stringify(res.body.data.doses[0]));
  });

  it('[5] CaisseEntry disambiguates Payment-backed sales from orphan retail Sale via entryType/appointmentId', async () => {
    // Vente retail orpheline (SalesService), jamais liée à un RDV.
    await fetchJson(url('/sales'), {
      method: 'POST',
      headers: jsonHeaders(stylistStaffToken()),
      body: JSON.stringify({ items: [{ refId: productId.toString(), qty: 1 }], method: 'cash' }),
    });

    const journal = await fetchJson(url('/caisse/journal'), { headers: authHeader(ownerToken()) });
    expect(journal.status).toBe(200);
    const entries = journal.body.data.entries as {
      kind: string;
      entryType?: string;
      appointmentId?: string;
      id: string;
    }[];

    const paymentEntry = entries.find((e) => e.entryType === 'payment' && e.appointmentId === plannedAppointmentId);
    expect(paymentEntry).toBeTruthy();

    const orphanSaleEntry = entries.find((e) => e.entryType === 'sale');
    expect(orphanSaleEntry).toBeTruthy();
    expect(orphanSaleEntry!.appointmentId).toBeUndefined();

     
    console.log('PROOF [5] payment entry:', JSON.stringify(paymentEntry), '- orphan sale entry:', JSON.stringify(orphanSaleEntry));
  });

  it('[6] RBAC: a non-owner staff gets 403 on the investigation endpoint', async () => {
    const res = await fetchJson(url(`/loss-control/appointments/${plannedAppointmentId}/investigation`), {
      headers: authHeader(stylistStaffToken()),
    });
    expect(res.status).toBe(403);
     
    console.log('PROOF [6] staff attempt status:', res.status);
  });
});
