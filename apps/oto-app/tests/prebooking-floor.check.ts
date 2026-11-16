// SCRUM-987: local contract/floor controls. No database, provider call or real money.
import assert from "node:assert/strict";
import { PartyDepositAnswerSchema } from "../shared/partyDeposit";
import { decideDepositSave, gatewayPaidThbOf } from "../server/lib/depositSaveGuard";

const receipt = {
  id: "00000000-0000-7000-8000-000000000987", eventId: "00000000-0000-7000-8000-000000000987",
  conversationId: "00000000-0000-7000-8000-000000000001", amountSatang: 300_000, currency: "THB", provider: "simulator",
  state: "paid", paymentLink: null, linkExpiresAt: null, invoiceNo: "ZZ-WEB-987", requestedAt: "2026-11-16T12:00:00.000Z",
  remindedAt: null, handedOverAt: null, paidAt: "2026-11-17T17:01:00.000Z", closedAt: null, closeReason: null,
  depositBeforeSatang: 0, depositAfterSatang: 300_000, writeBack: null, requestLineStatus: null,
};
const prebooking = PartyDepositAnswerSchema.parse({ eventId: receipt.eventId, hasConversation: true, current: receipt, history: [receipt] });
assert.equal(prebooking.current!.provider, "simulator");
assert.equal(gatewayPaidThbOf(prebooking), 3000, "current and history are one original receipt, not two payments");
const stored = { amountThb: 3000, date: "2026-11-18" };
const lower = decideDepositSave({ was: stored, said: { amountThb: 0, date: null }, expected: stored, floor: { known: true, amountThb: gatewayPaidThbOf(prebooking) } });
assert.equal(lower.write, null);
assert.equal(lower.note?.reason, "gateway", "a later BEO edit cannot erase the verified prebooking deposit");
const extra = { ...receipt, id: "00000000-0000-7000-8000-000000000988", amountSatang: 200_000, provider: "2c2p" };
const later = PartyDepositAnswerSchema.parse({ eventId: receipt.eventId, hasConversation: true, current: extra, history: [extra, receipt] });
assert.equal(gatewayPaidThbOf(later), 5000, "a subsequent request adds only its own receipt");
const returnedOriginalOmitted = PartyDepositAnswerSchema.parse({ eventId: receipt.eventId, hasConversation: true, current: extra, history: [extra] });
assert.equal(gatewayPaidThbOf(returnedOriginalOmitted), 2000, "an ineligible original receipt is not counted again");
console.log("prebooking-floor.check: 6 controls passed");
