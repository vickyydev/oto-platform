import { describe, expect, it } from 'vitest';
import { assertProductionSafe, type Env } from '../src/env';

/**
 * S2-01b — production refuses to boot on a development default. The failure
 * this prevents is the quiet one: a service that starts happily against the
 * local database and only reveals it once real data is in the wrong place.
 */

const productionEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    NODE_ENV: 'production',
    DEPLOY_ENV: 'production',
    DATABASE_URL: 'postgres://oto_app:s3cret@dpg-xyz.singapore-postgres.render.com:5432/oto',
    COOKIE_SECURE: true,
    MINIO_ACCESS_KEY: 'AKIAREAL',
    MINIO_SECRET_KEY: 'a-real-secret',
    OPS_TEST_CONTROLS: false,
    SEED_PROFILE: 'production',
    SMS_ADAPTER: 'twilio',
    ...overrides,
  }) as Env;

/** Staging: the same production build, against throwaway data. */
const stagingEnv = (overrides: Partial<Env> = {}): Env =>
  productionEnv({
    DEPLOY_ENV: 'staging',
    OPS_TEST_CONTROLS: true,
    SEED_PROFILE: 'staging',
    SMS_ADAPTER: 'console',
    ...overrides,
  });

describe('production boot guard (S2-01b)', () => {
  it('accepts a properly configured production environment', () => {
    expect(() => assertProductionSafe(productionEnv())).not.toThrow();
  });

  it('refuses a database on localhost', () => {
    expect(() =>
      assertProductionSafe(productionEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/oto' })),
    ).toThrow(/localhost/);
  });

  it('refuses the development database credentials', () => {
    expect(() =>
      assertProductionSafe(productionEnv({ DATABASE_URL: 'postgres://oto:oto@db.internal:5432/oto' })),
    ).toThrow(/development credentials/);
  });

  it('refuses the demo object-storage credentials', () => {
    expect(() => assertProductionSafe(productionEnv({ MINIO_ACCESS_KEY: 'oto' }))).toThrow(
      /MINIO_ACCESS_KEY/,
    );
    expect(() => assertProductionSafe(productionEnv({ MINIO_SECRET_KEY: 'otosecret123' }))).toThrow(
      /MINIO_SECRET_KEY/,
    );
  });

  it('refuses a session cookie that would travel in the clear', () => {
    expect(() => assertProductionSafe(productionEnv({ COOKIE_SECURE: false }))).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('reports every problem at once, not one per restart', () => {
    try {
      assertProductionSafe(
        productionEnv({
          DATABASE_URL: 'postgres://oto:oto@localhost:5432/oto',
          MINIO_ACCESS_KEY: 'oto',
          COOKIE_SECURE: false,
        }),
      );
      throw new Error('should have refused');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('localhost');
      expect(message).toContain('MINIO_ACCESS_KEY');
      expect(message).toContain('COOKIE_SECURE');
    }
  });

  it('leaves development and test alone', () => {
    expect(() =>
      assertProductionSafe(
        productionEnv({
          NODE_ENV: 'development',
          DEPLOY_ENV: 'local',
          DATABASE_URL: 'postgres://oto:oto@localhost:5432/oto',
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * S2-01c — staging is the production BUILD against throwaway data, so
 * NODE_ENV cannot be what decides whether the playground controls exist.
 */
describe('staging versus production (S2-01c)', () => {
  it('lets staging keep the demo reset, the seeded tenant and console codes', () => {
    expect(() => assertProductionSafe(stagingEnv())).not.toThrow();
  });

  it('refuses the demo reset on production', () => {
    expect(() => assertProductionSafe(productionEnv({ OPS_TEST_CONTROLS: true }))).toThrow(
      /OPS_TEST_CONTROLS/,
    );
  });

  it('refuses to seed the demo tenant into production', () => {
    expect(() => assertProductionSafe(productionEnv({ SEED_PROFILE: 'staging' }))).toThrow(
      /SEED_PROFILE/,
    );
  });

  it('refuses to print verification codes to the log on production', () => {
    expect(() => assertProductionSafe(productionEnv({ SMS_ADAPTER: 'console' }))).toThrow(
      /SMS_ADAPTER/,
    );
  });

  it('still refuses a development default on staging', () => {
    expect(() => assertProductionSafe(stagingEnv({ MINIO_ACCESS_KEY: 'oto' }))).toThrow(
      /MINIO_ACCESS_KEY/,
    );
  });
});
