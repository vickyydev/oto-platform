// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reminder: 'first', send: vi.fn(), confirm: vi.fn(), refresh: vi.fn() }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({
  state: 'signed-in', locked: false, refresh: mocks.refresh,
  me: { account: { phone: '+12025550110' }, phoneVerificationReminder: mocks.reminder },
}) }));
vi.mock('@/api/platform', () => ({ authApi: { requestPhoneVerification: mocks.send, confirmPhoneVerification: mocks.confirm } }));
import { PhoneVerificationPrompt } from '@/components/PhoneVerificationPrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const mount = () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<PhoneVerificationPrompt><div>Staff home</div></PhoneVerificationPrompt>));
  return () => { act(() => root.unmount()); container.remove(); };
};
const click = (label: string) => act(async () => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label);
  expect(button).toBeDefined();
  button!.click();
});
afterEach(() => { sessionStorage.clear(); vi.clearAllMocks(); mocks.reminder = 'first'; });

it('offers verification without sending, remembers Later through reload, and asks again on a fresh login', async () => {
  let close = mount();
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
  await click('Do it later');
  expect(document.body.textContent).toContain('Staff home');
  close();
  close = mount();
  expect(document.querySelector('dialog')).toBeNull();
  close();
  mocks.reminder = 'second';
  close = mount();
  expect(document.querySelector('dialog')?.open).toBe(true);
  await click('Verify now');
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(document.querySelector('input')?.autocomplete).toBe('one-time-code');
  close();
});
