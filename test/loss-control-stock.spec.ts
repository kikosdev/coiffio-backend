/**
 * LC-5 — StockMovement (refill/adjustment/loss + INVENTAIRE PHYSIQUE) et le blocage de
 * clôture A4 (SKILL_loss_control_doses.md, Prompt 3). Sept preuves :
 *   [1] Refill 10 unités → Product.stock +10, mouvement tracé, doses dérivées.
 *   [2] INVENTAIRE : théorique 10, compté 7 → écart -3, Product.stock mis à 7 (LA preuve clé —
 *       sans elle Calc 2 est inerte).
 *   [3] Blocage A4 : alertsEnabled=true + service avec doseConfig + aucun DoseLog → 409
 *       actionnable (nom du service + doses attendues).
 *   [4] Non-blocage : alertsEnabled=false, mêmes conditions → 201.
 *   [5] Non-blocage : alertsEnabled=true mais AUCUN service du RDV n'a de doseConfig → 201.
 *   [6] Déblocage : déclarer les doses puis encaisser → 201.
 *   [7] Journal filtrable par période et produit.
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

describe('loss-control stock movements + A4 checkout block (Prompt 3)', () => {
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
    testDb = await startTestDb('loss_control_stock');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-stock-salon' });
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
      stock: 0,
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

  async function seedFreshAppointment(services: string[]) {
    const start = new Date();
    const end = new Date(start.getTime() + 60 * 60_000);
    const appt = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: new ObjectId().toString(),
      start,
      end,
      status: 'booked',
      services,
    });
    return appt.appointmentId;
  }

  it('[1] refill 10 units adds to Product.stock, movement traced with derived doses', async () => {
    const res = await fetchJson(url('/pos/stock-movements'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ productId: productId.toString(), kind: 'refill', units: 10, reason: 'Livraison fournisseur' }),
    });
    expect(res.status).toBe(201);

    const product = await testDb.db.collection('products').findOne({ _id: productId });
    expect(product!.stock).toBe(10);

    const move = await testDb.db.collection('stockmoves').findOne({ productId, kind: 'refill' });
    expect(move).toMatchObject({ type: 'in', qty: 10, doses: 40, kind: 'refill', note: 'Livraison fournisseur' });
     
    console.log('PROOF [1] product.stock:', product!.stock, '— movement:', JSON.stringify(move));
  });

  it('[2] physical inventory count (7 vs theoretical 10) records variance -3 and REDEFINES Product.stock', async () => {
    const before = await testDb.db.collection('products').findOne({ _id: productId });
    expect(before!.stock).toBe(10); // théorique avant comptage

    const res = await fetchJson(url('/pos/stock-movements/count'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ productId: productId.toString(), countedStock: 7, reason: 'Comptage hebdomadaire' }),
    });
    expect(res.status).toBe(201);

    const after = await testDb.db.collection('products').findOne({ _id: productId });
    expect(after!.stock).toBe(7); // redéfini, pas additionné
    expect(after!.lastInventoryAt).toBeTruthy();

    const move = await testDb.db.collection('stockmoves').findOne({ productId, kind: 'inventory' });
    expect(move).toMatchObject({ kind: 'inventory', qty: 7, previousStock: 10, variance: -3, type: 'out' });
     
    console.log('PROOF [2] KEY: previousStock=10, counted=7, variance=', move!.variance, '-> Product.stock=', after!.stock);
  });

  it('[4] alertsEnabled=false: dosable service, no DoseLog → checkout goes through (201)', async () => {
    const appointmentId = await seedFreshAppointment([serviceDosableId]);
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(res.status).toBe(201);
     
    console.log('PROOF [4] alertsEnabled=false, dosable+undeclared -> status:', res.status);
  });

  it('[3] alertsEnabled=true: dosable service, no DoseLog → checkout blocked (409, actionable)', async () => {
    const settingsRes = await fetchJson(url('/settings/loss-control'), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ alertsEnabled: true }),
    });
    expect(settingsRes.status).toBe(200);

    const appointmentId = await seedFreshAppointment([serviceDosableId]);
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Coloration');
    expect(res.body.message).toContain('2 doses');

    const appt = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(appt!.status).toBe('booked'); // pas complété — le blocage a bien empêché l'encaissement
     
    console.log('PROOF [3] alertsEnabled=true, dosable+undeclared -> status:', res.status, 'message:', res.body.message);
  });

  it('[5] alertsEnabled=true but NO service of the appointment has a doseConfig → checkout goes through (201)', async () => {
    const appointmentId = await seedFreshAppointment([serviceNonDosableId]);
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(res.status).toBe(201);
     
    console.log('PROOF [5] alertsEnabled=true, no doseConfig on any service -> status:', res.status);
  });

  it('[6] declaring doses first unblocks the checkout (201)', async () => {
    const appointmentId = await seedFreshAppointment([serviceDosableId]);

    const declareRes = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: productId.toString(), dosesDeclared: 2 }] }),
    });
    expect(declareRes.status).toBe(201);

    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(res.status).toBe(201);
     
    console.log('PROOF [6] declared then checkout -> status:', res.status);
  });

  it('[7] the movement journal is filterable by period and product', async () => {
    const byProduct = await fetchJson(url(`/pos/stock-movements?productId=${productId.toString()}`), {
      headers: jsonHeaders(stylistPosToken()),
    });
    expect(byProduct.status).toBe(200);
    expect(byProduct.body.data).toHaveLength(2); // le refill [1] + l'inventaire [2]
    expect(byProduct.body.data.map((m: { kind: string }) => m.kind).sort()).toEqual(['inventory', 'refill']);

    const byPeriod = await fetchJson(url(`/pos/stock-movements?productId=${productId.toString()}&period=day`), {
      headers: jsonHeaders(stylistPosToken()),
    });
    expect(byPeriod.status).toBe(200);
    expect(byPeriod.body.data).toHaveLength(2); // les deux mouvements sont d'aujourd'hui

    const otherProduct = await fetchJson(url(`/pos/stock-movements?productId=${new ObjectId().toString()}`), {
      headers: jsonHeaders(stylistPosToken()),
    });
    expect(otherProduct.body.data).toHaveLength(0);

     
    console.log('PROOF [7] by product:', byProduct.body.data.length, '— by period=day:', byPeriod.body.data.length, '— other product:', otherProduct.body.data.length);
  });
});
