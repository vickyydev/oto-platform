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
    MINIO_ENDPOINT: 'abc123.r2.cloudflarestorage.com',
    MINIO_PORT: 443,
    MINIO_USE_SSL: true,
    MINIO_ACCESS_KEY: 'AKIAREAL',
    MINIO_SECRET_KEY: 'a-real-secret',
    OPS_TEST_CONTROLS: false,
    SEED_PROFILE: 'production',
    SMS_ADAPTER: 'twilio',
    // S2-11: a live park signs its bands with a key of its own.
    BAND_HMAC_KEY: 'a-real-band-key-of-sufficient-length',
    ...overrides,
  }) as Env;

/** Staging: the same production build, against throwaway data. */
const stagingEnv = (overrides: Partial<Env> = {}): Env =>
  productionEnv({
    DEPLOY_ENV: 'staging',
    OPS_TEST_CONTROLS: true,
    SEED_PROFILE: 'staging',
    ...overrides,
  });

describe('production boot guard (S2-01b)', () => {
  /**
   * The gateway credentials are named HERE rather than on the fixture, and
   * they are the only reason this env is fuller than the others. A production
   * deployment with no `PGW_MERCHANT_ID` or `PGW_SECRET_KEY` falls back to the
   * pretend gateway and is refused (S2-10a), so "properly configured" now
   * includes having one. Every other env in this file stays PARTIAL — naming
   * only what its own rule reads — which is what keeps the guard honest about
   * fields that are simply not there.
   */
  it('accepts a properly configured production environment', () => {
    expect(() =>
      assertProductionSafe(
        productionEnv({ PGW_PROVIDER: '2c2p', PGW_MERCHANT_ID: 'M1', PGW_SECRET_KEY: 'k'.repeat(32) }),
      ),
    ).not.toThrow();
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

  it('refuses a production with no band key, or with the development one (S2-11)', () => {
    expect(() => assertProductionSafe(productionEnv({ BAND_HMAC_KEY: '' }))).toThrow(/BAND_HMAC_KEY is not set/);
    expect(() =>
      assertProductionSafe(productionEnv({ BAND_HMAC_KEY: 'oto-local-development-band-key' })),
    ).toThrow(/BAND_HMAC_KEY is the development key/);
    // Staging may run without one: the sale finalises and says no band was issued.
    expect(() => assertProductionSafe(stagingEnv({ BAND_HMAC_KEY: '' }))).not.toThrow();
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
  it('lets staging keep the demo reset and the seeded tenant', () => {
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

  /**
   * Staging is not a rehearsal for this one. People sign up on it with their
   * real phones, so a code that only reaches the log is a person who cannot
   * finish setting up their account.
   */
  it('refuses to print verification codes to the log on staging either', () => {
    expect(() => assertProductionSafe(stagingEnv({ SMS_ADAPTER: 'console' }))).toThrow(
      /SMS_ADAPTER/,
    );
  });

  it('leaves the console adapter alone on a local machine', () => {
    expect(() =>
      assertProductionSafe(
        productionEnv({
          NODE_ENV: 'development',
          DEPLOY_ENV: 'local',
          DATABASE_URL: 'postgres://oto:oto@localhost:5432/oto',
          SMS_ADAPTER: 'console',
        }),
      ),
    ).not.toThrow();
  });

  it('still refuses a development default on staging', () => {
    expect(() => assertProductionSafe(stagingEnv({ MINIO_ACCESS_KEY: 'oto' }))).toThrow(
      /MINIO_ACCESS_KEY/,
    );
  });
});

/**
 * S2-01d — the storage endpoint is the variable a deploy leaves at its
 * default without anything complaining: the api boots clean and healthy, and
 * the first profile photo discovers there is no object storage on this host.
 */
describe('object storage on a deployment (S2-01d)', () => {
  it('refuses storage on localhost', () => {
    expect(() => assertProductionSafe(productionEnv({ MINIO_ENDPOINT: 'localhost' }))).toThrow(
      /MINIO_ENDPOINT/,
    );
    expect(() => assertProductionSafe(productionEnv({ MINIO_ENDPOINT: '127.0.0.1' }))).toThrow(
      /MINIO_ENDPOINT/,
    );
  });

  it('refuses storage on localhost on staging too', () => {
    expect(() => assertProductionSafe(stagingEnv({ MINIO_ENDPOINT: 'localhost' }))).toThrow(
      /MINIO_ENDPOINT/,
    );
  });

  // A presigned URL is a bearer credential for the object it names.
  it('refuses presigned URLs over plain HTTP', () => {
    expect(() => assertProductionSafe(productionEnv({ MINIO_USE_SSL: false }))).toThrow(
      /MINIO_USE_SSL/,
    );
    expect(() => assertProductionSafe(stagingEnv({ MINIO_USE_SSL: false }))).toThrow(
      /MINIO_USE_SSL/,
    );
  });

  /**
   * The value is a host. Pasted from a storage console it arrives as a URL,
   * and the storage client refuses it before anything of ours runs — a boot
   * crash with a stack trace where a named refusal belongs.
   */
  it('refuses an endpoint pasted in as a URL', () => {
    expect(() =>
      assertProductionSafe(
        productionEnv({ MINIO_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com' }),
      ),
    ).toThrow(/MINIO_ENDPOINT is a URL/);
    expect(() =>
      assertProductionSafe(
        productionEnv({ MINIO_ENDPOINT: 'abc123.r2.cloudflarestorage.com/oto-files' }),
      ),
    ).toThrow(/MINIO_ENDPOINT is a URL/);
  });

  // The port rides inside every presigned URL, so a wrong one fails in the
  // visitor's browser rather than here.
  it('refuses the local MinIO port', () => {
    expect(() => assertProductionSafe(productionEnv({ MINIO_PORT: 9000 }))).toThrow(/MINIO_PORT/);
  });

  it('leaves the MinIO container on a local machine alone', () => {
    expect(() =>
      assertProductionSafe(
        productionEnv({
          NODE_ENV: 'development',
          DEPLOY_ENV: 'local',
          DATABASE_URL: 'postgres://oto:oto@localhost:5432/oto',
          SMS_ADAPTER: 'console',
          MINIO_ENDPOINT: 'localhost',
          MINIO_PORT: 9000,
          MINIO_USE_SSL: false,
          MINIO_ACCESS_KEY: 'oto',
          MINIO_SECRET_KEY: 'otosecret123',
        }),
      ),
    ).not.toThrow();
  });
});
