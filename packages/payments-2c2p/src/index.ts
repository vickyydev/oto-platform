/**
 * `@oto/payments-2c2p` — the ONLY place in this repository that knows 2C2P
 * exists (S2-10a, SCRUM-206, Slice D).
 *
 * `docs/architecture/PAYMENT_GATEWAY.md` is the authority for every fact
 * behind this package and it is not to be re-researched
 * (`DEVELOPMENT_PLAN.md:1532`). What is here is that document, built:
 *
 *   contract.ts     the `QrPayment` seam, the gateway's own state words, and
 *                   D-3 — the one mapping from those words to the ledger's
 *                   `pos.payment_attempt.status`.
 *   envelope.ts     the HS256 JWT both directions travel in. VERIFY, THEN READ.
 *   resp-codes.ts   2C2P's `respCode` read as one of our states.
 *   config.ts       hosts, and the `D(12,5)` wire amount — the only place a
 *                   decimal amount exists at all.
 *   twoc2p.ts       Payment Token -> Do Payment (PPQR, `qrType: RAW`, flow
 *                   1005) -> Payment Inquiry.
 *   maintenance.ts  void `V` and refund `R`, on their own host and in their own
 *                   crypto envelope (JWE RSA-OAEP + A256GCM / JWS PS256).
 *   simulator.ts    the same shapes with nothing on the other end, so CI, a
 *                   demo and a fresh checkout never need the sandbox.
 *   redirect.ts     the booking site's browser return (§2.8 step 5): a
 *                   `paymentResponse` verified and read as a DISPLAY HINT,
 *                   never as a payment state (S2-12).
 *   emvco.ts        the simulator's locally generated, deliberately unpayable
 *                   EMVCo payload.
 *
 * Money crosses this boundary as integer satang, always.
 */

export * from './contract';
export * from './config';
export * from './envelope';
export * from './resp-codes';
export * from './emvco';
export { TwoC2PQrPayment, factsOf, type TwoC2PDeps } from './twoc2p';
export {
  SimulatorQrPayment,
  type SimulatedHostedPage,
  type SimulatorDeps,
  type SimulatorEvent,
} from './simulator';
export { readFrontendReturn, signFrontendReturn, type FrontendReturnHint } from './redirect';
export {
  MaintenanceClient,
  signJws,
  verifyJws,
  encryptJwe,
  decryptJwe,
  type MaintenanceDeps,
} from './maintenance';
