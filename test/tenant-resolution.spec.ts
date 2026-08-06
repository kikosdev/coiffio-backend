/**
 * Sprint 2 v2 Prompt 4 — resolveSalonId() par sous-domaine/slug, plus de fallback
 * DEFAULT_SALON_ID. `register()`/`register/client` doivent rattacher le client au tenant
 * réellement ciblé (sous-domaine ou `salonSlug` explicite), jamais un salon deviné.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { extractTenantSlugFromHost } from '../src/common/tenant/subdomain.util';

describe('tenant-resolution (Sprint 2 v2 Prompt 4)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantBeta: string;

  beforeAll(async () => {
    testDb = await startTestDb('tenant_resolution');
    testApp = await bootApp();
    const beta = await seedSalon(testDb.db, { slug: 'beta' });
    tenantBeta = beta.tenantId;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  describe('extractTenantSlugFromHost (pur, unitaire)', () => {
    it('sous-domaine réel → slug extrait', () => {
      expect(extractTenantSlugFromHost('alpha.salonos.com')).toBe('alpha');
    });
    it('localhost / 127.0.0.1 / domaine nu (≤2 labels) → undefined', () => {
      expect(extractTenantSlugFromHost('localhost')).toBeUndefined();
      expect(extractTenantSlugFromHost('127.0.0.1')).toBeUndefined();
      expect(extractTenantSlugFromHost('salonos.com')).toBeUndefined();
    });
    it('IPv4 à 4 labels (piège trouvé pendant ce prompt) → undefined, jamais "127" comme slug', () => {
      expect(extractTenantSlugFromHost('127.0.0.1')).toBeUndefined();
      expect(extractTenantSlugFromHost('192.168.1.42')).toBeUndefined();
    });
    it('sous-domaine réservé (www/api/app/admin) → undefined', () => {
      expect(extractTenantSlugFromHost('www.salonos.com')).toBeUndefined();
      expect(extractTenantSlugFromHost('api.salonos.com')).toBeUndefined();
    });
    it('hostname absent → undefined', () => {
      expect(extractTenantSlugFromHost(undefined)).toBeUndefined();
    });
  });

  // Note (Prompt 7) : "salonSlug=beta → client dans beta" et "slug inexistant → 404" sont
  // désormais ID-12/ID-13 dans `identity-multitenant.spec.ts` (suite canonique) — retirés
  // d'ici. Les cas restants (pas de slug du tout, salon suspendu, merge-on-phone) ne sont
  // pas parmi les 14 cas numérotés.
  describe('POST /auth/register — résolution par salonSlug explicite', () => {
    it('aucun salonSlug, aucun sous-domaine (127.0.0.1 en test) → 404, aucun user créé — jamais un salon deviné', async () => {
      const identifier = 'tr-no-salon-at-all@test.local';
      const res = await fetchJson(`${testApp.baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Unattached Client', identifier, phone: '+21620300003', password: 'RealPass123!',
        }),
      });
      expect(res.status).toBe(404);
      const userDoc = await testDb.db.collection('users').findOne({ identifier });
      expect(userDoc).toBeNull();
    });

    it('salon existant mais suspendu → toujours 404 (pas de statut "active")', async () => {
      const suspended = await seedSalon(testDb.db, { slug: 'gamma-suspended', status: 'suspended' });
      const identifier = 'tr-suspended-salon@test.local';
      const res = await fetchJson(`${testApp.baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Suspended Salon Client', identifier, phone: '+21620300004', password: 'RealPass123!', salonSlug: suspended.slug,
        }),
      });
      expect(res.status).toBe(404);
    });

    it('merge-on-phone reste scopé au tenant résolu : même téléphone, même slug → même client, pas de doublon', async () => {
      const phone = '+21620300005';
      const first = await fetchJson(`${testApp.baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Merge One', identifier: 'tr-merge-one@test.local', phone, password: 'RealPass123!', salonSlug: 'beta' }),
      });
      expect(first.status).toBe(201);

      const second = await fetchJson(`${testApp.baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Merge Two', identifier: 'tr-merge-two@test.local', phone, password: 'RealPass123!', salonSlug: 'beta' }),
      });
      // 2e inscription avec le même identifiant serait un conflit — ici un identifier DIFFÉRENT
      // mais le MÊME téléphone dans le MÊME tenant : merge-on-phone doit réutiliser le client.
      expect(second.status).toBe(201);

      const clientsWithPhone = await testDb.db.collection('clients').find({ salonId: tenantBeta, phone }).toArray();
      expect(clientsWithPhone).toHaveLength(1); // un seul client, pas un doublon
    });
  });

  describe('grep DEFAULT_SALON_ID — 0 lecture dans le code', () => {
    it('aucun process.env.DEFAULT_SALON_ID lu sous src/ (parcours fs pur, sans dépendance shell)', () => {
      const srcDir = path.join(__dirname, '..', 'src');
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith('.ts')) {
            const content = fs.readFileSync(full, 'utf-8');
            if (content.includes('process.env.DEFAULT_SALON_ID')) offenders.push(full);
          }
        }
      };
      walk(srcDir);
      expect(offenders).toEqual([]);
    });
  });
});
