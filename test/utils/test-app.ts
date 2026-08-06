/**
 * Helper partagé par toutes les suites d'intégration (Prompt 9). Chaque fichier de spec
 * boot son propre `MongoMemoryReplSet` (transactions réelles requises par le provisioning
 * — jamais standalone, comme Atlas en prod) + sa propre instance Nest, isolation totale
 * entre suites. Mêmes patterns que les preuves scratch des Prompts 6/7/8, rendus permanents.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';

export const JWT_SECRET = 'test-jwt-secret';
export const CP_SHARED_SECRET = 'test-cp-shared-secret';

export interface TestDb {
  replSet: MongoMemoryReplSet;
  client: MongoClient;
  db: Db;
}

export async function startTestDb(dbName: string): Promise<TestDb> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(dbName);
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_EXPIRES = '1h';
  process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
  process.env.CP_SHARED_SECRET = CP_SHARED_SECRET;
  delete process.env.CP_URL;
  delete process.env.CP_PUBLIC_KEY;
  delete process.env.CP_ALLOWED_IPS;
  delete process.env.CP_SHARED_SECRET_PREVIOUS;
  // `AuthModule` loads `ConfigModule.forRoot({isGlobal:true})`, qui charge le vrai `.env`
  // via dotenv (override:false — ne touche pas MONGO_URI, déjà posé ci-dessus) — mais rien
  // ne posait DEFAULT_SALON_ID, donc il fuitait depuis le vrai `.env` (le salon mono-tenant
  // de prod) dans CHAQUE run de test, faisant tomber `AuthService.resolveSalonId()` sur ce
  // salon réel au lieu du tenant seedé par le test. Trouvé le 2026-08-01 via le test
  // `register()` de `auth-by-role.spec.ts` — le seul test à exercer ce chemin.
  delete process.env.DEFAULT_SALON_ID;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  return { replSet, client, db };
}

export async function stopTestDb(testDb: TestDb): Promise<void> {
  await testDb.client.close();
  await testDb.replSet.stop();
}

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
}

/** Boot RÉUTILISANT `configureApp()` — même fonction que `main.ts` de prod (Prompt 9), pas
 *  une copie parallèle qui pourrait diverger silencieusement (rawBody, préfixe /api). */
export async function bootApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], rawBody: true });
  configureApp(app);
  await app.listen(0);
  // Les index (dont `locations.geo: '2dsphere'`, requis par $geoNear) se construisent en
  // arrière-plan après `listen()` — sans cette attente explicite, une requête discovery
  // lancée juste après le boot arrive parfois avant que l'index existe réellement.
  // `Model.init()` (pas `connection.syncIndexes()`) : `syncIndexes()` tente de RÉCONCILIER
  // les index déclarés et échoue dur sur le doublon connu (et non bloquant jusqu'ici)
  // `staffs.userId` (une déclaration `unique` + une non-`unique` sur la même clé — dette
  // déjà trackée, cosmétique en autoIndex normal). `Model.init()` attend juste la fin de la
  // construction autoIndex, sans tenter de la corriger.
  const connection = app.get<Connection>(getConnectionToken());
  await Promise.all(connection.modelNames().map((name) => connection.model(name).init()));
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}/api` };
}

export async function stopApp(testApp: TestApp): Promise<void> {
  await testApp.app.close();
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export interface JsonResponse<T = any> {
  status: number;
  body: { data: T; message: string; statusCode: number } | any;
}

export async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* empty body ok */
  }
  return { status: res.status, body };
}

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function jsonHeaders(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? authHeader(token) : {}) };
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

export interface StaffJwtInput {
  sub: string;
  salonId: string;
  role: 'owner' | 'manager' | 'stylist' | 'colorist';
  staffId: string;
  name?: string;
  email?: string;
  /** DP-SWEEP (Sprint 3 v2) — même forme que le JWT réel émis par
   *  `InternalService.impersonate()` (`internal.service.ts`), pour tester `@Destructive()`
   *  sans dépendre d'un vrai flux d'impersonation CP→DP de bout en bout. */
  impersonatedBy?: string;
  impersonationReason?: string;
}

export function signStaffJwt(input: StaffJwtInput): string {
  return jwt.sign({ ...input, accountType: 'staff' }, JWT_SECRET, { expiresIn: '1h' });
}

export interface ClientJwtInput {
  sub: string;
  salonId: string;
  clientId: string;
  name?: string;
}

export function signClientJwt(input: ClientJwtInput): string {
  return jwt.sign({ ...input, role: 'client', accountType: 'client' }, JWT_SECRET, { expiresIn: '1h' });
}

export interface PosJwtInput {
  staffId: string;
  salonId: string;
  role: 'owner' | 'manager' | 'stylist' | 'colorist';
}

export function signPosJwt(input: PosJwtInput): string {
  return jwt.sign({ ...input, scope: 'pos' }, JWT_SECRET, { expiresIn: '1h' });
}

// ─── Signature HMAC /internal/* ────────────────────────────────────────────────

export function signInternal(bodyStr: string, tsOverride?: number): { signature: string; timestamp: string } {
  return signInternalWithSecret(bodyStr, CP_SHARED_SECRET, tsOverride);
}

/** Signe avec un secret ARBITRAIRE — utilisé par le test de rotation (Delta 4, Prompt 9)
 *  pour prouver qu'une requête signée avec l'ANCIEN secret (`CP_SHARED_SECRET_PREVIOUS`
 *  côté DP) est toujours acceptée pendant la fenêtre de rotation. */
export function signInternalWithSecret(bodyStr: string, secret: string, tsOverride?: number): { signature: string; timestamp: string } {
  const timestamp = String(tsOverride ?? Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');
  return { signature, timestamp };
}

export function internalHeaders(bodyStr: string, tsOverride?: number): Record<string, string> {
  const { signature, timestamp } = signInternal(bodyStr, tsOverride);
  return { 'Content-Type': 'application/json', 'x-cp-signature': signature, 'x-cp-timestamp': timestamp };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

export interface SeededLocation {
  id: string;
  slug: string;
  isPrimary: boolean;
}

export interface SeededTenant {
  tenantId: string;
  slug: string;
  locations: SeededLocation[];
}

export async function seedSalon(
  db: Db,
  opts: { slug: string; name?: string; locationSlugs?: string[]; status?: 'active' | 'suspended' | 'churned' },
): Promise<SeededTenant> {
  const tenantId = new ObjectId();
  await db.collection('salons').insertOne({
    _id: tenantId,
    name: opts.name ?? `Salon ${opts.slug}`,
    slug: opts.slug,
    status: opts.status ?? 'active',
    timezone: 'Africa/Tunis',
    currency: 'TND',
    taxRate: 19,
  });

  const slugs = opts.locationSlugs?.length ? opts.locationSlugs : ['principal'];
  const locations: SeededLocation[] = [];
  for (let i = 0; i < slugs.length; i++) {
    const locId = new ObjectId();
    const isPrimary = i === 0;
    await db.collection('locations').insertOne({
      _id: locId,
      salonId: tenantId.toString(),
      name: slugs[i],
      slug: slugs[i],
      address: { line1: '', city: '', postalCode: '', country: '' },
      phone: '',
      timezone: 'Africa/Tunis',
      openingHours: [],
      isPrimary,
      active: true,
    });
    locations.push({ id: locId.toString(), slug: slugs[i], isPrimary });
  }

  return { tenantId: tenantId.toString(), slug: opts.slug, locations };
}

export interface SeededStaff {
  staffId: string;
  userId: string;
}

export async function seedStaff(
  db: Db,
  opts: {
    tenantId: string;
    role: 'owner' | 'manager' | 'stylist' | 'colorist';
    locationIds: string[];
    defaultLocationId: string;
    name?: string;
    posEnabled?: boolean;
    identifier?: string;
  },
): Promise<SeededStaff> {
  const userId = new ObjectId();
  const staffId = new ObjectId();
  const identifier = opts.identifier ?? `${opts.role}-${staffId.toString()}@test.local`;
  await db.collection('users').insertOne({
    _id: userId,
    identifier,
    identifierType: 'email',
    passwordHash: 'x',
    role: opts.role === 'owner' ? 'owner' : 'staff',
    isActive: true,
  });
  await db.collection('staffs').insertOne({
    _id: staffId,
    salonId: opts.tenantId,
    userId,
    name: opts.name ?? `${opts.role} test`,
    email: identifier,
    phone: '',
    role: opts.role,
    color: '#B89968',
    isActive: true,
    locationIds: opts.locationIds,
    defaultLocationId: opts.defaultLocationId,
    acceptingBookings: true,
    posEnabled: opts.posEnabled ?? true,
    publicProfile: { visible: true, order: 0 },
  });
  // Sprint 2 v2 Prompt 2 : TenantContextMiddleware résout désormais le tenant actif via
  // un Membership réel (relu depuis la base à chaque requête, jamais depuis le JWT seul,
  // même pour un token pré-signé "legacy" comme `signStaffJwt` — vérifié contre les
  // memberships actifs). Sans ce Membership, TOUTE requête authentifiée de ce fixture
  // recevrait 403 TENANT_FORBIDDEN, peu importe le rôle du JWT.
  await db.collection('memberships').insertOne({
    userId,
    tenantId: opts.tenantId,
    kind: 'staff',
    staffId,
    role: opts.role,
    locationIds: opts.locationIds,
    defaultLocationId: opts.defaultLocationId,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { staffId: staffId.toString(), userId: userId.toString() };
}

export async function seedClient(
  db: Db,
  opts: { tenantId: string; phone: string; name?: string; userId?: string | null },
): Promise<{ clientId: string }> {
  const clientId = new ObjectId();
  await db.collection('clients').insertOne({
    _id: clientId,
    salonId: opts.tenantId,
    userId: opts.userId ? new ObjectId(opts.userId) : null,
    name: opts.name ?? 'Client Test',
    phone: opts.phone,
    email: '',
    commsConsent: true,
    preferredChannel: 'email',
    notes: '',
    history: [],
  });
  // Même raison que dans seedStaff : un client AVEC compte (userId non-null) a besoin
  // d'un Membership réel pour que TenantContextMiddleware résolve son tenant. Un client
  // walk-in (userId absent) n'en a pas besoin — il ne se connecte jamais.
  if (opts.userId) {
    const activeLocations = await db.collection('locations').find({ salonId: opts.tenantId, active: true }).toArray();
    const primary = activeLocations.find((l) => l.isPrimary) ?? activeLocations[0];
    await db.collection('memberships').insertOne({
      userId: new ObjectId(opts.userId),
      tenantId: opts.tenantId,
      kind: 'client',
      clientId,
      role: 'client',
      locationIds: activeLocations.map((l) => l._id.toString()),
      defaultLocationId: primary?._id.toString(),
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return { clientId: clientId.toString() };
}

export async function seedService(
  db: Db,
  opts: { tenantId: string; name: string; price?: number; durationMin?: number; isPublic?: boolean; active?: boolean },
): Promise<{ serviceId: string }> {
  const serviceId = new ObjectId();
  await db.collection('services').insertOne({
    _id: serviceId,
    salonId: opts.tenantId,
    name: opts.name,
    category: '',
    gender: 'universal',
    price: opts.price ?? 30,
    durationMin: opts.durationMin ?? 30,
    bufferMin: 0,
    color: '#B89968',
    active: opts.active ?? true,
    isFeatured: false,
    featuredOrder: 0,
    isPublic: opts.isPublic ?? true,
  });
  return { serviceId: serviceId.toString() };
}

export async function seedAppointment(
  db: Db,
  opts: {
    tenantId: string;
    locationId: string;
    stylistId: string;
    clientId: string;
    start: Date;
    end: Date;
    status?: string;
    services?: string[];
  },
): Promise<{ appointmentId: string }> {
  const id = new ObjectId();
  await db.collection('appointments').insertOne({
    _id: id,
    salonId: opts.tenantId,
    locationId: opts.locationId,
    stylistId: new ObjectId(opts.stylistId),
    clientId: new ObjectId(opts.clientId),
    groupId: id.toString(),
    services: (opts.services ?? []).map((s) => new ObjectId(s)),
    start: opts.start,
    startDay: opts.start.toISOString().slice(0, 10),
    end: opts.end,
    status: opts.status ?? 'booked',
    source: 'online',
    price: 30,
  });
  return { appointmentId: id.toString() };
}
