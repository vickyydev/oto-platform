// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Landing } from '@/pages/Landing';

const { session, issue, registry } = vi.hoisted(() => ({
  session: { state: 'signed-in', locked: false, me: { account: { mustChangePassword: false } }, has: (): boolean => true },
  issue: vi.fn(),
  registry: vi.fn(),
}));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => session }));
vi.mock('@/suite/handoff', () => ({ openApp: issue }));
vi.mock('@/api/platform', () => ({ suiteApi: { apps: registry } }));
vi.mock('@/components/LockedPanel', () => ({ LockedPanel: () => <span>Locked</span> }));
vi.mock('@/components/ChangePasswordPanel', () => ({ ChangePasswordPanel: () => <span>Change password</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector('#root')!);
  history.replaceState(null, '', '/#resume=oto_app&to=%2Fcore%2Fcheckins%3Fview%3Dregistered');
  session.locked = false;
  session.me.account.mustChangePassword = false;
  session.has = () => true;
  registry.mockResolvedValue({ apps: [{ key: 'oto_app', state: 'open', sortOrder: 1 }] });
  issue.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); vi.clearAllMocks(); });
const mount = () => act(async () => { root.render(<StrictMode><Landing /></StrictMode>); });
it('returns to the staff link exactly once after sign-in', async () => {
  await mount();
  expect(issue).toHaveBeenCalledTimes(1);
  expect(issue).toHaveBeenCalledWith(expect.objectContaining({ key: 'oto_app' }), '/core/checkins?view=registered', true);
});
it('waits for the session to be unlocked and for a required password change', async () => {
  session.locked = true;
  await mount();
  expect(document.body.textContent).toContain('Locked');
  session.locked = false;
  session.me.account.mustChangePassword = true;
  await mount();
  expect(document.body.textContent).toContain('Change password');
  expect(issue).not.toHaveBeenCalled();
});
it('requires the account to have the app grant', async () => {
  session.has = () => false;
  await mount();
  expect(document.body.textContent).toContain('unavailable');
  expect(issue).not.toHaveBeenCalled();
});
it('honours maintenance before opening the staff page', async () => {
  registry.mockResolvedValue({apps:[{key:'oto_app',state:'maintenance',maintenance:{message:'Back soon', expiresAt:''}}]});
  await mount();
  expect(document.body.textContent).toContain('Back soon');
  expect(issue).not.toHaveBeenCalled();
});

