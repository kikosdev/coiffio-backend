/**
 * Filet structurel contre l'oubli d'un modèle Mongoose dans le registry de scope
 * (SKILL Prompt 9, suite 4 / Prompt 3 `assertRegistryCoverage`). Énumère les modèles
 * réellement enregistrés par l'app au boot et échoue si l'un n'apparaît dans aucune des
 * quatre listes de scope. Ce test échoue naturellement (via le boot lui-même, qui appelle
 * `assertRegistryCoverage` dans `AppModule.onModuleInit`) dès qu'une future collection est
 * ajoutée sans décision de scope explicite — empêche structurellement l'oubli.
 */
import { startTestDb, stopTestDb, bootApp, stopApp, TestDb, TestApp } from './utils/test-app';
import { assertRegistryCoverage, GLOBAL, TENANT_SCOPED, LOCATION_SCOPED, UNSCOPED } from '../src/common/tenant/scoping-registry';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

describe('scoping-coverage', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  beforeAll(async () => {
    testDb = await startTestDb('scoping_coverage');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('boots without throwing — assertRegistryCoverage passed at startup', () => {
    // Si un modèle manquait au registry, `AppModule.onModuleInit` aurait déjà throw pendant
    // `bootApp()` dans `beforeAll` — Jest aurait échoué avant même d'atteindre ce test.
    expect(testApp.app).toBeDefined();
  });

  it('every collection registered on the live Mongoose connection is covered by the registry', () => {
    const connection = testApp.app.get<Connection>(getConnectionToken());
    const modelNames = connection.modelNames();
    const collectionNames = modelNames.map((name) => connection.model(name).collection.name);

    expect(() => assertRegistryCoverage(collectionNames)).not.toThrow();
  });

  it('no collection name is listed in more than one of GLOBAL/TENANT_SCOPED/LOCATION_SCOPED/UNSCOPED', () => {
    const all = [...GLOBAL, ...TENANT_SCOPED, ...LOCATION_SCOPED, ...UNSCOPED];
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const name of all) {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
    expect(duplicates).toEqual([]);
  });

  it('assertRegistryCoverage throws when a real collection is missing from the registry', () => {
    const connection = testApp.app.get<Connection>(getConnectionToken());
    const modelNames = connection.modelNames();
    const realCollections = modelNames.map((name) => connection.model(name).collection.name);
    expect(() => assertRegistryCoverage([...realCollections, 'some_future_collection_nobody_classified'])).toThrow(
      /some_future_collection_nobody_classified/,
    );
  });
});
