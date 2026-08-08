/**
 * Caisse Journal — contrôle de la caisse physique depuis le POS.
 *
 * Prouve les trois points sur lesquels la fonctionnalité peut silencieusement mentir :
 *   1. Le théorique agrège bien les DEUX chemins d'encaissement (`Payment` avec `Sale` lié,
 *      et `Sale` retail orphelin) sans double compter, et ignore la carte.
 *   2. La séparation des droits : le staff PIN ouvre et saisit, seul l'owner/manager clôture.
 *   3. Une journée clôturée est figée — l'écart archivé ne peut plus bouger après coup.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  signStaffJwt,
  signPosJwt,
  authHeader,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('caisse-journal', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistStaffId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('caisse_journal');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'caisse-salon' });
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
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const posToken = () => signPosJwt({ staffId: stylistStaffId, salonId: tenantId, role: 'stylist' });
  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });

  async function seedPayment(opts: { amount: number; method: 'cash' | 'card'; tip?: number; refunded?: boolean }) {
    const id = new ObjectId();
    await testDb.db.collection('payments').insertOne({
      _id: id,
      salonId: tenantId,
      locationId,
      stylistId: new ObjectId(stylistStaffId),
      items: [{ kind: 'service', refId: '', name: 'Coupe', qty: 1, unitPrice: opts.amount }],
      amount: opts.amount,
      tip: opts.tip ?? 0,
      commission: 0,
      method: opts.method,
      date: new Date(),
      refunded: opts.refunded ?? false,
    });
    // Le chemin réel écrit TOUJOURS un `Sale` lié — présent ici pour prouver que la lecture
    // ne le compte pas une seconde fois (elle ne retient que les `Sale` sans `paymentId`).
    await testDb.db.collection('sales').insertOne({
      salonId: tenantId,
      locationId,
      source: 'pos',
      items: [{ refId: '', name: 'Coupe', qty: 1, unitPrice: opts.amount }],
      subtotal: opts.amount,
      total: opts.amount,
      stylistId: new ObjectId(stylistStaffId),
      paymentId: id,
      date: new Date(),
      voided: false,
      stockRestored: false,
    });
    return id.toString();
  }

  async function seedRetailSale(opts: { total: number; method: 'cash' | 'card' }) {
    await testDb.db.collection('sales').insertOne({
      salonId: tenantId,
      locationId,
      source: 'pos',
      items: [{ refId: '', name: 'Shampoing', qty: 1, unitPrice: opts.total }],
      subtotal: opts.total,
      total: opts.total,
      method: opts.method,
      stylistId: new ObjectId(stylistStaffId),
      date: new Date(),
      voided: false,
      stockRestored: false,
    });
  }

  it('journal before opening: no session, zero totals, staff PIN cannot close', async () => {
    const res = await fetchJson(url('/caisse/journal'), { headers: authHeader(posToken()) });
    expect(res.status).toBe(200);
    expect(res.body.data.session).toBeNull();
    expect(res.body.data.totals.expectedCash).toBe(0);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.canClose).toBe(false);
  });

  it('a manager JWT sees canClose: true on the same journal', async () => {
    const res = await fetchJson(url('/caisse/journal'), { headers: authHeader(ownerToken()) });
    expect(res.status).toBe(200);
    expect(res.body.data.canClose).toBe(true);
  });

  it('a POS sale is refused while the caisse is not open (409 CAISSE_NOT_OPEN)', async () => {
    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        items: [{ kind: 'service', refId: new ObjectId().toString(), name: 'Coupe', qty: 1, unitPrice: 40 }],
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body.data).toMatchObject({ code: 'CAISSE_NOT_OPEN' });
    // Rien n'a été écrit : le garde s'exécute avant toute création de Payment/Sale.
    expect(await testDb.db.collection('payments').countDocuments({ salonId: tenantId })).toBe(0);
  });

  it('staff PIN opens the caisse with an opening float; a second open is refused (409)', async () => {
    const open = await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ openingFloat: 150 }),
    });
    expect(open.status).toBe(201);
    expect(open.body.data.status).toBe('open');
    expect(open.body.data.openingFloat).toBe(150);

    const again = await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ openingFloat: 999 }),
    });
    expect(again.status).toBe(409);

    const reread = await testDb.db.collection('cashsessions').find({ salonId: tenantId }).toArray();
    expect(reread).toHaveLength(1);
    expect(reread[0].openingFloat).toBe(150);
    expect(reread[0].locationId).toBe(locationId);
  });

  it('once open, a POS cash sale goes through and archives the change given back', async () => {
    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        received: 50, // le client donne 50 pour un ticket de 40
        items: [{ kind: 'service', refId: new ObjectId().toString(), name: 'Coupe', qty: 1, unitPrice: 40 }],
      }),
    });
    expect(res.status).toBe(201);

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(res.body.data.paymentId) });
    expect(payment?.amount).toBe(40);
    expect(payment?.cashReceived).toBe(50);
    expect(payment?.changeGiven).toBe(10);

    const journal = await fetchJson(url('/caisse/journal'), { headers: authHeader(posToken()) });
    const line = journal.body.data.entries.find((e: { id: string }) => e.id === res.body.data.paymentId);
    expect(line.note).toContain('rendu 10');
  });

  it('expected cash aggregates both checkout paths, ignores card, and excludes tips', async () => {
    await seedPayment({ amount: 45, method: 'cash', tip: 5 });
    await seedPayment({ amount: 100, method: 'card' });
    await seedRetailSale({ total: 30, method: 'cash' });
    await seedRetailSale({ total: 20, method: 'card' });

    const movement = await fetchJson(url('/caisse/session/movements'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ type: 'out', amount: 60, reason: 'achat', note: 'Café + monnaie' }),
    });
    expect(movement.status).toBe(201);

    const res = await fetchJson(url('/caisse/journal'), { headers: authHeader(posToken()) });
    const { totals, entries } = res.body.data;

    // 45 + 30 (seedés) + 40 (vente POS réelle du test précédent). Les `Sale` liés aux
    // paiements ne sont pas recomptés — sinon on serait à 190.
    expect(totals.cashSales).toBe(115);
    expect(totals.cardSales).toBe(120);
    expect(totals.cashOut).toBe(60);
    expect(totals.cashTips).toBe(5);
    expect(totals.expectedCash).toBe(205); // 150 + 115 − 0 + 0 − 60, pourboire exclu
    expect(totals.ticketCount).toBe(5);

    // Ouverture + 3 paiements + 2 ventes retail + 1 mouvement, en ordre chronologique.
    expect(entries).toHaveLength(7);
    expect(entries[0].kind).toBe('opening');
    expect(entries.filter((e: { affectsDrawer: boolean }) => e.affectsDrawer)).toHaveLength(5);
    const at = entries.map((e: { at: string }) => new Date(e.at).getTime());
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('a staff PIN token cannot close the caisse (403) and cannot read the history', async () => {
    const close = await fetchJson(url('/caisse/session/close'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ countedTotal: 160 }),
    });
    expect(close.status).toBe(403);

    const history = await fetchJson(url('/caisse/sessions'), { headers: authHeader(posToken()) });
    expect(history.status).toBe(403);

    const stillOpen = await testDb.db.collection('cashsessions').findOne({ salonId: tenantId });
    expect(stillOpen?.status).toBe('open');
  });

  it('the manager closes the day: counted vs expected and the variance are frozen on the session', async () => {
    const res = await fetchJson(url('/caisse/session/close'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ countedTotal: 200.5, note: 'Manque un billet de 5' }),
    });
    expect(res.status).toBe(201);

    const reread = await testDb.db.collection('cashsessions').findOne({ salonId: tenantId });
    expect(reread?.status).toBe('closed');
    expect(reread?.countedTotal).toBe(200.5);
    expect(reread?.expectedTotal).toBe(205);
    expect(reread?.variance).toBe(-4.5);
    expect(reread?.closedBy?.toString()).toBe(ownerStaffId);
    // La note de clôture ne doit pas écraser celle de l'ouverture : les deux lignes du
    // journal portent leur propre commentaire.
    expect(reread?.closingNote).toBe('Manque un billet de 5');
    expect(reread?.note).toBe('');
  });

  it('a closed day is frozen: no further movement, no second close', async () => {
    const movement = await fetchJson(url('/caisse/session/movements'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({ type: 'in', amount: 40, reason: 'apport' }),
    });
    expect(movement.status).toBe(409);

    const close = await fetchJson(url('/caisse/session/close'), {
      method: 'POST',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ countedTotal: 999 }),
    });
    expect(close.status).toBe(409);

    const sale = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'card',
        items: [{ kind: 'service', refId: new ObjectId().toString(), name: 'Coupe', qty: 1, unitPrice: 25 }],
      }),
    });
    // Carte comprise : le comptoir ne vend plus du tout après la clôture (décision explicite).
    expect(sale.status).toBe(409);
    expect(sale.body.data).toMatchObject({ code: 'CAISSE_CLOSED' });

    const reread = await testDb.db.collection('cashsessions').findOne({ salonId: tenantId });
    expect(reread?.variance).toBe(-4.5); // écart archivé intact
    expect(await testDb.db.collection('cashmovements').countDocuments({ salonId: tenantId })).toBe(1);
  });

  it('the manager reads the session history, closing entry included in the journal', async () => {
    const history = await fetchJson(url('/caisse/sessions'), { headers: authHeader(ownerToken()) });
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].variance).toBe(-4.5);

    const journal = await fetchJson(url('/caisse/journal'), { headers: authHeader(ownerToken()) });
    const kinds = journal.body.data.entries.map((e: { kind: string }) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('closing');
    expect(journal.body.data.session.status).toBe('closed');
  });

  it('a past day with no session reads as empty rather than failing', async () => {
    const res = await fetchJson(url('/caisse/journal?date=2020-01-01'), { headers: authHeader(ownerToken()) });
    expect(res.status).toBe(200);
    expect(res.body.data.day).toBe('2020-01-01');
    expect(res.body.data.session).toBeNull();
    expect(res.body.data.totals.expectedCash).toBe(0);
  });
});
