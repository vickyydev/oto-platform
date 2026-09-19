import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { AppError } from '../lib/errors';
import { phoneHash } from '../lib/scrub';

/**
 * SMS delivery (SCRUM-20, hardened in S2-01c).
 *
 * A verification code is the only way a member of staff finishes setting up
 * an account or recovers a password, so "the SMS did not go out" is a person
 * locked out of the till, not a line in a log. Two adapters exist, chosen by
 * SMS_ADAPTER:
 *  - "console": writes the message to the api log. This is genuinely how a
 *    code is delivered on a developer's machine, and it is a configuration
 *    error anywhere else — `assertProductionSafe` refuses it on a deployment,
 *    staging included.
 *  - "twilio": Twilio's REST API. Needs TWILIO_ACCOUNT_SID, TWILIO_FROM (an
 *    SMS-capable Twilio number in E.164, or a Messaging Service SID starting
 *    "MG") and one of two credential shapes:
 *      * TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET — an API key, and the
 *        shape to prefer. It is revocable and rotatable on its own, so the day
 *        this deployment's credential is replaced is not the day every other
 *        integration on the account breaks.
 *      * TWILIO_AUTH_TOKEN — the account's master password. It works, it is
 *        what the dashboard shows first, and it can do anything the account
 *        can do.
 *    The key wins when both are present. Either way the URL path names the
 *    ACCOUNT, so TWILIO_ACCOUNT_SID is required in both shapes.
 *
 * A misconfigured adapter now fails at construction — which is boot — rather
 * than at the first person who needs a code. Until S2-01c both the
 * missing-credential and the unknown-adapter case warned and fell back to the
 * console adapter, which is three failures at once: nobody receives a code,
 * the code is written into a hosted log stream, and the only signal is one
 * warning line.
 */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

export interface SmsConfig {
  adapter: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioApiKeySid?: string;
  twilioApiKeySecret?: string;
  twilioFrom?: string;
}

export const SMS_ADAPTERS = ['console', 'twilio'] as const;

/**
 * The recipient is never logged in the clear (S2-01a) — only a stable hash,
 * which still answers "did this number get its code?" without putting a
 * member's or a staff member's phone in a hosted log stream.
 */
function consoleSender(log: Logger): SmsSender {
  return {
    // The dev adapter deliberately keeps the message: it IS how the setup and
    // reset codes are delivered locally. The recipient is hashed.
    async send(phone, message) {
      const to = phoneHash(phone);
      log.info({ sms: { to, message } }, `SMS to ${to}: ${message}`);
    },
  };
}

/** Attempts in total, the first one included. */
const TWILIO_ATTEMPTS = 3;

/**
 * Twilio answers a message create in well under a second. Ten seconds leaves
 * room for a TLS handshake over the mall's connection and a slow moment at
 * the provider, while stopping a hung provider from holding a till request —
 * and the connection behind it — open with somebody waiting at the counter.
 */
const TWILIO_TIMEOUT_MS = 10_000;

/** Wait before attempt 2, then before attempt 3. */
const TWILIO_BACKOFF_MS = [250, 1_000];

/** A Retry-After longer than this is not worth holding the request open for. */
const RETRY_AFTER_CAP_MS = 5_000;

/** Our own deadline expiring; anything else thrown by fetch is the connection. */
function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
  }
  return TWILIO_BACKOFF_MS[attempt - 1] ?? TWILIO_BACKOFF_MS[TWILIO_BACKOFF_MS.length - 1]!;
}

/**
 * What propagates when delivery is given up on: an AppError, so the route
 * answers with the usual envelope instead of a raw fetch failure becoming a
 * bare 500. The status is safe to hand back — it is not the recipient and not
 * the code — and it is what tells reception "this is Twilio" rather than
 * "this is the number I typed".
 */
const deliveryFailed = (status?: number): AppError =>
  new AppError(
    502,
    'SMS_DELIVERY_FAILED',
    'Could not send the SMS — try again in a moment',
    status === undefined ? undefined : { status },
  );

/**
 * WHO we authenticate as and WHOSE account we are posting to are two different
 * questions, and with an API key they have two different answers: Twilio
 * authenticates the REST API with HTTP Basic, where the username is the key
 * SID and the password is the key secret, while the URL path still names the
 * account the message is billed to. With the account auth token the two
 * collapse back into one value, which is why this used to take a single SID.
 */
function twilioSender(
  accountSid: string,
  basic: { user: string; password: string },
  from: string,
  log: Logger,
): SmsSender {
  const auth = 'Basic ' + Buffer.from(`${basic.user}:${basic.password}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  return {
    async send(phone, message) {
      const to = phoneHash(phone);
      const params = new URLSearchParams({ To: phone, Body: message });
      // A Messaging Service SID routes via the service; otherwise From number.
      params.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);

      for (let attempt = 1; attempt <= TWILIO_ATTEMPTS; attempt++) {
        const last = attempt === TWILIO_ATTEMPTS;
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
          });
        } catch (err) {
          /**
           * A retry must not text the same person twice. Twilio's message
           * create offers no idempotency key we can rely on, so the rule is
           * drawn by what we know: a rejected connection (DNS, TLS, refused,
           * reset) means the request did not get an answer, and a 429 or a
           * 5xx means Twilio answered that it did not take the message. Both
           * are retried. Our own timeout is NOT: the deadline expiring says
           * nothing about what Twilio did with the request, and that is the
           * one case where sending again would reliably duplicate.
           *
           * The residual risk that remains: a socket that dies after Twilio
           * accepted the message looks identical to one refused before it
           * arrived, so a retry can duplicate. The message string is fixed
           * before the first attempt, so a duplicate is the same single-use
           * code arriving twice — a nuisance, against the alternative of a
           * person who cannot finish setting up their account.
           */
          if (isTimeout(err)) {
            log.error({ sms: { to, attempt } }, `Twilio send to ${to} timed out`);
            throw deliveryFailed();
          }
          // Never log `err`: undici carries the request on it, and the
          // request carries the recipient and the code.
          log.warn({ sms: { to, attempt } }, `Twilio send to ${to} did not complete`);
          if (last) throw deliveryFailed();
          await sleep(retryDelay(attempt, null));
          continue;
        }

        // undici holds the socket until the body is done with. It is
        // cancelled rather than read: Twilio's error text quotes the
        // recipient, so nothing good comes of having it in a string.
        const retryAfter = res.headers.get('retry-after');
        await res.body?.cancel().catch(() => undefined);

        if (res.ok) {
          log.info({ sms: { to, attempt } }, `SMS sent to ${to} via Twilio`);
          return;
        }

        // The status is the whole of what is kept: never the message body,
        // which contains the code, and never Twilio's own error text. A 401
        // is our credentials and a 400 is the number — neither gets better by
        // being asked again.
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || last) {
          log.error({ sms: { to, status: res.status, attempt } }, `Twilio send to ${to} failed`);
          throw deliveryFailed(res.status);
        }
        log.warn(
          { sms: { to, status: res.status, attempt } },
          `Twilio send to ${to} failed; retrying`,
        );
        await sleep(retryDelay(attempt, retryAfter));
      }
      // Unreachable: the last attempt always returns or throws above.
      throw deliveryFailed();
    },
  };
}

/** Twilio's two SID kinds, each with the prefix that identifies it. */
const SID_SHAPES = {
  TWILIO_ACCOUNT_SID: { prefix: 'AC', kind: 'an account SID' },
  TWILIO_API_KEY_SID: { prefix: 'SK', kind: 'an API key SID' },
} as const;

const SID_NAMES = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID'] as const;

/**
 * Both SIDs are 34 characters of hex behind two letters, they sit next to each
 * other in the Twilio console, and a key is created on the same page that
 * shows the account. Swapping them is therefore the likely mistake, and Twilio
 * answers a swap with a 401 at the first person who needs a code — days after
 * the deploy, reading as "the SMS did not go out" rather than "that value is
 * in the wrong variable". Two characters are cheap to check here instead.
 */
function wrongSidShape(name: (typeof SID_NAMES)[number], value: string): string | null {
  const want = SID_SHAPES[name];
  if (value.startsWith(want.prefix)) return null;
  const actually = SID_NAMES.find((n) => n !== name && value.startsWith(SID_SHAPES[n].prefix));
  return (
    `${name} does not hold ${want.kind} — those begin "${want.prefix}"` +
    (actually
      ? `, and this value is ${SID_SHAPES[actually].kind}, which belongs in ${actually}`
      : '')
  );
}

export function buildSmsSender(cfg: SmsConfig, log: Logger): SmsSender {
  switch (cfg.adapter) {
    case 'twilio': {
      const {
        twilioAccountSid: accountSid,
        twilioAuthToken: token,
        twilioApiKeySid: keySid,
        twilioApiKeySecret: keySecret,
        twilioFrom: from,
      } = cfg;

      // A value that is present but of the wrong kind is a more specific
      // diagnosis than one that is absent, so it is reported first.
      const wrong = [
        accountSid ? wrongSidShape('TWILIO_ACCOUNT_SID', accountSid) : null,
        keySid ? wrongSidShape('TWILIO_API_KEY_SID', keySid) : null,
      ].filter((problem): problem is string => problem !== null);
      if (wrong.length) {
        throw new Error(
          `SMS_ADAPTER=twilio but a Twilio credential is the wrong kind: ${wrong.join('; ')}. ` +
            'Twilio would answer this with a 401 at the first person who needs a code, which is ' +
            'days later and looks like a delivery problem rather than a configuration one.',
        );
      }

      /**
       * Half a key pair is an error, not a reason to reach for the auth
       * token. It is somebody mid-paste, and authenticating as the whole
       * account instead would work — quietly, on the credential they were
       * deliberately moving away from.
       */
      const reachingForKey = Boolean(keySid) || Boolean(keySecret);

      /** The Basic pair we will authenticate with, or null if neither shape is whole. */
      let basic: { user: string; password: string } | null = null;
      if (keySid && keySecret) {
        basic = { user: keySid, password: keySecret };
      } else if (!reachingForKey && accountSid && token) {
        basic = { user: accountSid, password: token };
      }

      if (!accountSid || !from || !basic) {
        // A half-filled shape is read as the shape it was reaching for:
        // somebody who has set a key SID wants a key, so the missing secret is
        // what to name, rather than the auth token they did not ask about.
        const missing = [
          // Required in both shapes: it names the account in the URL path
          // rather than authenticating, so an API key does not replace it.
          accountSid ? null : 'TWILIO_ACCOUNT_SID',
          ...(reachingForKey
            ? [keySid ? null : 'TWILIO_API_KEY_SID', keySecret ? null : 'TWILIO_API_KEY_SECRET']
            : [token ? null : 'TWILIO_AUTH_TOKEN']),
          from ? null : 'TWILIO_FROM',
        ].filter((name): name is string => name !== null);

        throw new Error(
          `SMS_ADAPTER=twilio but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
            (missing.includes('TWILIO_AUTH_TOKEN')
              ? 'TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET complete it instead, and are the shape to ' +
                'prefer: an API key is revoked and rotated on its own, while the auth token is the ' +
                'account itself. '
              : '') +
            'Set them, or set SMS_ADAPTER=console on a local machine; there is no fallback, because a ' +
            'fallback writes verification codes to the log and delivers none of them.',
        );
      }

      return twilioSender(accountSid, basic, from, log);
    }
    case 'console':
      // Allowed here, refused by assertProductionSafe on any deployment.
      return consoleSender(log);
    default:
      throw new Error(
        `Unknown SMS_ADAPTER "${cfg.adapter}". Known adapters: ${SMS_ADAPTERS.join(', ')}.`,
      );
  }
}
