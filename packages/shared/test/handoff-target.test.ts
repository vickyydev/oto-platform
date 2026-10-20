import { describe, expect, it } from 'vitest';
import { landingUrl, readHandoffTarget, safeTargetPath, withHandoffTarget } from '../src/handoff-target';

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
    ['encoded slash', '/health%2f..%2fadmin'],
    ['single dot segment', '/./health'],
    ['fragment', '/health#handoff=x'],
    ['whitespace', '/health page'],
    ['control character', '/health\n'],
    ['non-ASCII', '/héalth'],
    ['undecodable', '/health%zz'],
    ['too long', `/${'a'.repeat(600)}`],
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
    // A raw (unencoded) path still reads, up to the fragment's next '&'.
    expect(readHandoffTarget('#handoff=t&to=/health')).toBe('/health');
  });
});

describe('landingUrl', () => {
  it("puts the target under the app's base path", () => {
    expect(landingUrl('/', '/health')).toBe('/health');
    expect(landingUrl('/console/', '/health')).toBe('/console/health');
    expect(landingUrl('', '/?c=x')).toBe('/?c=x');
  });
});
