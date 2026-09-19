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
