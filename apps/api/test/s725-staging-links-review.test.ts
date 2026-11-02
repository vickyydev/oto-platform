import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const helperUrl = new URL('../../../scripts/agent/render.mjs', import.meta.url).href;
const { replacePosHandoffOrigin } = await import(/* @vite-ignore */ helperUrl) as {
  replacePosHandoffOrigin: (id: string, oldOrigin: string, nextOrigin: string) => Promise<unknown>;
};
const oldOrigin = 'https://oto-pos-staging.onrender.com';
const nextOrigin = 'https://oto-pos-web-staging.onrender.com';
const route = 'https://api.render.com/v1/services/ZZ-TEST/env-vars/HANDOFF_APP_ORIGINS';
let saved: string | null;
let wrapped: boolean;
let acceptWrite: boolean;
let writes: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  saved = ` console=https://console.example ,pos=${oldOrigin},oto_app=https://app.example `;
  wrapped = true;
  acceptWrite = true;
  writes = [];
  vi.stubEnv('RENDER_API_KEY', 'ZZ_TEST_key');
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    expect(input).toBe(route); // HIGH: a bulk write can erase unrelated settings. Fix: one named key only.
    if (init.method === 'PUT') {
      const body: unknown = JSON.parse(String(init.body));
      writes.push({ url: input, body });
      if (acceptWrite) saved = (body as { value: string }).value;
      return new Response('{}', { status: acceptWrite ? 200 : 400 });
    }
    expect(init.method).toBe('GET');
    return new Response(JSON.stringify(saved === null ? {} : wrapped ? { envVar: { value: saved } } : { value: saved }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('SCRUM-725 guarded POS destination replacement', () => {
  it.each([true, false])('preserves every other byte with wrapped=%s reads and one single-key write', async shape => {
    wrapped = shape;
    const before = saved!;
    await replacePosHandoffOrigin('ZZ-TEST', oldOrigin, nextOrigin);
    expect(saved).toBe(before.replace(oldOrigin, nextOrigin));
    expect(writes).toEqual([{ url: route, body: { value: before.replace(oldOrigin, nextOrigin) } }]);
  });

  // HIGH: an empty/unreadable read once erased the other app destinations.
  // Prescribed fix: refuse before writing; an empty value is never a starting list.
  it.each([null, '', '  '])('refuses unreadable or empty current value %s', async value => {
    saved = value;
    await expect(replacePosHandoffOrigin('ZZ-TEST', oldOrigin, nextOrigin)).rejects.toThrow('unreadable or empty');
    expect(writes).toEqual([]);
  });

  it.each([
    'console=https://console.example',
    `pos=${oldOrigin}, pos=${oldOrigin}`,
    'pos=https://unexpected.example',
  ])('refuses a missing, duplicated or changed POS entry', async value => {
    saved = value;
    await expect(replacePosHandoffOrigin('ZZ-TEST', oldOrigin, nextOrigin)).rejects.toThrow();
    expect(saved).toBe(value);
    expect(writes).toEqual([]);
  });

  it('preserves whitespace on the POS entry and supports the exact way back', async () => {
    saved = `console=https://console.example,  pos=${oldOrigin}  ,inbox=https://inbox.example`;
    const before = saved;
    await replacePosHandoffOrigin('ZZ-TEST', oldOrigin, nextOrigin);
    await replacePosHandoffOrigin('ZZ-TEST', nextOrigin, oldOrigin);
    expect(saved).toBe(before);
    expect(writes).toHaveLength(2);
  });

  it.each(['http://pos.example', 'https://pos.example/path', 'https://user:pass@pos.example'])('refuses a non-origin destination', async destination => {
    await expect(replacePosHandoffOrigin('ZZ-TEST', oldOrigin, destination)).rejects.toThrow('HTTPS origin');
    expect(writes).toEqual([]);
  });

  it('does not write when the expected destination is already the requested destination', async () => {
    await expect(replacePosHandoffOrigin('ZZ-TEST', oldOrigin, oldOrigin)).resolves.toMatchObject({ unchanged: true });
    expect(writes).toEqual([]);
  });

  it('refuses an unconfirmed write without retrying it', async () => {
    acceptWrite = false;
    await expect(replacePosHandoffOrigin('ZZ-TEST', oldOrigin, nextOrigin)).rejects.toThrow('read-back did not match');
    expect(writes).toHaveLength(1);
  });
});
