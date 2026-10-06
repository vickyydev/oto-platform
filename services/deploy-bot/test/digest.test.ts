import { describe, expect, it } from 'vitest';
import { localClock, releaseSince, type SeenDeploy } from '../src/digest.js';
import { loadEnv } from '../src/env.js';
import { wentLive } from '../src/render.js';

describe('releaseSince', () => {
  const t = (hhmm: string) => `2026-09-20T${hhmm}:00Z`;
  const ms = (hhmm: string) => Date.parse(t(hhmm));
  let n = 0;
  /** A deploy of `sha`, committed at `committed`, that ended at `finished` as `status`. */
  const seen = (
    service: string,
    sha: string,
    committed: string,
    finished: string,
    status = 'deactivated',
    trigger = 'new_commit',
  ): SeenDeploy => ({
    service,
    deploy: {
      id: `dep-${(n += 1)}`,
      status,
      trigger,
      finishedAt: t(finished),
      commit: { id: sha, message: `feat: ${sha}\n\nbody of ${sha}`, createdAt: t(committed) },
    },
  });
  const shas = (r: ReturnType<typeof releaseSince>) => r.commits.map((c) => c.sha);

  // The morning's pushes, as two services saw them. `ccc` failed on the api
  // and was then shipped inside `ddd`.
  const day: SeenDeploy[] = [
    seen('oto-api-staging', 'aaa', '08:20', '08:25'),
    seen('oto-pos-staging', 'aaa', '08:20', '08:24'),
    seen('oto-api-staging', 'bbb', '08:43', '08:48'),
    seen('oto-pos-staging', 'bbb', '08:43', '08:47'),
    seen('oto-api-staging', 'ccc', '09:30', '09:33', 'build_failed'),
    seen('oto-api-staging', 'ddd', '11:17', '11:21', 'live'),
    seen('oto-pos-staging', 'ddd', '11:17', '11:20', 'live'),
  ];

  it('takes what is running from the deploy that finished last', () => {
    expect(releaseSince(day, new Date(t('00:00')), null).head).toEqual({
      sha: 'ddd',
      at: ms('11:17'),
    });
  });

  it('lists each commit once, oldest first, however many services deployed it', () => {
    expect(shas(releaseSince(day, new Date(t('00:00')), null))).toEqual([
      'aaa',
      'bbb',
      'ccc',
      'ddd',
    ]);
  });

  it('includes a commit whose own deploy failed but which shipped inside a later one', () => {
    expect(shas(releaseSince(day, new Date(t('09:00')), ms('08:43')))).toEqual(['ccc', 'ddd']);
  });

  it('leaves out what was already announced, even when its deploy is still in view', () => {
    const r = releaseSince(day, new Date(t('09:00')), ms('08:43'));
    expect(r.live.map((l) => l.deploy.commit?.id)).toEqual(['ddd', 'ddd']);
    expect(shas(r)).not.toContain('bbb');
  });

  it('leaves out a commit that failed after the last deploy that went live', () => {
    const later = [...day, seen('oto-api-staging', 'eee', '12:00', '12:03', 'build_failed')];
    const r = releaseSince(later, new Date(t('00:00')), null);
    expect(r.head?.sha).toBe('ddd');
    expect(shas(r)).not.toContain('eee');
  });

  it('finds nothing live when every deploy since the last digest failed', () => {
    const r = releaseSince(day, new Date(t('11:30')), ms('11:17'));
    expect(r.live).toEqual([]);
    expect(r.head).toBeNull();
  });

  it('describes a roll-back by the commit it went back to', () => {
    const back = [...day, seen('oto-api-staging', 'bbb', '08:43', '12:10', 'live', 'rollback')];
    const r = releaseSince(back, new Date(t('11:30')), ms('11:17'));
    expect(r.rollback).toBe(true);
    expect(r.head?.sha).toBe('bbb');
    expect(shas(r)).toEqual(['bbb']);
  });
});

describe('localClock', () => {
  it('reads the day and time as the park sees them, not as UTC does', () => {
    // 02:00 UTC is 09:00 in Bangkok.
    expect(localClock(new Date('2026-09-20T02:00:00Z'), 'Asia/Bangkok')).toEqual({
      day: '2026-09-20',
      minutes: 9 * 60,
    });
  });

  it('rolls the day over at local midnight', () => {
    // 18:30 UTC on the 20th is 01:30 on the 21st in Bangkok.
    expect(localClock(new Date('2026-09-20T18:30:00Z'), 'Asia/Bangkok')).toEqual({
      day: '2026-09-21',
      minutes: 90,
    });
  });

  it('reports midnight as zero minutes, not twenty-four hours', () => {
    expect(localClock(new Date('2026-09-20T17:00:00Z'), 'Asia/Bangkok').minutes).toBe(0);
  });
});

describe('wentLive', () => {
  it('counts a deploy that is live or was live, and nothing else', () => {
    const d = (status: string) => ({ id: 'dep-1', status });
    expect(wentLive(d('live'))).toBe(true);
    expect(wentLive(d('deactivated'))).toBe(true);
    expect(wentLive(d('build_failed'))).toBe(false);
    expect(wentLive(d('canceled'))).toBe(false);
    expect(wentLive(d('build_in_progress'))).toBe(false);
  });
});

describe('loadEnv', () => {
  const minimum = { DATABASE_URL: 'postgres://x', ADMIN_TOKEN: 'x'.repeat(32) };

  it('applies the morning defaults', () => {
    const env = loadEnv(minimum);
    expect(env.DIGEST_TIME).toBe(9 * 60);
    expect(env.DIGEST_LATEST).toBe(12 * 60);
    expect(env.PART_INTERVAL_MIN).toBe(30);
    expect(env.SUMMARY_MODEL).toBe('claude-opus-5');
  });

  it('reduces a phone number to the digits WhatsApp addresses it by', () => {
    expect(loadEnv({ ...minimum, WHATSAPP_PHONE: '+44 7520 000000' }).WHATSAPP_PHONE).toBe(
      '447520000000',
    );
  });

  it('refuses a short admin token', () => {
    expect(() => loadEnv({ ...minimum, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
  });

  it('splits the service lists', () => {
    expect(
      loadEnv({ ...minimum, WATCH_SERVICES: 'oto-api-staging, oto-pos-staging' }).WATCH_SERVICES,
    ).toEqual(['oto-api-staging', 'oto-pos-staging']);
  });
});
