// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignInPanel } from '@/components/SignInPanel';

const calls = vi.hoisted(() => ({
  setupStart: vi.fn(), resetRequest: vi.fn(),
  setupComplete: vi.fn(), resetComplete: vi.fn(), signIn: vi.fn(),
}));
vi.mock('@/api/platform', () => ({ authApi: calls }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({ signIn: calls.signIn }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<SignInPanel />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}
const click = (label: string) => act(async () => { button(label).click(); });
function typeIn(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`Expected input: ${selector}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([
  ['First shift? Set up account', 'setupStart', 'setupComplete', 'Complete setup & sign in', 'already set up'],
  ['Forgot password?', 'resetRequest', 'resetComplete', 'Reset password & sign in', 'needs confirmation'],
] as const)('keeps %s on the phone step until the user reports receiving a code', async (entry, start, finish, submit, help) => {
  calls[start].mockResolvedValue({ ok: true });
  await click(entry);
  typeIn('input[type=tel]', 'test-handset');
  await click('Send code');
  expect(calls[start]).toHaveBeenCalledExactlyOnceWith('test-handset');
  expect(container.querySelector('[autocomplete=one-time-code]')).toBeNull();
  expect(container.querySelector('[autocomplete=new-password]')).toBeNull();
  expect(container.querySelector('details')?.textContent).toContain(help);
  expect(container.querySelector('details')?.textContent).toContain('missing from your staff account');
  expect(container.querySelector('details')?.textContent).toContain('switched off');
  expect(container.querySelector('[role=status]')?.textContent).toContain('if you have a code');
  await act(async () => { container.querySelector('form')!.requestSubmit(); });
  expect(calls[start]).toHaveBeenCalledTimes(1);
  expect(calls[finish]).not.toHaveBeenCalled();
  expect(container.querySelector('[autocomplete=one-time-code]')).toBeNull();

  await click('I received my code');
  const code = '1'.repeat(6);
  const password = 'fixture'.repeat(2);
  typeIn('[autocomplete=one-time-code]', code);
  typeIn('[autocomplete=new-password]', password);
  await click(submit);
  expect(calls[finish]).toHaveBeenCalledExactlyOnceWith('test-handset', code, password);
  expect(calls.signIn).toHaveBeenCalledExactlyOnceWith('test-handset', password);
});

it('returns to the phone step for an edited number and clears entries when switching flows', async () => {
  await click('Forgot password?');
  typeIn('input[type=tel]', 'first-test-handset');
  await click('Send code');
  await click('I received my code');
  typeIn('[autocomplete=new-password]', 'fixture'.repeat(2));
  typeIn('input[type=tel]', 'second-test-handset');
  expect(container.querySelector('[autocomplete=one-time-code]')).toBeNull();
  expect(container.querySelector('[role=status]')).toBeNull();
  await click('Send code');
  await click('I received my code');
  expect(container.querySelector<HTMLInputElement>('[autocomplete=new-password]')?.value).toBe('');
  await click('Back to sign in');
  await click('First shift? Set up account');
  expect(button('Send code').disabled).toBe(false);
  expect(container.querySelector('[autocomplete=one-time-code]')).toBeNull();
});

it('keeps a failed or limited request on the phone step and allows a deliberate retry', async () => {
  calls.resetRequest.mockRejectedValueOnce(new Error('Try again later')).mockResolvedValue({ ok: true });
  await click('Forgot password?');
  typeIn('input[type=tel]', 'test-handset');
  await click('Send code');
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Try again later');
  expect(container.querySelector('[role=status]')).toBeNull();
  expect(container.querySelector('[autocomplete=one-time-code]')).toBeNull();
  await click('Send code');
  expect(calls.resetRequest).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(button('I received my code').disabled).toBe(false);
});
