import { describe, expect, it } from 'vitest';
import { HANDOFF_TARGET_MAX, landingUrl, readHandoffTarget, safeTargetPath, withHandoffTarget } from '../src/handoff-target';

/**
 * SCRUM-591 prerequisite P1 — the hand-off carries a target path. The rule is
 * one function used where the launcher writes the path and again where each
 * app honours it; these are its refusals and the fragment's round trip.
 */

const LAUNCH = 'https://console.example.test/#handoff=eyJ.abc.def';

describe('safeTargetPath', () => {
  it('accepts a same-app path, with or without a query', () => {
    expect(safeTargetPath('/health')).toBe('/health');
    expect(safeTargetPath('/employees/e-123?tab=time')).toBe('/employees/e-123?tab=time');
    expect(safeTargetPath('/?c=0192f0a0-1234-7abc-8def-0123456789ab')).toBe('/?c=0192f0a0-1234-7abc-8def-0123456789ab');
    expect(safeTargetPath('/payroll/month-end?month=2026-09&tab=preview')).toBe('/payroll/month-end?month=2026-09&tab=preview');
  });

  it('accepts a path of exactly HANDOFF_TARGET_MAX characters', () => {
    const atMax = `/${'a'.repeat(HANDOFF_TARGET_MAX - 1)}`;
    expect(atMax).toHaveLength(HANDOFF_TARGET_MAX);
    expect(safeTargetPath(atMax)).toBe(atMax);
  });

  it('accepts same-origin paths that only look odd — the hardening does not reach these', () => {
    // An encoded '#', a ':' or an '@' after the leading '/' are paths of this
    // app and resolve to it (the URL probe below holds); none is a route of
    // ours, so each would land on the app's own not-found page.
    expect(safeTargetPath('/health%23x')).toBe('/health%23x');
    expect(safeTargetPath('/javascript:alert(1)')).toBe('/javascript:alert(1)');
    expect(safeTargetPath('/@evil.example/x')).toBe('/@evil.example/x');
  });

  it.each([
    ['empty', ''],
    ['absolute URL', 'https://evil.example/health'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['bare host', 'evil.example/health'],
    ['relative without a slash', 'health'],
    ['protocol-relative', '//evil.example/health'],
    ['backslash host', '/\\evil.example'],
    ['backslash inside', '/health\\..\\admin'],
    ['dot-dot segment', '/health/../admin'],
    ['trailing dot-dot', '/health/..'],
    ['encoded dot-dot', '/health/%2e%2e/admin'],
    ['double-encoded dot-dot', '/%252e%252e/x'],
    ['encoded percent', '/x%25y'],
    ['encoded slash', '/health%2f..%2fadmin'],
    ['single dot segment', '/./health'],
    ['fragment', '/health#handoff=x'],
    ['ampersand in the path', '/x&handoff=z'],
    ['whitespace', '/health page'],
    ['control character', '/health\n'],
    ['encoded NUL', '/%00'],
    ['encoded control character', '/x%1Fy'],
    ['encoded DEL', '/x%7fy'],
    ['non-ASCII', '/héalth'],
    ['undecodable', '/health%zz'],
    ['one over HANDOFF_TARGET_MAX', `/${'a'.repeat(HANDOFF_TARGET_MAX)}`],
  ])('refuses %s', (_, raw) => {
    expect(safeTargetPath(raw)).toBeNull();
  });

  it('refuses what is not a string', () => {
    expect(safeTargetPath(undefined)).toBeNull();
    expect(safeTargetPath(null)).toBeNull();
    expect(safeTargetPath(42)).toBeNull();
  });
});

describe('the fragment round trip', () => {
  it('writes the path beside the token and reads the same path back', () => {
    for (const path of ['/health', '/employees/e-1?tab=time', '/?c=0192f0a0-1234-7abc-8def-0123456789ab&tab=team']) {
      const url = withHandoffTarget(LAUNCH, path);
      expect(url.startsWith(`${LAUNCH}&to=`)).toBe(true);
      const hash = new URL(url).hash;
      expect(readHandoffTarget(hash)).toBe(path);
      // The token is untouched, and the query inside the path does not leak into the fragment's own keys.
      expect(/(?:^|&)handoff=([^&]*)/.exec(hash.slice(1))?.[1]).toBe('eyJ.abc.def');
    }
  });

  it('leaves the launch URL as it was when there is no target, or a refused one', () => {
    expect(withHandoffTarget(LAUNCH, undefined)).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, null)).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, '')).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, '/')).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, 'https://evil.example')).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, '//evil.example')).toBe(LAUNCH);
    expect(withHandoffTarget(LAUNCH, '/a/../b')).toBe(LAUNCH);
    expect(withHandoffTarget('https://console.example.test/', '/health')).toBe('https://console.example.test/');
  });

  it('refuses a hand-written fragment the launcher would never have written', () => {
    expect(readHandoffTarget('#handoff=t')).toBeNull();
    expect(readHandoffTarget('#handoff=t&to=')).toBeNull();
    expect(readHandoffTarget('#handoff=t&to=%2F')).toBeNull(); // home: nothing to do
    expect(readHandoffTarget(`#handoff=t&to=${encodeURIComponent('https://evil.example/x')}`)).toBeNull();
    expect(readHandoffTarget(`#handoff=t&to=${encodeURIComponent('//evil.example/x')}`)).toBeNull();
    expect(readHandoffTarget(`#handoff=t&to=${encodeURIComponent('/a/../../etc')}`)).toBeNull();
    expect(readHandoffTarget('#handoff=t&to=%E0%A4%A')).toBeNull(); // undecodable
    // A raw (unencoded) path with nothing the fragment's own syntax would cut still reads.
    expect(readHandoffTarget('#handoff=t&to=/health')).toBe('/health');
  });

  it('reads the value as the launcher writes it, and refuses a raw query rather than truncating it', () => {
    const path = '/x?c=1&tab=team';
    // Percent-encoded, as `withHandoffTarget` writes it: the whole path, query and all.
    expect(readHandoffTarget(`#handoff=t&to=${encodeURIComponent(path)}`)).toBe(path);
    // Hand-written and unencoded, the '&' split would have read `/x?c=1` and
    // dropped `tab=team` on the floor: refused whole, so the app opens at home.
    expect(readHandoffTarget('#handoff=t&to=/x?c=1&tab=team')).toBeNull();
    expect(readHandoffTarget('#handoff=t&to=/x?c=1')).toBeNull();
  });
});

describe('landingUrl', () => {
  it("puts the target under the app's base path", () => {
    expect(landingUrl('/', '/health')).toBe('/health');
    expect(landingUrl('/console/', '/health')).toBe('/console/health');
    expect(landingUrl('', '/?c=x')).toBe('/?c=x');
  });
});
