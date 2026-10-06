import pg from 'pg';

export interface Db {
  pool: pg.Pool;
  /** Quoted schema name, safe to interpolate: validated in env.ts. */
  s: string;
  close(): Promise<void>;
}

/** A pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

/**
 * The bot shares the platform's Postgres but owns one schema in it, created
 * here rather than in packages/db: Drizzle's `schemaFilter` and
 * `verify-schema` only look at the platform's schemas, so these tables are
 * invisible to the platform's migrations and its checks. Removing the bot is
 * `DROP SCHEMA deploybot CASCADE`.
 *
 * It keeps very little: the WhatsApp session, the messages waiting to go out,
 * and two markers — what was last announced and when. What was deployed is
 * read from Render and GitHub at digest time, never copied here.
 *
 * The pool is capped at three connections so the bot can never starve the api
 * of database connections.
 */
export async function openDb(databaseUrl: string, schema: string): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    application_name: 'oto-deploy-bot',
  });
  const s = `"${schema}"`;

  await pool.query(`create schema if not exists ${s}`);
  await pool.query(`
    create table if not exists ${s}.wa_auth (
      id text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists ${s}.outbox (
      id bigserial primary key,
      body text not null,
      created_at timestamptz not null default now(),
      send_after timestamptz not null default now(),
      expires_at timestamptz not null,
      sent_at timestamptz,
      attempts integer not null default 0,
      last_error text
    );
    create index if not exists outbox_unsent
      on ${s}.outbox (send_after, id) where sent_at is null;

    create table if not exists ${s}.kv (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );
  `);

  return { pool, s, close: () => pool.end() };
}

export async function kvGet(q: Queryable, s: string, key: string): Promise<string | null> {
  const r = await q.query<{ value: string }>(`select value from ${s}.kv where key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function kvSet(q: Queryable, s: string, key: string, value: string): Promise<void> {
  await q.query(
    `insert into ${s}.kv (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}
