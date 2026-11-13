/**
 * SCRUM-867 — THE PAYMENT SCOPE IS THE ORDER, NOT WHO IT IS FOR.
 *
 * The payment stage (`lib/usePaymentStage.ts`) starts over whenever its scope
 * changes: the method chosen and the cash typed belong to the order they were
 * typed for, and an order that changed under them is another sale. The scope
 * used to be the whole cart identity, member included — and a walk-in whose
 * rate was verified on this sale becomes a member a moment after the payment
 * screen opens (`saveDeferredVerification`, SCRUM-779). That save changed the
 * scope, the stage reset itself a second after opening, the Cash highlight
 * and the amount typed vanished, and a sale saved while the screen "moved on"
 * was announced as the previous visitor's.
 *
 * A member joining the sale does not change what is being sold: the sale
 * writer treats the same body with a member added as the same sale
 * (`bodySignatureOf`, `attachMember`), and this is the same rule for the
 * scope. What stays in it is everything that prices or identifies the order
 * — branch, station, tier, the document check, the lines, the discounts.
 */
export function cartBodyIdentity<
  T extends { memberId?: string | null; customerPhone?: string | null; customerNickname?: string | null; accountId?: string; accountName?: string },
>(identity: T | null): Omit<T, 'memberId' | 'customerPhone' | 'customerNickname' | 'accountId' | 'accountName'> | null {
  if (!identity) return null;
  const { memberId: _member, customerPhone: _phone, customerNickname: _nickname, accountId: _account, accountName: _name, ...body } = identity;
  return body;
}

/** SCRUM-982: collection belongs to the order; the request's session identifies the confirmer. */
export function paymentOrderIdentity<T extends { accountId?: string; accountName?: string }>(identity: T | null): Omit<T, 'accountId' | 'accountName'> | null {
  if (!identity) return null;
  const { accountId: _account, accountName: _name, ...order } = identity;
  return order;
}
