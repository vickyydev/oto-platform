import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { acceptHandoff, readHandoffToken, type HandoffArrivalPort } from '@/auth/handoff';

/**
 * SCRUM-591 prerequisite P1 — the Inbox lands on the hand-off's target path,
 * after a successful exchange only, and only when the path passes the shared
 * rule again here.
 */

function port(hash: string, exchange: (token: string) => Promise<unknown>, base = '/') {
  const urls: string[] = [];
  const tokens: string[] = [];
  const p: HandoffArrivalPort = {
    hash,
    pathname: '/',
    search: '',
    base,
    replaceUrl: (url) => urls.push(url),
    exchange: (token) => {
      tokens.push(token);
      return exchange(token);
    },
  };
  return { p, urls, tokens };
}

const ok = () => Promise.resolve({ ok: true });

describe('the Inbox hand-off receiver (P1)', () => {
  it('does nothing without a token', () => {
    const { p, urls } = port('#to=%2Fhealth', ok);
    expect(acceptHandoff(p)).toBeNull();
    expect(urls).toEqual([]);
  });

  it('strips the fragment, exchanges, then lands on the linked conversation', async () => {
    const target = '/?c=0192f0a0-1234-7abc-8def-0123456789ab';
    const { p, urls, tokens } = port(`#handoff=tok&to=${encodeURIComponent(target)}`, ok);
    await expect(acceptHandoff(p)).resolves.toBeNull();
    expect(tokens).toEqual(['tok']);
    expect(urls).toEqual(['/', target]);
  });

  it("lands under the Inbox's base path", async () => {
    const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent('/health')}`, ok, '/inbox/');
    await acceptHandoff(p);
    expect(urls.at(-1)).toBe('/inbox/health');
  });

  it('opens at home when there is no target', async () => {
    const { p, urls } = port('#handoff=tok', ok);
    await acceptHandoff(p);
    expect(urls).toEqual(['/']);
  });

  it.each([
    ['an absolute URL', 'https://evil.example/health'],
    ['a protocol-relative path', '//evil.example/health'],
    ['a dot-dot path', '/health/../../admin'],
    ['an empty target', ''],
  ])('ignores %s and opens at home', async (_, target) => {
    const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent(target)}`, ok);
    await expect(acceptHandoff(p)).resolves.toBeNull();
    expect(urls).toEqual(['/']);
  });

  it('never lands when the exchange is refused', async () => {
    const refused = () => Promise.reject(new ApiError(401, 'HANDOFF_EXPIRED', 'expired', { reason: 'expired' }));
    const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent('/health')}`, refused);
    await expect(acceptHandoff(p)).resolves.toMatch(/expired/);
    expect(urls).toEqual(['/']);
  });

  it('reads the token beside a target', () => {
    expect(readHandoffToken('#handoff=a.b.c&to=%2Fhealth')).toBe('a.b.c');
  });
});
