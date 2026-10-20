/**
 * THE AUDIT ACTIONS THE ASSISTANT MAY FILTER BY (SCRUM-591, test night
 * 2026-10-21, finding D1).
 *
 * `audit.search` used to take any string as its `action` filter. The model
 * guessed a name the audit never writes ("auth.login"), got 0 rows, and told
 * an administrator that nobody had signed in that day while 38 `auth.sign_in`
 * rows sat in the trail. The filter is now an ENUM of names the api actually
 * writes, each with what it means in plain words, so the model picks a real
 * name or says it is guessing. The rest of the vocabulary (some 290 names)
 * stays reachable through the tool's free-text `q`, which the summary names
 * as a guess when it matches nothing.
 *
 * Every name here is pinned to a literal in `apps/api/src` by the engine's
 * census (`apps/api/test/assistant-engine.test.ts`): a name the api stops
 * writing fails the build rather than becoming a silent zero.
 */

export interface AssistantAuditAction {
  action: string;
  /** What the row means, as the model reads it: "a person signed in". */
  means: string;
}

export const ASSISTANT_AUDIT_ACTIONS: readonly AssistantAuditAction[] = [
  // Sign-in and sessions — the group a "who logged in" ask wants first.
  { action: 'auth.sign_in', means: 'a person signed in' },
  { action: 'auth.sign_out', means: 'a person signed out' },
  { action: 'auth.sign_in_failed', means: 'a sign-in was refused (wrong password or unknown phone)' },
  { action: 'auth.locked_out', means: 'an account was locked after repeated failed sign-ins' },
  { action: 'auth.password_change', means: 'a person changed their password' },
  { action: 'auth.password_reset', means: 'a password was reset with a code' },
  { action: 'auth.handoff_issue', means: 'the launcher opened another app for a signed-in person' },
  { action: 'auth.permission_denied', means: 'a request was refused for a missing permission' },
  { action: 'session.lock', means: 'a till session locked' },
  { action: 'session.unlock', means: 'a till session was unlocked' },
  { action: 'session.unlock_failed', means: 'an unlock was refused' },
  // People and access
  { action: 'account.create', means: 'a staff account was created' },
  { action: 'account.update', means: 'a staff account was changed (status, details)' },
  { action: 'account.temp_password', means: 'a temporary password was issued' },
  { action: 'role_assignment.create', means: 'a role was granted to an account' },
  { action: 'role_assignment.delete', means: 'a role was removed from an account' },
  // Members and children
  { action: 'member.create', means: 'a member was registered' },
  { action: 'member.update', means: 'a member’s details were changed' },
  { action: 'member.archive', means: 'a member was archived' },
  { action: 'child.create', means: 'a child was added to a member' },
  { action: 'child.update', means: 'a child’s details (allergies, notes) were changed' },
  { action: 'visit.create', means: 'a visit was opened for a member' },
  // Selling and money
  { action: 'sale.create', means: 'a sale was started on a till' },
  { action: 'sale.finalise', means: 'a sale was completed' },
  { action: 'sale.void', means: 'a sale was voided' },
  { action: 'sale.refund', means: 'a sale was refunded' },
  { action: 'sale.tender', means: 'a payment was taken on a sale' },
  { action: 'payment.settled', means: 'a card or QR payment settled' },
  { action: 'settlement.run', means: 'an end-of-day settlement ran' },
  { action: 'wallet.create', means: 'a wallet was opened' },
  { action: 'wallet.spend', means: 'wallet credit was spent' },
  // Check-in, bookings and events
  { action: 'checkin.create', means: 'a child was checked in to supervision' },
  { action: 'checkin.update', means: 'a check-in changed (collected, moved)' },
  { action: 'booking.create', means: 'an online booking was made' },
  { action: 'booking.redeem', means: 'a booking was redeemed at the till' },
  { action: 'voucher.issue', means: 'a voucher was issued' },
  { action: 'voucher.redeem', means: 'a voucher was redeemed' },
  { action: 'event.checkin', means: 'a child was checked in to an event' },
  { action: 'event.checkout', means: 'a child was checked out of an event' },
  // Stock and catalogue
  { action: 'stock.receive', means: 'a delivery was received' },
  { action: 'stock.adjust', means: 'a stock level was adjusted' },
  { action: 'stock.transfer', means: 'stock moved between locations' },
  { action: 'ticket_package.create', means: 'a ticket package was created' },
  { action: 'ticket_package.update', means: 'a ticket package was changed' },
  // Inbox and the assistant
  { action: 'inbox.conversation.handle', means: 'an Inbox conversation was marked handled' },
  { action: 'inbox.message.reply', means: 'a staff reply was sent from the Inbox' },
  { action: 'assistant.ask', means: 'a question was asked of the assistant' },
];

export const ASSISTANT_AUDIT_ACTION_NAMES = ASSISTANT_AUDIT_ACTIONS.map((a) => a.action) as [string, ...string[]];

/** How many names a zero-row summary lists for the model to choose from. */
export const ASSISTANT_AUDIT_ACTIONS_SHOWN = 20;

/** The catalogue as one line the model reads: "auth.sign_in = a person signed in; …". */
export function assistantAuditActionsLine(limit = ASSISTANT_AUDIT_ACTIONS.length): string {
  return ASSISTANT_AUDIT_ACTIONS.slice(0, limit)
    .map((a) => `${a.action} = ${a.means}`)
    .join('; ');
}
