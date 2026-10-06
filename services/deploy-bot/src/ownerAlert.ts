import type { Logger } from 'pino';
import { kvGet, kvSet, type Db } from './db.js';
import type { Env } from './env.js';

const REPEAT_AFTER_MS = 6 * 60 * 60_000;

/**
 * The one message that cannot go over WhatsApp: "the WhatsApp session is
 * gone". Sent as an SMS through Twilio when it is configured, and always
 * logged at error level. Repeats of the same reason are held for six hours so
 * a flapping connection cannot run up a bill.
 */
export async function alertOwner(
  env: Env,
  db: Db,
  log: Logger,
  reason: string,
  text: string,
): Promise<void> {
  log.error({ reason }, text);

  const key = `owner_alert:${reason}`;
  const last = await kvGet(db.pool, db.s, key);
  if (last && Date.now() - Number(last) < REPEAT_AFTER_MS) return;

  const user = env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID;
  const pass = env.TWILIO_API_KEY_SID ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN;
  if (!env.OWNER_PHONE || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_FROM || !user || !pass) return;

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: `+${env.OWNER_PHONE}`,
          From: env.TWILIO_FROM,
          Body: `[deploy-bot] ${text}`,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`Twilio answered ${res.status}`);
    await kvSet(db.pool, db.s, key, String(Date.now()));
  } catch (err) {
    log.error({ err }, 'owner alert could not be sent');
  }
}
