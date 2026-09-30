import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { AppError } from '../lib/errors';
import { phoneHash } from '../lib/scrub';

/**
 * SMS delivery (SCRUM-20, hardened in S2-01c).
 *
 * A verification code is the only way a member of staff finishes setting up
 * an account or recovers a password, so "the SMS did not go out" is a person
 * locked out of the till, not a line in a log. Three adapters exist, chosen by
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
 *  - "twilio_verify" (SCRUM-455): Twilio's Verify API. Twilio GENERATES, SENDS
 *    and CHECKS the code through its own pre-registered senders — the route
 *    that reaches Thai phones without this platform registering a sender of its
 *    own. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a Verify service
 *    TWILIO_VERIFY_SERVICE_SID ("VA…"). Because the code lives at Twilio and
 *    never here, this adapter declares the `checksCodes` capability: the auth
 *    service asks it to START and to CHECK a verification instead of minting,
 *    storing and comparing a code of its own.
 *
 * A misconfigured adapter now fails at construction — which is boot — rather
 * than at the first person who needs a code. Until S2-01c both the
 * missing-credential and the unknown-adapter case warned and fell back to the
 * console adapter, which is three failures at once: nobody receives a code,
 * the code is written into a hosted log stream, and the only signal is one
 * warning line.
 */
/**
 * The verdict Twilio Verify gives a typed code (SCRUM-455). `approved` lets it
 * through; `denied` is a wrong code, a guess to be counted like any other;
 * `expired` is no live verification — the code timed out, ran out of attempts,
 * or was already approved, since Twilio closes an approved verification itself.
 */
export type CodeVerdict = 'approved' | 'denied' | 'expired';

/**
 * The capability an adapter declares when Twilio — not this platform — owns the
 * code from end to end (twilio_verify, SCRUM-455). Verify GENERATES, SENDS and
 * CHECKS the code, so there is no local secret to mint, store or compare:
 * `start` opens a verification and `checkCode` puts a typed guess to it. The
 * auth service consults this in place of the local hash path wherever it is
 * present.
 */
export interface CodeChecker {
  /** Open a verification — Twilio composes and sends the code to the phone. */
  start(phone: string): Promise<void>;
  /** Put a typed code to Twilio and map its answer to a verdict. */
  checkCode(phone: string, code: string): Promise<CodeVerdict>;
}

export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
  /**
   * Present only on an adapter that owns the code itself (twilio_verify). When
   * it is set the auth service never mints, stores or compares a code — it asks
   * this to start and to check the verification instead. Absent on `console`
   * and `twilio`, which deliver a code this platform minted.
   */
  checksCodes?: CodeChecker;
}

export interface SmsConfig {
  adapter: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioApiKeySid?: string;
  twilioApiKeySecret?: string;
  twilioFrom?: string;
  /** The Twilio Verify service ("VA…") the twilio_verify adapter checks against. */
  twilioVerifyServiceSid?: string;
}

export const SMS_ADAPTERS = ['console', 'twilio', 'twilio_verify'] as const;

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

/**
 * Twilio Verify (twilio_verify, SCRUM-455). Twilio owns the whole code: it
 * generates it, sends it through a pre-registered sender, and answers whether a
 * typed one is right. So this adapter carries no `From` and composes no
 * message; it declares `checksCodes` and the auth service drives it through
 * that capability instead of `send`.
 *
 * The HTTP is the send path's, deliberately: HTTP Basic with the account SID
 * and auth token, the same ten-second deadline, the same three attempts with
 * the same backoff, the same rule that a rejected connection or a 429/5xx is
 * retried while our own timeout is not, and the same `AppError` surfaced on
 * failure. Verify's own two calls sit on top of that shared `post` — a start
 * and a check — each classifying the final response for itself.
 */
function twilioVerifySender(
  accountSid: string,
  authToken: string,
  verifyServiceSid: string,
  log: Logger,
): SmsSender {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const base = `https://verify.twilio.com/v2/Services/${verifyServiceSid}`;

  /**
   * One POST under the send path's retry/timeout/backoff policy, returning the
   * final Response — 2xx or not, body still open — for the caller to classify,
   * or throwing `deliveryFailed` when the connection never answered or our own
   * deadline expired. Never logs `err` (undici hangs the request, and the
   * request carries the recipient) nor the body (Verify's JSON quotes the
   * recipient); only the phone hash and the status.
   */
  async function post(path: string, params: URLSearchParams, to: string): Promise<Response> {
    for (let attempt = 1; attempt <= TWILIO_ATTEMPTS; attempt++) {
      const last = attempt === TWILIO_ATTEMPTS;
      let res: Response;
      try {
        res = await fetch(`${base}/${path}`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
        });
      } catch (err) {
        // Our deadline says nothing about what Twilio did with the request, so
        // it is not retried — the send path's reasoning, and here a retried
        // start would text a second code.
        if (isTimeout(err)) {
          log.error({ sms: { to, attempt } }, `Twilio Verify (${path}) to ${to} timed out`);
          throw deliveryFailed();
        }
        log.warn({ sms: { to, attempt } }, `Twilio Verify (${path}) to ${to} did not complete`);
        if (last) throw deliveryFailed();
        await sleep(retryDelay(attempt, null));
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || last) return res; // the caller reads or cancels the body
      const retryAfter = res.headers.get('retry-after');
      await res.body?.cancel().catch(() => undefined);
      log.warn(
        { sms: { to, status: res.status, attempt } },
        `Twilio Verify (${path}) to ${to} failed; retrying`,
      );
      await sleep(retryDelay(attempt, retryAfter));
    }
    // Unreachable: the last attempt always returns or throws above.
    throw deliveryFailed();
  }

  return {
    /**
     * Verify composes and sends the message itself, so there is no message to
     * hand this adapter: the two code paths route to `checksCodes` instead.
     * Reaching `send` means a caller bypassed that capability — a programming
     * error, so it fails loudly rather than silently delivering nothing.
     */
    async send() {
      throw new Error(
        'twilio_verify has no send(): Twilio composes and sends the code itself. ' +
          'Start and check it through the checksCodes capability instead.',
      );
    },
    checksCodes: {
      // POST /Verifications — Twilio generates the code and sends it by SMS.
      async start(phone) {
        const to = phoneHash(phone);
        const params = new URLSearchParams({ To: phone, Channel: 'sms' });
        const res = await post('Verifications', params, to);
        await res.body?.cancel().catch(() => undefined);
        if (!res.ok) {
          // The status is the whole of what is kept — never Verify's error
          // text, which quotes the number. A 401 is our credentials and a 404
          // is the Verify service SID; neither improves by being asked again.
          log.error({ sms: { to, status: res.status } }, `Twilio Verify start to ${to} failed`);
          throw deliveryFailed(res.status);
        }
        log.info({ sms: { to } }, `Verification started for ${to} via Twilio Verify`);
      },
      // POST /VerificationCheck — Twilio answers whether the typed code is right.
      async checkCode(phone, code) {
        const to = phoneHash(phone);
        const params = new URLSearchParams({ To: phone, Code: code });
        const res = await post('VerificationCheck', params, to);
        /**
         * A 404 is not a transport failure but a verdict: there is no pending
         * verification for this number. It timed out, ran out of attempts, or
         * was already approved — Twilio closes an approved verification itself,
         * so the SECOND check of a code that just passed lands here, which is
         * one half of what keeps a Verify code single-use (the consumed anchor
         * row in the auth service is the other).
         */
        if (res.status === 404) {
          await res.body?.cancel().catch(() => undefined);
          return 'expired';
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          log.error({ sms: { to, status: res.status } }, `Twilio Verify check for ${to} failed`);
          throw deliveryFailed(res.status);
        }
        /**
         * The body quotes the recipient, so only `status` is read out of it and
         * nothing is logged. `approved` is the one answer that lets a code
         * through; `pending` is a wrong code and anything else is treated as
         * one — a `denied` the auth service counts as a guess.
         */
        let status: string | undefined;
        try {
          status = ((await res.json()) as { status?: string }).status;
        } catch {
          status = undefined;
        }
        return status === 'approved' ? 'approved' : 'denied';
      },
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

/**
 * A Verify service SID is "VA" + 32 hex (SCRUM-455). The likely paste errors
 * are the account SID ("AC"), an API key SID ("SK") or the Messaging Service
 * SID ("MG") in this slot, each of which Twilio answers with a 404 at the first
 * person who needs a code — days after the deploy, reading as "the SMS did not
 * go out". Two characters are cheap to check here instead.
 */
function wrongVerifyShape(value: string): string | null {
  if (value.startsWith('VA')) return null;
  return 'TWILIO_VERIFY_SERVICE_SID does not hold a Verify service SID — those begin "VA"';
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
    case 'twilio_verify': {
      const {
        twilioAccountSid: accountSid,
        twilioAuthToken: token,
        twilioVerifyServiceSid: serviceSid,
      } = cfg;

      // A value present but of the wrong kind is a more specific diagnosis than
      // one absent, so it is reported first — the same order the twilio case
      // uses. Verify authenticates as the account (SID + auth token); an API
      // key is not a shape here.
      const wrong = [
        accountSid ? wrongSidShape('TWILIO_ACCOUNT_SID', accountSid) : null,
        serviceSid ? wrongVerifyShape(serviceSid) : null,
      ].filter((problem): problem is string => problem !== null);
      if (wrong.length) {
        throw new Error(
          `SMS_ADAPTER=twilio_verify but a Twilio credential is the wrong kind: ${wrong.join('; ')}. ` +
            'Twilio would answer this with a 401 or a 404 at the first person who needs a code, which ' +
            'is days later and looks like a delivery problem rather than a configuration one.',
        );
      }

      const missing = [
        // Names the account in the URL path, exactly as the twilio case does.
        accountSid ? null : 'TWILIO_ACCOUNT_SID',
        token ? null : 'TWILIO_AUTH_TOKEN',
        // The Verify service that generates, sends and checks the code.
        serviceSid ? null : 'TWILIO_VERIFY_SERVICE_SID',
      ].filter((name): name is string => name !== null);
      if (missing.length) {
        throw new Error(
          `SMS_ADAPTER=twilio_verify but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
            'Set them, or set SMS_ADAPTER=console on a local machine; there is no fallback, because a ' +
            'fallback writes verification codes to the log and delivers none of them.',
        );
      }

      return twilioVerifySender(accountSid!, token!, serviceSid!, log);
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
