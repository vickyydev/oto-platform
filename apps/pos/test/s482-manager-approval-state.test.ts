import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import type { CreditApproval } from '@/api/vouchers';
import { useManagerApproval } from '@/lib/managerApproval';

/**
 * SCRUM-482 — THE MANAGER'S PASSWORD IS HELD ONLY WHILE IT IS TYPED
 * (`lib/managerApproval.ts`). "Needs a manager" sends the manager's phone and
 * password with the issue; once the platform answers, the password field is
 * empty whatever the answer was:
 *
 *   - approved: both fields are forgotten and the dialog closes;
 *   - the approval refused (a wrong password, the throttle…): the dialog stays
 *     with the phone and the platform's sentence, the password gone;
 *   - refused for anything else (used up, offline): everything is forgotten.
 *
 * Nothing goes to the browser's storage. The hook runs on the harness in place
 * of React (support/hooks.ts).
 */
vi.mock('react', () => import('./support/hooks'));

const PHONE = '+66900000004';
const SECRET = 'ZZsentinel-pos-482';

afterEach(() => {
  vi.restoreAllMocks();
});

function typed() {
  const view = renderHook(() => useManagerApproval());
  view.result.current.setPhone(PHONE);
  view.result.current.setPassword(SECRET);
  return view;
}

/** Every storage call the till could make, watched. */
function watchStorage() {
  const writes: string[] = [];
  const store = {
    getItem: () => null,
    setItem: (key: string, value: string) => void writes.push(`${key}=${value}`),
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('sessionStorage', store);
  return writes;
}

describe('the manager’s password is held only while it is typed (SCRUM-482)', () => {
  it('approved: the request carries exactly what was typed, then both fields are empty', async () => {
    const writes = watchStorage();
    const view = typed();
    const sent: CreditApproval[] = [];
    const outcome = await view.result.current.submit(async (approval) => {
      sent.push(approval);
      return { voucher: 'v-1' };
    });
    expect(sent).toEqual([{ phone: PHONE, password: SECRET }]);
    expect(outcome).toEqual({ ok: true, value: { voucher: 'v-1' } });
    expect(view.result.current).toMatchObject({ phone: '', password: '', busy: false, error: null });
    expect(writes).toEqual([]);
  });

  it('a refused approval keeps the dialog and the phone, says why, and forgets the password', async () => {
    const view = typed();
    const outcome = await view.result.current.submit(async () => {
      throw new ApiError(403, 'VOUCHER_APPROVAL_INCORRECT', 'The manager’s phone number or password is incorrect.');
    });
    expect(outcome).toMatchObject({ ok: false, approvalRefused: true });
    expect(view.result.current).toMatchObject({
      phone: PHONE,
      password: '',
      busy: false,
      error: 'The manager’s phone number or password is incorrect.',
    });
    expect(JSON.stringify(view.result.current)).not.toContain(SECRET);
  });

  it('the throttle is an approval refusal too, in the platform’s words', async () => {
    const view = typed();
    const outcome = await view.result.current.submit(async () => {
      throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many failed attempts. Try again in 300s.');
    });
    expect(outcome).toMatchObject({ ok: false, approvalRefused: true });
    expect(view.result.current).toMatchObject({ password: '', error: 'Too many failed attempts. Try again in 300s.' });
  });

  it('refused for anything else: everything typed is forgotten and the refusal is the row’s to say', async () => {
    const view = typed();
    const outcome = await view.result.current.submit(async () => {
      throw new ApiError(409, 'VOUCHER_LIMIT_REACHED', 'This promotion is used up — its one redemption has been taken');
    });
    expect(outcome).toMatchObject({ ok: false, approvalRefused: false });
    expect(view.result.current).toMatchObject({ phone: '', password: '', error: null, busy: false });
  });

  it('nothing is sent without both fields, and Back forgets them', async () => {
    const view = renderHook(() => useManagerApproval());
    view.result.current.setPhone(PHONE);
    const send = vi.fn();
    expect(await view.result.current.submit(send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    view.result.current.setPassword(SECRET);
    view.result.current.reset();
    expect(view.result.current).toMatchObject({ phone: '', password: '', error: null });
  });
});
