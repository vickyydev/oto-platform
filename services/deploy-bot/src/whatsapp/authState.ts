import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import type { Db } from '../db.js';

export interface PgAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** True once a phone has accepted this session, not merely been asked to. */
  isPaired(): boolean;
  /** Forget the session entirely: the next connection starts a new pairing. */
  wipe(): Promise<void>;
}

/**
 * Baileys' auth state, kept in Postgres instead of on disk so a restart or a
 * redeploy reconnects without anyone scanning anything. It is the library's
 * own `useMultiFileAuthState` with rows where that has files: one row for the
 * credentials, one per Signal key, the same `BufferJSON` encoding.
 *
 * What these rows hold is the WhatsApp session itself. Whoever can read them
 * can send as the bot's number.
 */
export async function usePgAuthState(db: Db): Promise<PgAuthState> {
  const table = `${db.s}.wa_auth`;

  const read = async (ids: string[]): Promise<Map<string, unknown>> => {
    if (ids.length === 0) return new Map();
    const r = await db.pool.query<{ id: string; value: string }>(
      `select id, value from ${table} where id = any($1)`,
      [ids],
    );
    return new Map(r.rows.map((row) => [row.id, JSON.parse(row.value, BufferJSON.reviver)]));
  };

  const write = async (rows: [id: string, value: unknown][]): Promise<void> => {
    if (rows.length === 0) return;
    await db.pool.query(
      `insert into ${table} (id, value)
       select * from unnest($1::text[], $2::text[])
       on conflict (id) do update set value = excluded.value, updated_at = now()`,
      [rows.map(([id]) => id), rows.map(([, v]) => JSON.stringify(v, BufferJSON.replacer))],
    );
  };

  const stored = (await read(['creds'])).get('creds') as AuthenticationCreds | undefined;
  let creds = stored ?? initAuthCreds();

  const state: AuthenticationState = {
    get creds() {
      return creds;
    },
    set creds(next) {
      creds = next;
    },
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const found = await read(ids.map((id) => `${type}-${id}`));
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = found.get(`${type}-${id}`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          if (value) out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: async (data) => {
        const upserts: [string, unknown][] = [];
        const deletes: string[] = [];
        for (const [type, byId] of Object.entries(data)) {
          for (const [id, value] of Object.entries(byId ?? {})) {
            if (value) upserts.push([`${type}-${id}`, value]);
            else deletes.push(`${type}-${id}`);
          }
        }
        await write(upserts);
        if (deletes.length > 0) {
          await db.pool.query(`delete from ${table} where id = any($1)`, [deletes]);
        }
      },
    },
  };

  return {
    state,
    saveCreds: () => write([['creds', creds]]),
    isPaired: () => Boolean(creds.account),
    wipe: async () => {
      await db.pool.query(`delete from ${table}`);
      creds = initAuthCreds();
    },
  };
}
