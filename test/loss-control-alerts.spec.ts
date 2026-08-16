/**
 * LC-6/LC-7/LC-10 — LossAlert : émission, seuils, isolation tenant (SKILL_loss_control_doses.md,
 * Prompt 5). Sept preuves :
 *   [1] Écart stock au-delà du seuil, AVEC baseline → LossAlert(stock_variance) créé + émis.
 *   [2] (clé) SANS baseline → aucune alerte, jamais (on n'alerte pas sur ce qu'on ne mesure pas).
 *   [3] LC-T10 : seuil produit (plus large) prime sur le seuil global (qui aurait déclenché).
 *   [4] staff_honesty / extreme_usage → severity 'warning', jamais 'critical'.
 *   [5] alertsEnabled=false → aucune alerte, quel que soit l'écart.
 *   [6] Anti-spam : même condition évaluée 2× → une seule alerte non lue.
 *   [7] (CRITIQUE) Isolation croisée réelle (sockets), + preuve que le test peut échouer.
 */
import { ObjectId } from 'mongodb';
import { io, Socket } from 'socket.io-client';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  signStaffJwt,
  signPosJwt,
  jsonHeaders,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { runWithTenant, TenantContext } from '../src/common/tenant/tenant-context';
import { LossAlertService } from '../src/loss-control/loss-alert.service';
import { roleRoom } from '../src/notifications/notifications.gateway';
import { SOCKET_EVENTS } from '../src/common/socket-events';

function ctxFor(tenantId: string, locationId: string): TenantContext {
  // `products` est LOCATION_SCOPED — le plugin injecte `locationId: ctx.locationId` dans
  // toute query sans filtre explicite ; un contexte construit à la main (hors requête HTTP)
  // doit porter le VRAI locationId du produit ciblé, sinon 404 fantôme (même piège qu'au P1).
  return { tenantId, locationId, locationIds: [locationId], role: 'owner', plan: 'starter', features: {}, limits: {} };
}

function connectSocket(origin: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(origin, { auth: { token }, reconnection: false, forceNew: true, transports: ['websocket', 'polling'] });
    const onConnect = () => {
      socket.off('connect_error', onError);
      resolve(socket);
    };
    const onError = (err: Error) => {
      socket.off('connect', onConnect);
      reject(err);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
}

function collectEvents(socket: Socket, event: string, windowMs: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    const handler = (payload: unknown) => received.push(payload);
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(received);
    }, windowMs);
  });
}

describe('loss-control alerts (Prompt 5)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistStaffId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_alerts');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-alerts-salon' });
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

  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });
  const stylistPosToken = () => signPosJwt({ staffId: stylistStaffId, salonId: tenantId, role: 'stylist' });

  async function setLossControl(
    tenant: string,
    body: Record<string, unknown>,
    owner: { userId: string; staffId: string } = { userId: ownerUserId, staffId: ownerStaffId },
  ) {
    const res = await fetchJson(`${testApp.baseUrl}/settings/loss-control`, {
      method: 'PATCH',
      headers: jsonHeaders(signStaffJwt({ sub: owner.userId, salonId: tenant, role: 'owner', staffId: owner.staffId })),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  async function seedProduct(tenant: string, loc: string, extra: Record<string, unknown> = {}) {
    const productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenant,
      locationId: loc,
      name: 'Coloration Majirel',
      price: 25,
      stock: 0,
      active: true,
      ...extra,
    });
    return productId;
  }

  async function countInventory(token: string, productId: ObjectId, countedStock: number) {
    return fetchJson(url('/pos/stock-movements/count'), {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ productId: productId.toString(), countedStock }),
    });
  }

  it('[1] a stock variance beyond threshold, with a baseline, creates and persists a LossAlert', async () => {
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15 });
    const productId = await seedProduct(tenantId, locationId);

    const first = await countInventory(stylistPosToken(), productId, 20); // baseline
    expect(first.status).toBe(201);
    const second = await countInventory(stylistPosToken(), productId, 10); // -50% vs baseline
    expect(second.status).toBe(201);

    const alerts = await fetchJson(url('/loss-control/alerts?kind=stock_variance'), { headers: authHeader(ownerToken()) });
    expect(alerts.status).toBe(200);
    const match = alerts.body.data.find((a: { productId: string }) => a.productId === productId.toString());
    expect(match).toMatchObject({
      kind: 'stock_variance',
      severity: 'critical',
      productId: productId.toString(),
      expected: 20,
      declared: 10,
      variancePct: -50,
      thresholdPct: 15,
      read: false,
    });
     
    console.log('PROOF [1] stock_variance alert:', JSON.stringify(match));
  });

  it('[2] KEY: without a baseline, checkStockVariance never creates or emits an alert', async () => {
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15 });
    const productId = await seedProduct(tenantId, locationId); // jamais inventorié

    const before = await testDb.db.collection('lossalerts').countDocuments({ salonId: tenantId, productId: productId.toString() });
    expect(before).toBe(0);

    const service = testApp.app.get(LossAlertService);
    const result = await runWithTenant(ctxFor(tenantId, locationId), () => service.checkStockVariance(productId.toString()));
    expect(result).toBeNull();

    const after = await testDb.db.collection('lossalerts').countDocuments({ salonId: tenantId, productId: productId.toString() });
    expect(after).toBe(0); // toujours zéro — pas de 0% trompeur, pas d'alerte du tout
     
    console.log('PROOF [2] no baseline -> checkStockVariance returned:', result, '- alerts in DB:', after);
  });

  it('[3] LC-T10: a wider product-specific threshold overrides the global one that would have fired', async () => {
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15 }); // seuil global bas
    const productId = await seedProduct(tenantId, locationId);

    // Seuil produit délibérément TRÈS large (80%) — l'écart -50% ci-dessous franchit le seuil
    // global (15%) mais PAS le seuil produit. Si le seuil produit ne primait pas, une alerte
    // serait émise (comme au test [1], mêmes chiffres).
    const dosesRes = await fetchJson(url(`/products/${productId.toString()}/doses`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ varianceThresholdPct: 80 }),
    });
    expect(dosesRes.status).toBe(200);

    await countInventory(stylistPosToken(), productId, 20); // baseline
    await countInventory(stylistPosToken(), productId, 10); // -50%, franchit 15% mais pas 80%

    const alerts = await fetchJson(url('/loss-control/alerts?kind=stock_variance'), { headers: authHeader(ownerToken()) });
    const match = alerts.body.data.find((a: { productId: string }) => a.productId === productId.toString());
    expect(match).toBeUndefined(); // aucune alerte — le seuil produit (80%) a primé
     
    console.log('PROOF [3] product threshold 80% overrides global 15% on a -50% swing -> no alert:', match);
  });

  it('[4] staff_honesty and extreme_usage alerts are always severity warning, never critical', async () => {
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15, extremeUsageFactor: 2 });

    const productId = await seedProduct(tenantId, locationId, { dosesPerUnit: 4, isConsumable: true });
    const serviceObjId = new ObjectId();
    await testDb.db.collection('services').insertOne({
      _id: serviceObjId,
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
    });

    // extreme_usage : 5 déclarées pour 2 attendues (facteur 2, seuil 4) — via un walk-in
    // atomique avec doses inline (Prompt 3-bis), pour aussi couvrir ce chemin de déclenchement.
    await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ openingFloat: 100 }),
    });
    const walkinRes = await fetchJson(url('/pos/sale-with-appointment'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        stylistId: stylistStaffId,
        method: 'cash',
        clientPhone: '20444000',
        items: [{ kind: 'service', refId: serviceObjId.toString(), name: 'Coloration', qty: 1, unitPrice: 60 }],
        doses: [{ productId: productId.toString(), dosesDeclared: 5 }],
      }),
    });
    expect(walkinRes.status).toBe(201);

    const extremeAlerts = await fetchJson(url('/loss-control/alerts?kind=extreme_usage'), { headers: authHeader(ownerToken()) });
    expect(extremeAlerts.status).toBe(200);
    expect(extremeAlerts.body.data.length).toBeGreaterThan(0);
    for (const a of extremeAlerts.body.data) {
      expect(a.severity).toBe('warning');
      expect(a.severity).not.toBe('critical');
    }

    // staff_honesty : plusieurs déclarations sur-déclarées pour LE MÊME staff, dans le mois.
    const stylistB = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Nadia',
    });
    const posTokenB = signPosJwt({ staffId: stylistB.staffId, salonId: tenantId, role: 'stylist' });
    for (let i = 0; i < 3; i++) {
      const w = await fetchJson(url('/pos/sale-with-appointment'), {
        method: 'POST',
        headers: jsonHeaders(posTokenB),
        body: JSON.stringify({
          stylistId: stylistB.staffId,
          method: 'cash',
          clientPhone: `2044410${i}`,
          items: [{ kind: 'service', refId: serviceObjId.toString(), name: 'Coloration', qty: 1, unitPrice: 60 }],
          doses: [{ productId: productId.toString(), dosesDeclared: 3 }], // 3 pour 2 attendues -> +50%, sous le facteur 2 (pas extreme_usage) mais au-dessus du seuil honnêteté 15%
        }),
      });
      expect(w.status).toBe(201);
    }

    const honestyAlerts = await fetchJson(
      url(`/loss-control/alerts?kind=staff_honesty`),
      { headers: authHeader(ownerToken()) },
    );
    expect(honestyAlerts.status).toBe(200);
    const staffBAlert = honestyAlerts.body.data.find((a: { stylistId: string }) => a.stylistId === stylistB.staffId);
    expect(staffBAlert).toBeTruthy();
    expect(staffBAlert.severity).toBe('warning');
    expect(staffBAlert.severity).not.toBe('critical');

     
    console.log('PROOF [4] extreme_usage severities:', extremeAlerts.body.data.map((a: { severity: string }) => a.severity));
     
    console.log('PROOF [4] staff_honesty alert:', JSON.stringify(staffBAlert));
  });

  it('[5] alertsEnabled=false: no alert regardless of a large variance', async () => {
    await setLossControl(tenantId, { alertsEnabled: false });
    const productId = await seedProduct(tenantId, locationId);

    await countInventory(stylistPosToken(), productId, 20);
    await countInventory(stylistPosToken(), productId, 1); // -95% !

    const count = await testDb.db.collection('lossalerts').countDocuments({ salonId: tenantId, productId: productId.toString() });
    expect(count).toBe(0);
     
    console.log('PROOF [5] alertsEnabled=false, -95% variance -> alerts created:', count);
  });

  it('[6] anti-spam: evaluating the same stock_variance condition twice does not duplicate an unread alert', async () => {
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15 });
    const productId = await seedProduct(tenantId, locationId);

    await countInventory(stylistPosToken(), productId, 20);
    await countInventory(stylistPosToken(), productId, 10); // -50%, franchit le seuil -> 1ère alerte

    const afterFirst = await testDb.db
      .collection('lossalerts')
      .countDocuments({ salonId: tenantId, productId: productId.toString(), kind: 'stock_variance', read: false });
    expect(afterFirst).toBe(1);

    // Ré-évalue EXACTEMENT la même condition (aucun mouvement entre-temps) directement via le
    // service — l'anti-spam doit refuser une 2e alerte tant que la 1ère reste non lue.
    const service = testApp.app.get(LossAlertService);
    const second = await runWithTenant(ctxFor(tenantId, locationId), () => service.checkStockVariance(productId.toString()));
    expect(second).toBeNull();

    const afterSecond = await testDb.db
      .collection('lossalerts')
      .countDocuments({ salonId: tenantId, productId: productId.toString(), kind: 'stock_variance', read: false });
    expect(afterSecond).toBe(1); // toujours 1, pas 2
     
    console.log('PROOF [6] unread stock_variance alerts after 2 identical evaluations:', afterSecond);
  });

  it('[7] CRITICAL: real cross-tenant socket isolation — an alert never crosses tenants, and the test can actually fail', async () => {
    // ─── Second tenant, entièrement séparé ──────────────────────────────────
    const salonB = await seedSalon(testDb.db, { slug: 'lc-alerts-salon-b' });
    const tenantBId = salonB.tenantId;
    const locationBId = salonB.locations[0].id;
    const ownerB = await seedStaff(testDb.db, {
      tenantId: tenantBId,
      role: 'owner',
      locationIds: [locationBId],
      defaultLocationId: locationBId,
      name: 'Patron B',
    });
    await setLossControl(tenantBId, { alertsEnabled: true, varianceThresholdPct: 15 }, ownerB);
    await setLossControl(tenantId, { alertsEnabled: true, varianceThresholdPct: 15 });

    const productA = await seedProduct(tenantId, locationId);
    const productB = await seedProduct(tenantBId, locationBId);

    const tokenA = ownerToken();
    const tokenB = signStaffJwt({ sub: ownerB.userId, salonId: tenantBId, role: 'owner', staffId: ownerB.staffId });
    const origin = testApp.baseUrl.replace(/\/api$/, '');

    const socketA = await connectSocket(origin, tokenA);
    const socketB = await connectSocket(origin, tokenB);
    try {
      // ── (a) Alerte tenant A : B ne doit RIEN recevoir ────────────────────
      const waitA1 = collectEvents(socketA, SOCKET_EVENTS.LOSS_ALERT, 1500);
      const waitB1 = collectEvents(socketB, SOCKET_EVENTS.LOSS_ALERT, 1500);
      await countInventory(stylistPosToken(), productA, 20);
      await countInventory(stylistPosToken(), productA, 10); // -50%, déclenche pour A
      const [eventsA1, eventsB1] = await Promise.all([waitA1, waitB1]);
      expect(eventsA1).toHaveLength(1); // A reçoit SA propre alerte
      expect(eventsB1).toHaveLength(0); // B ne reçoit RIEN du salon A

      // ── (b) CONTRÔLE POSITIF : alerte tenant B, pour prouver que le socket B fonctionne
      //        réellement (sinon "B ne reçoit rien" serait vrai même avec un listener cassé,
      //        et la preuve (a) ne prouverait rien).
      const posTokenB = signPosJwt({ staffId: ownerB.staffId, salonId: tenantBId, role: 'owner' });
      const waitA2 = collectEvents(socketA, SOCKET_EVENTS.LOSS_ALERT, 1500);
      const waitB2 = collectEvents(socketB, SOCKET_EVENTS.LOSS_ALERT, 1500);
      await countInventory(posTokenB, productB, 20);
      await countInventory(posTokenB, productB, 10); // -50%, déclenche pour B
      const [eventsA2, eventsB2] = await Promise.all([waitA2, waitB2]);
      expect(eventsB2).toHaveLength(1); // B reçoit SA propre alerte — le listener fonctionne
      expect(eventsA2).toHaveLength(0); // et A ne reçoit toujours rien du salon B

       
      console.log('PROOF [7a/b] A<-A:', eventsA1.length, 'B<-A:', eventsB1.length, '| B<-B:', eventsB2.length, 'A<-B:', eventsA2.length);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }

    // ── (c) Le test PEUT échouer : `roleRoom()` scope réellement par tenant. Une room
    //        littérale non scopée (l'ancien bug corrigé avant cette session) ferait
    //        collisionner A et B dans LA MÊME room — c'est structurellement ce qui aurait
    //        fait échouer (a)/(b) ci-dessus si la régression revenait.
    const roomA = roleRoom(tenantId, 'owner');
    const roomB = roleRoom(tenantBId, 'owner');
    expect(roomA).not.toBe(roomB);
    const legacyUnscopedRoom = 'role:owner'; // format d'avant le fix cross-tenant
     
    console.log('PROOF [7c] roomA:', roomA, 'roomB:', roomB, '— un littéral non scopé aurait été IDENTIQUE pour les deux:', legacyUnscopedRoom);
    expect(roomA).not.toBe(legacyUnscopedRoom); // roomA est bien scopée, jamais le littéral nu
    expect(roomB).not.toBe(legacyUnscopedRoom);
  });
});
