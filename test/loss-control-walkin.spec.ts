/**
 * LC-0 — walk-in encaissé au comptoir ouvre son Appointment, atomiquement avec Payment+Sale
 * (SKILL_loss_control_doses.md, Prompt 0-bis). Sans lui, un service rendu au comptoir n'a
 * aucun RDV où ancrer une future déclaration de doses (loss control) — c'est le trou que
 * `POST /pos/sale-with-appointment` ferme, et ce test en apporte la preuve :
 *   [1] le RDV, le paiement et la vente sont créés ensemble, le RDV verrouillé 'completed'.
 *   [2] le RDV walk-in apparaît sur le board Today, colonne 'done'.
 *   [3] le même client (même téléphone) n'est jamais dupliqué (merge-on-phone).
 *   [4] un échec APRÈS la création du RDV (rupture de stock) annule TOUT — rien ne subsiste,
 *       ni RDV, ni paiement, ni vente : la seule preuve qui compte pour l'atomicité annoncée.
 *   [5] le chemin RDV planifié préexistant (`POST /pos/appointments/:id/pay`) n'a pas été
 *       cassé par ce changement.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedService,
  seedAppointment,
  signPosJwt,
  authHeader,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control walk-in (LC-0)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let stylistStaffId: string;
  let serviceId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_walkin');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-salon' });
    tenantId = salon.tenantId;
    locationId = salon.locations[0].id;

    const stylist = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Sarra',
    });
    stylistStaffId = stylist.staffId;

    const svc = await seedService(testDb.db, { tenantId, name: 'Coupe homme', price: 25, durationMin: 30 });
    serviceId = svc.serviceId;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const posToken = () => signPosJwt({ staffId: stylistStaffId, salonId: tenantId, role: 'stylist' });

  async function openCaisse() {
    await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ openingFloat: 100 }),
    });
  }

  it('[1] a walk-in service sale opens its Appointment, Payment and Sale atomically', async () => {
    await openCaisse();

    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        received: 25,
        clientPhone: '20 111 222',
        clientName: 'Amine',
        items: [{ kind: 'service', refId: serviceId, name: 'Coupe homme', qty: 1, unitPrice: 25 }],
      }),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.ok).toBe(true);
    const { appointmentId, paymentId } = res.body.data;
    expect(appointmentId).toBeTruthy();
    expect(paymentId).toBeTruthy();

    const appt = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(appt).toMatchObject({ source: 'walkin', status: 'completed', salonId: tenantId });
    expect(appt!.clientId).toBeInstanceOf(ObjectId);

    const client = await testDb.db.collection('clients').findOne({ _id: appt!.clientId });
    expect(client).toMatchObject({ phone: '+21620111222', name: 'Amine' }); // normalizedPhone() : préfixe Tunisie

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(paymentId) });
    expect(payment!.appointmentId.toString()).toBe(appointmentId);
    expect(payment!.amount).toBe(25);

    const sale = await testDb.db.collection('sales').findOne({ paymentId: new ObjectId(paymentId) });
    expect(sale).toMatchObject({ source: 'pos', total: 25 });

     
    console.log('PROOF [1] Appointment:', JSON.stringify(appt));
     
    console.log('PROOF [1] Payment:', JSON.stringify(payment));
     
    console.log('PROOF [1] Sale:', JSON.stringify(sale));
  });

  it('[2] the walk-in appointment shows up on GET /pos/today in the "done" column', async () => {
    const res = await fetchJson(url('/pos/today'), { headers: authHeader(posToken()) });
    expect(res.status).toBe(200);
    const card = res.body.data.find((a: { stylistId: string }) => a.stylistId === stylistStaffId);
    expect(card).toMatchObject({ status: 'completed', column: 'done', isBooked: false });
     
    console.log('PROOF [2] /pos/today card:', JSON.stringify(card));
  });

  it('[3] merge-on-phone: a second walk-in with the SAME phone reuses the SAME clientId', async () => {
    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20 111 222',
        items: [{ kind: 'service', refId: serviceId, name: 'Coupe homme', qty: 1, unitPrice: 25 }],
      }),
    });
    expect(res.status).toBe(201);
    const appt2 = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(res.body.data.appointmentId) });

    const clients = await testDb.db.collection('clients').find({ salonId: tenantId, phone: '+21620111222' }).toArray();
    expect(clients).toHaveLength(1); // pas de doublon
    expect(appt2!.clientId.toString()).toBe(clients[0]._id.toString());
     
    console.log('PROOF [3] clientId réutilisé:', clients[0]._id.toString(), '== appt2.clientId:', appt2!.clientId.toString());
  });

  it('[4] atomicity: a stock failure AFTER the Appointment is created rolls back EVERYTHING', async () => {
    const productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Cire coiffante',
      price: 15,
      stock: 0,
      lowStockAt: 2,
      active: true,
    });

    const beforeAppts = await testDb.db.collection('appointments').countDocuments({ salonId: tenantId });
    const beforePayments = await testDb.db.collection('payments').countDocuments({ salonId: tenantId });
    const beforeSales = await testDb.db.collection('sales').countDocuments({ salonId: tenantId });

    const res = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20 111 222',
        items: [
          { kind: 'service', refId: serviceId, name: 'Coupe homme', qty: 1, unitPrice: 25 },
          { kind: 'product', refId: productId.toString(), name: 'Cire coiffante', qty: 1, unitPrice: 15 },
        ],
      }),
    });

    expect(res.status).toBe(409); // ConflictException, rupture de stock

    const afterAppts = await testDb.db.collection('appointments').countDocuments({ salonId: tenantId });
    const afterPayments = await testDb.db.collection('payments').countDocuments({ salonId: tenantId });
    const afterSales = await testDb.db.collection('sales').countDocuments({ salonId: tenantId });

     
    console.log(
      `PROOF [4] appointments ${beforeAppts} -> ${afterAppts}, payments ${beforePayments} -> ${afterPayments}, sales ${beforeSales} -> ${afterSales}`,
    );
    expect(afterAppts).toBe(beforeAppts);
    expect(afterPayments).toBe(beforePayments);
    expect(afterSales).toBe(beforeSales);
  });

  it('[5] a pre-existing scheduled appointment still checks out normally via /pos/appointments/:id/pay', async () => {
    const clientInsert = await testDb.db.collection('clients').insertOne({
      salonId: tenantId,
      name: 'RDV planifié',
      phone: '20999888',
      email: '',
      commsConsent: true,
      preferredChannel: 'email',
      notes: '',
      history: [],
    });
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 60_000);
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: clientInsert.insertedId.toString(),
      start,
      end,
      status: 'booked',
      services: [serviceId],
    });

    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ method: 'cash' }),
    });

    expect(res.status).toBe(201);
    const appt = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(appt).toMatchObject({ status: 'completed' });
    const payment = await testDb.db.collection('payments').findOne({ appointmentId: new ObjectId(appointmentId) });
    expect(payment).toBeTruthy();
     
    console.log('PROOF [5] scheduled appointment completed:', JSON.stringify(appt));
  });
});
