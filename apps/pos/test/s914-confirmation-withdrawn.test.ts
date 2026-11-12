import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactChannel } from '@/types';
import { consentFormPhone, contactChangeWithdraws, contactConfirmationStands, type ContactConfirmation } from '@/lib/consentForm';
import { renderHook } from './support/hooks';

/**
 * SCRUM-914 — A NUMBER CONFIRMATION IS ASKED AGAIN AFTER THE NUMBER OR THE
 * CHANNEL WAS CHANGED, ON EVERY SCREEN.
 *
 * On the till's own customer half the family ticked for WhatsApp, switched to
 * Telegram (the tick cleared), switched back to WhatsApp, and the box came
 * back ticked without a new tick; the same when an edited number was typed
 * back. The till kept the confirmation and re-checked it against the number
 * and channel; nothing withdrew it. The paired display already cleared it for
 * good. Now every change on the till (the customer half, staff in Private
 * child details, the phone till's form) withdraws it until the family ticks
 * again.
 *
 * From the same ticket: the check-in board's edit took a landline the form
 * refuses, and did not tell staff that a new number or channel withdrew the
 * confirmation. Its edit now holds a new number to the form's rule and says
 * so plainly; the platform says so with the save (api test
 * `s914-board-number-rule.test.ts`).
 */

vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
const board = vi.hoisted(() => ({ history: vi.fn(async () => ({ entries: [] })) }));
vi.mock('@/api/checkin', () => ({ boardApi: { history: board.history }, nannyChoicesFor: () => [] }));
beforeEach(() => { vi.stubGlobal('React', React); });

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8').replace(/\r\n/g, '\n');

/** The till's form, as Till.tsx and MobileTill.tsx keep it, with their change handlers. */
function tillForm(phone: string, channel: ContactChannel) {
  const state = { phone, channel, confirmation: null as ContactConfirmation | null };
  const contact = () => ({ phone: state.phone, channel: state.channel });
  return {
    state,
    tick: () => { state.confirmation = { at: '2026-11-12T10:00:00Z', by: 'family', phone: consentFormPhone(state.phone), channel: state.channel }; },
    changePhone: (next: string) => {
      if (contactChangeWithdraws(contact(), { ...contact(), phone: next })) state.confirmation = null;
      state.phone = next;
    },
    changeChannel: (next: ContactChannel) => {
      if (contactChangeWithdraws(contact(), { ...contact(), channel: next })) state.confirmation = null;
      state.channel = next;
    },
    confirmed: () => contactConfirmationStands(state.confirmation, state.phone, state.channel),
  };
}

describe('a change withdraws the confirmation until the family ticks again', () => {
  it('WhatsApp ticked, Telegram, back to WhatsApp: not ticked any more', () => {
    const form = tillForm('+66898914001', 'whatsapp');
    form.tick();
    expect(form.confirmed()).toBe(true);
    form.changeChannel('telegram');
    expect(form.confirmed()).toBe(false);
    form.changeChannel('whatsapp');
    expect(form.confirmed()).toBe(false);
    form.tick();
    expect(form.confirmed()).toBe(true);
  });

  it('an edited number typed back is not ticked any more either', () => {
    const form = tillForm('+66898914001', 'whatsapp');
    form.tick();
    form.changePhone('+6689891400');
    form.changePhone('+66898914001');
    expect(form.confirmed()).toBe(false);
  });

  it('the same number in another form, or the same channel pressed again, is no change', () => {
    expect(contactChangeWithdraws({ phone: '+66898914001', channel: 'line' }, { phone: '0898914001', channel: 'line' })).toBe(false);
    expect(contactChangeWithdraws({ phone: '+66898914001', channel: 'line' }, { phone: '+660898914001', channel: 'line' })).toBe(false);
    const form = tillForm('+66898914001', 'whatsapp');
    form.tick();
    form.changeChannel('whatsapp');
    form.changePhone('+660898914001');
    expect(form.confirmed()).toBe(true);
  });

  it('every till screen that changes the number or channel goes through the rule', () => {
    const till = src('pages/Till.tsx');
    // The customer half and staff's Private child details, both.
    expect(till.match(/onParentPhoneChange=\{changeGuardianPhone\}/g)).toHaveLength(2);
    expect(till.match(/onParentContactMethodChange=\{changeGuardianChannel\}/g)).toHaveLength(2);
    expect(till).not.toContain('onParentPhoneChange={setSuperParentPhone}');
    expect(till).not.toContain('onParentContactMethodChange={setSuperParentContactMethod}');
    const phone = src('components/mobile/MobileTill.tsx');
    expect(phone).toContain('onParentPhoneChange={changeFormPhone}');
    expect(phone).toContain('onParentContactMethodChange={changeFormChannel}');
  });
});

describe('the check-in board’s edit', () => {
  const stay = {
    id: 'zz-914-stay', registrationId: 'zz-914-reg', childName: 'ZZ TEST Mai', childAge: 6, parentName: 'ZZ TEST Ploy',
    contactMethod: 'whatsapp' as const, phone: '+66898914001', mayOrderFood: false, serviceType: 'drop_off' as const,
    status: 'in_park' as const, registeredAt: '2026-11-12T03:00:00Z',
  };
  type Node = React.ReactElement<Record<string, unknown>>;
  const nodes = (tree: unknown): Node[] => Array.isArray(tree) ? tree.flatMap(nodes)
    : React.isValidElement<Record<string, unknown>>(tree) ? [tree, ...nodes(tree.props.children)] : [];

  async function editor() {
    const { EditCheckInModal } = await import('@/components/dropoff/EditCheckInModal');
    const { PhoneInput } = await import('@/components/shared/PhoneInput');
    const view = renderHook(() => EditCheckInModal({ open: true, onOpenChange: () => undefined, checkIn: stay as never,
      nannies: [], softMax: 4, onSave: () => undefined }));
    const all = () => nodes(view.result.current);
    const phone = () => all().find((node) => node.type === PhoneInput)!;
    const save = () => all().find((node) => typeof node.props.onClick === 'function' && nodes(node.props.children)
      .length >= 0 && JSON.stringify(node.props.children).includes('Save changes'))!;
    const byTestId = (id: string) => all().find((node) => node.props['data-testid'] === id);
    return { view, phone, save, byTestId };
  }

  it('says nothing while the number and channel are as they were', async () => {
    const edit = await editor();
    expect(edit.byTestId('edit-phone-invalid')).toBeUndefined();
    expect(edit.byTestId('edit-confirmation-withdrawn')).toBeUndefined();
    expect(edit.save().props.disabled).toBe(false);
    edit.view.unmount();
  });

  it('refuses a landline in the form’s own words, and will not save it', async () => {
    const edit = await editor();
    (edit.phone().props.onChange as (v: string) => void)('+6621234567');
    edit.view.rerender();
    expect(edit.byTestId('edit-phone-invalid')).toBeDefined();
    expect(edit.save().props.disabled).toBe(true);
    edit.view.unmount();
  });

  it('says plainly that a new number or another channel withdraws the family’s confirmation', async () => {
    const edit = await editor();
    (edit.phone().props.onChange as (v: string) => void)('+66898914002');
    edit.view.rerender();
    expect(JSON.stringify(edit.byTestId('edit-confirmation-withdrawn')!.props.children))
      .toContain("withdraws the family's confirmation of their messaging number");
    expect(edit.save().props.disabled).toBe(false);
    (edit.phone().props.onChange as (v: string) => void)(stay.phone);
    (edit.phone().props.onChannelChange as (c: ContactChannel) => void)('telegram');
    edit.view.rerender();
    expect(edit.byTestId('edit-confirmation-withdrawn')).toBeDefined();
    edit.view.unmount();
  });

  it('the board shows the platform’s word that the confirmation was withdrawn, with the save and with Update & resend', () => {
    for (const file of ['pages/DropOff.tsx', 'components/mobile/dropoff/MobileDropOffBoard.tsx']) {
      const page = src(file);
      expect(page).toContain('...res.warnings,');
      expect(page).toContain('...(res?.warnings ?? [])');
    }
  });
});
