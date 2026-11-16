import { describe, expect, it } from 'vitest';
import { inboxNextAction } from '../src/inbox';

describe('SCRUM-992: next action uses delivery truth, never a viewer read marker', () => {
  const facts = { status: 'active' as const, aiMode: 'live' as const, pendingAi: false, aiHeld: false, outbound: null };
  it.each(['sent', 'delivered', 'read'])('%s AI output is sent and waiting for the customer', providerStatus => {
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'ai', providerStatus } })).toBe('ai_sent');
  });
  it.each(['failed', 'withdrawn', null])('HIGH: %s AI output is never described as sent', providerStatus => {
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'ai', providerStatus } })).toBe('staff_reply_needed');
  });
  it('a queued AI output is still replying, not sent', () => {
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'ai', providerStatus: 'queued' } })).toBe('ai_replying');
  });
  it('a new pending turn takes precedence over the earlier sent output', () => {
    expect(inboxNextAction({ ...facts, pendingAi: true, outbound: { authorKind: 'ai', providerStatus: 'sent' } })).toBe('ai_replying');
  });
  it('shadow mode never claims that a draft or pending turn was sent', () => {
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'ai', providerStatus: 'shadow' } })).toBe('shadow_preview');
    expect(inboxNextAction({ ...facts, aiMode: 'shadow', pendingAi: true })).toBe('ai_previewing');
  });
  it('staff delivery waits for the customer; a queued staff reply still needs attention', () => {
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'staff', providerStatus: 'sent' } })).toBe('waiting_customer');
    expect(inboxNextAction({ ...facts, outbound: { authorKind: 'staff', providerStatus: 'queued' } })).toBe('staff_reply_needed');
  });
  it('handled is independent of pending AI work and customer-message unread counts', () => {
    expect(inboxNextAction({ ...facts, status: 'handled', pendingAi: true })).toBe('handled');
  });
  it('an off assistant and no outbound need a person, including stale pending work', () => {
    expect(inboxNextAction({ ...facts, aiMode: 'off', pendingAi: true })).toBe('staff_reply_needed');
  });
  it('HIGH: a stale pending turn cannot override a person or a paused assistant', () => {
    expect(inboxNextAction({ ...facts, pendingAi: true, outbound: { authorKind: 'staff', providerStatus: 'sent' } })).toBe('waiting_customer');
    expect(inboxNextAction({ ...facts, pendingAi: true, aiHeld: true })).toBe('staff_reply_needed');
    expect(inboxNextAction({ ...facts, pendingAi: true, aiHeld: true, outbound: { authorKind: 'ai', providerStatus: 'queued' } })).toBe('staff_reply_needed');
  });
});
