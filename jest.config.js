/**
 * Prompt 9 (SKILL_saas_sprint1_tenant_isolation_v2). Chaque fichier de `test/*.spec.ts` boot
 * son propre `MongoMemoryReplSet` (transactions réelles, requises par le provisioning —
 * jamais standalone) et sa propre instance Nest — isolation totale entre suites, même
 * pattern que les preuves scratch des Prompts 6/7/8, maintenant permanent. `testTimeout`
 * large : démarrage d'un replica set mémoire + boot Nest prend plusieurs secondes.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  testTimeout: 60_000,
  maxWorkers: 4,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/scripts/**'],
  coverageDirectory: 'coverage',
};
