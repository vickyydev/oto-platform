import { pino, type Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import { phoneHash } from '../src/lib/scrub';
import { buildSmsSender } from '../src/services/sms';

/**
 * S2-01c — SMS delivery is real or it is loud.
 *
 * The behaviour under test is the one a person meets at reception: a setup
 * code either reaches their phone, or the api says so plainly. It must never
 * quietly become a line in a log, and the log must never be where the code or
 * the number ends up.
 */

const PHONE = '+66811111111';
const MESSAGE = 'Your OTO account setup code is 123456';

/** A real pino logger writing into an array — what the hosted stream would get. */
function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  return { log, lines };
}

/** Neither the recipient nor the code may appear anywhere in the log. */
function expectNoLeak(lines: string[]): void {
  const logged = lines.join('\n');
  expect(logged).not.toContain(PHONE);
  expect(logged).not.toContain('66811111111');
  expect(logged).not.toContain('123456');
}

const twilioConfig = {
  adapter: 'twilio',
  twilioAccountSid: 'ACtest',
  twilioAuthToken: 'authtoken-value',
  twilioFrom: '+15005550006',
};

/**
 * The shape to prefer: an API key authenticates in place of the auth token,
 * while the URL still names the account the message is billed to.
 */
const apiKeyConfig = {
  ...twilioConfig,
  twilioAuthToken: undefined,
  twilioApiKeySid: 'SKtest',
  twilioApiKeySecret: 'keysecret-value',
};

/** What Twilio was actually sent as the HTTP Basic pair. */
const basicPair = (fetchMock: { mock: { calls: unknown[][] } }): string => {
  const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
  return Buffer.from(init.headers.authorization!.replace('Basic ', ''), 'base64').toString();
};

const response = (status: number, init: ResponseInit = {}): Response =>
  new Response('{"sid":"SMtest"}', { status, ...init });

/** The rejection undici raises when AbortSignal.timeout fires. */
const timeoutError = (): Error =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('choosing an adapter (S2-01c)', () => {
  it('names every missing Twilio credential instead of falling back', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender({ adapter: 'twilio' }, log)).toThrow(
      /TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM/,
    );
  });

  it('names the one credential that is missing', () => {
    const { log } = captureLog();
    expect(() =>
      buildSmsSender({ ...twilioConfig, twilioAuthToken: undefined }, log),
    ).toThrow(/TWILIO_AUTH_TOKEN is not set/);
  });

  it('refuses an adapter it does not have', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender({ adapter: 'sns' }, log)).toThrow(/Unknown SMS_ADAPTER "sns"/);
    expect(() => buildSmsSender({ adapter: 'sns' }, log)).toThrow(/console, twilio/);
  });

  it('builds the Twilio sender when all three are set', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender(twilioConfig, log)).not.toThrow();
  });

  it('builds it from an API key just as readily', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender(apiKeyConfig, log)).not.toThrow();
  });
});

/**
 * Twilio takes either the account auth token or an API key, and authenticates
 * both with HTTP Basic — so the only thing that changes on the wire is which
 * pair goes in the header. The URL names the account either way, which is what
 * makes a credential pasted into the wrong variable look plausible right up
 * until Twilio answers 401 at the first person who needs a code.
 */
describe('Twilio credentials (S2-01c)', () => {
  it('authenticates with the API key while the URL still names the account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await buildSmsSender(apiKeyConfig, log).send(PHONE, MESSAGE);

    expect(basicPair(fetchMock)).toBe('SKtest:keysecret-value');
    expect(fetchMock.mock.calls[0]![0]).toContain('/Accounts/ACtest/Messages.json');
  });

  it('authenticates as the account itself when no key is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE);

    expect(basicPair(fetchMock)).toBe('ACtest:authtoken-value');
    expect(fetchMock.mock.calls[0]![0]).toContain('/Accounts/ACtest/Messages.json');
  });

  it('prefers the key when an account still carries both', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await buildSmsSender({ ...apiKeyConfig, twilioAuthToken: 'authtoken-value' }, log).send(
      PHONE,
      MESSAGE,
    );

    expect(basicPair(fetchMock)).toBe('SKtest:keysecret-value');
  });

  it('names the half of the key pair that is missing', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender({ ...apiKeyConfig, twilioApiKeySecret: undefined }, log)).toThrow(
      /TWILIO_API_KEY_SECRET is not set/,
    );
    expect(() => buildSmsSender({ ...apiKeyConfig, twilioApiKeySid: undefined }, log)).toThrow(
      /TWILIO_API_KEY_SID is not set/,
    );
  });

  // Half a pair beside a usable auth token is the dangerous one: it would work.
  it('refuses half a key pair rather than quietly using the auth token', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender({ ...twilioConfig, twilioApiKeySid: 'SKtest' }, log)).toThrow(
      /TWILIO_API_KEY_SECRET is not set/,
    );
  });

  it('refuses an account SID pasted into the key variable', () => {
    const { log } = captureLog();
    const build = (): unknown =>
      buildSmsSender({ ...apiKeyConfig, twilioApiKeySid: 'ACtest' }, log);
    expect(build).toThrow(/TWILIO_API_KEY_SID does not hold an API key SID/);
    expect(build).toThrow(/belongs in TWILIO_ACCOUNT_SID/);
  });

  it('refuses a key SID pasted into the account variable', () => {
    const { log } = captureLog();
    const build = (): unknown =>
      buildSmsSender({ ...twilioConfig, twilioAccountSid: 'SKtest' }, log);
    expect(build).toThrow(/TWILIO_ACCOUNT_SID does not hold an account SID/);
    expect(build).toThrow(/belongs in TWILIO_API_KEY_SID/);
  });

  it('keeps every kind of secret out of the log', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(400));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    for (const cfg of [twilioConfig, apiKeyConfig]) {
      await buildSmsSender(cfg, log)
        .send(PHONE, MESSAGE)
        .catch(() => undefined);
    }

    const logged = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(logged).not.toContain('authtoken-value');
    expect(logged).not.toContain('keysecret-value');
    expect(logged).not.toContain('SKtest');
    expectNoLeak(lines);
  });
});

describe('the console adapter', () => {
  it('logs the code against a phone hash, never the number', async () => {
    const { log, lines } = captureLog();
    await buildSmsSender({ adapter: 'console' }, log).send(PHONE, MESSAGE);

    const logged = lines.join('\n');
    expect(logged).toContain(phoneHash(PHONE));
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain('66811111111');
    // The message is here on purpose: on a developer's machine this line IS
    // the delivery. Every deployment is refused this adapter at boot.
    expect(logged).toContain('123456');
  });
});

describe('the Twilio sender', () => {
  it('sends the code to Twilio and logs neither it nor the number', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    await buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE);

    const body = fetchMock.mock.calls[0]![1].body as string;
    const sent = new URLSearchParams(body);
    expect(sent.get('To')).toBe(PHONE);
    expect(sent.get('Body')).toBe(MESSAGE);
    expect(sent.get('From')).toBe('+15005550006');
    expectNoLeak(lines);
  });

  it('routes through a Messaging Service when TWILIO_FROM is one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await buildSmsSender({ ...twilioConfig, twilioFrom: 'MGtest' }, log).send(PHONE, MESSAGE);

    const sent = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(sent.get('MessagingServiceSid')).toBe('MGtest');
    expect(sent.get('From')).toBeNull();
  });

  it('retries a 500 and delivers on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    await buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoLeak(lines);
  });

  it('retries a connection that never answered', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    await buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoLeak(lines);
  });

  it('gives up after the last attempt, as an error a route can answer with', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    const err = await buildSmsSender(twilioConfig, log)
      .send(PHONE, MESSAGE)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SMS_DELIVERY_FAILED');
    expect((err as AppError).statusCode).toBe(502);
    expect((err as AppError).details).toEqual({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectNoLeak(lines);
  });

  it('never retries a 400 — a bad number or a bad credential stays bad', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(400));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    await expect(buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE)).rejects.toBeInstanceOf(
      AppError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoLeak(lines);
  });

  it('surfaces a timeout as a failure and does not send again', async () => {
    const fetchMock = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    const err = await buildSmsSender(twilioConfig, log)
      .send(PHONE, MESSAGE)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SMS_DELIVERY_FAILED');
    // The whole point: our deadline says nothing about what Twilio did with
    // the request, so asking again is the one way to text the same code twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoLeak(lines);
  });

  it('waits the Retry-After that Twilio asks for', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(response(201));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    const startedAt = Date.now();
    await buildSmsSender(twilioConfig, log).send(PHONE, MESSAGE);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * SCRUM-455 — the twilio_verify adapter. Twilio owns the code end to end, so
 * this adapter carries no `From`, composes no message and declares the
 * `checksCodes` capability instead of a usable `send`. It authenticates as the
 * account (SID + auth token) and every request names the Verify service in its
 * path. No test here makes a real network call.
 */
const verifyConfig = {
  adapter: 'twilio_verify',
  twilioAccountSid: 'ACtest',
  twilioAuthToken: 'authtoken-value',
  twilioVerifyServiceSid: 'VAtest',
};

/** A Verify response with a JSON body — what Twilio answers a check with. */
const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('choosing the twilio_verify adapter (SCRUM-455)', () => {
  it('names every missing credential instead of falling back', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender({ adapter: 'twilio_verify' }, log)).toThrow(
      /TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID/,
    );
  });

  it('names the account SID when only it is missing', () => {
    const { log } = captureLog();
    expect(() =>
      buildSmsSender({ ...verifyConfig, twilioAccountSid: undefined }, log),
    ).toThrow(/TWILIO_ACCOUNT_SID is not set/);
  });

  it('names the auth token when only it is missing', () => {
    const { log } = captureLog();
    expect(() =>
      buildSmsSender({ ...verifyConfig, twilioAuthToken: undefined }, log),
    ).toThrow(/TWILIO_AUTH_TOKEN is not set/);
  });

  it('names the Verify service SID when only it is missing', () => {
    const { log } = captureLog();
    expect(() =>
      buildSmsSender({ ...verifyConfig, twilioVerifyServiceSid: undefined }, log),
    ).toThrow(/TWILIO_VERIFY_SERVICE_SID is not set/);
  });

  it('refuses a key SID pasted into the account variable', () => {
    const { log } = captureLog();
    const build = (): unknown =>
      buildSmsSender({ ...verifyConfig, twilioAccountSid: 'SKtest' }, log);
    expect(build).toThrow(/TWILIO_ACCOUNT_SID does not hold an account SID/);
  });

  it('refuses anything but a Verify SID in the Verify variable', () => {
    const { log } = captureLog();
    // The Messaging Service SID next door in the console is the likely paste.
    const build = (): unknown =>
      buildSmsSender({ ...verifyConfig, twilioVerifyServiceSid: 'MGtest' }, log);
    expect(build).toThrow(/TWILIO_VERIFY_SERVICE_SID does not hold a Verify service SID/);
    expect(build).toThrow(/begin "VA"/);
  });

  it('builds when all three are set', () => {
    const { log } = captureLog();
    expect(() => buildSmsSender(verifyConfig, log)).not.toThrow();
  });

  it('has a checksCodes capability, and a send() that refuses to be used', async () => {
    const { log } = captureLog();
    const sender = buildSmsSender(verifyConfig, log);
    expect(sender.checksCodes).toBeTruthy();
    // Verify composes the message; reaching send() means a caller bypassed the
    // capability, so it fails loudly rather than delivering nothing.
    await expect(sender.send(PHONE, MESSAGE)).rejects.toThrow(/no send\(\)/);
  });
});

describe('the Twilio Verify sender (SCRUM-455)', () => {
  it('starts a verification: To, Channel=sms, account auth, service in the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = captureLog();

    await buildSmsSender(verifyConfig, log).checksCodes!.start(PHONE);

    expect(fetchMock.mock.calls[0]![0]).toContain(
      '/v2/Services/VAtest/Verifications',
    );
    const sent = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(sent.get('To')).toBe(PHONE);
    expect(sent.get('Channel')).toBe('sms');
    expect(basicPair(fetchMock)).toBe('ACtest:authtoken-value');
    expectNoLeak(lines);
  });

  it('checks a code against VerificationCheck with To and Code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'approved' }));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    const verdict = await buildSmsSender(verifyConfig, log).checksCodes!.checkCode(
      PHONE,
      '123456',
    );

    expect(fetchMock.mock.calls[0]![0]).toContain(
      '/v2/Services/VAtest/VerificationCheck',
    );
    const sent = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(sent.get('To')).toBe(PHONE);
    expect(sent.get('Code')).toBe('123456');
    expect(verdict).toBe('approved');
  });

  it('maps status=approved → approved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { status: 'approved' })));
    const { log } = captureLog();
    expect(await buildSmsSender(verifyConfig, log).checksCodes!.checkCode(PHONE, '123456')).toBe(
      'approved',
    );
  });

  it('maps status=pending (a wrong code) → denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { status: 'pending' })));
    const { log } = captureLog();
    expect(await buildSmsSender(verifyConfig, log).checksCodes!.checkCode(PHONE, '000000')).toBe(
      'denied',
    );
  });

  it('maps a 404 (no live verification) → expired', async () => {
    // Twilio 404s a VerificationCheck when the verification has timed out, run
    // out of attempts, or was already approved and closed.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { code: 20404 })));
    const { log } = captureLog();
    expect(await buildSmsSender(verifyConfig, log).checksCodes!.checkCode(PHONE, '123456')).toBe(
      'expired',
    );
  });

  it('reads only status from the check body — the recipient in it never leaks', async () => {
    // The real VerificationCheck body quotes `to`; the adapter must parse
    // status out of it without ever logging the body.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'approved', to: PHONE })),
    );
    const { log, lines } = captureLog();

    const verdict = await buildSmsSender(verifyConfig, log).checksCodes!.checkCode(PHONE, '123456');

    expect(verdict).toBe('approved');
    expectNoLeak(lines);
  });

  it('surfaces a 401 on the check as an error a route can answer with', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { code: 20003 })));
    const { log } = captureLog();

    const err = await buildSmsSender(verifyConfig, log)
      .checksCodes!.checkCode(PHONE, '123456')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SMS_DELIVERY_FAILED');
  });

  it('surfaces a failed start as an error, and logs neither number nor code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)));
    const { log, lines } = captureLog();

    const err = await buildSmsSender(verifyConfig, log)
      .checksCodes!.start(PHONE)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SMS_DELIVERY_FAILED');
    expectNoLeak(lines);
  });

  it('retries a 500 on start and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(jsonResponse(201, { status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await buildSmsSender(verifyConfig, log).checksCodes!.start(PHONE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a start our own deadline aborted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal('fetch', fetchMock);
    const { log } = captureLog();

    await expect(
      buildSmsSender(verifyConfig, log).checksCodes!.start(PHONE),
    ).rejects.toBeInstanceOf(AppError);
    // A timeout says nothing about what Twilio did, so a retried start could
    // send a second code — exactly as the SMS send path reasons.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
