/**
 * `@oto/box-agent` — what runs on a box (S2-04, S2-05).
 *
 * The package has no dependency on the platform's database or its api process
 * on purpose: the same code runs on a Raspberry Pi at a counter in Phuket and
 * inside the api service on Render as the "virtual box". That is what makes
 * every flow in this sprint — pairing, config bundles, commands, heartbeats,
 * station sessions and the outbox — provable months before anybody carries
 * hardware anywhere.
 *
 * `./sqlite` is deliberately NOT re-exported here: importing `node:sqlite`
 * prints an experimental warning on every boot, and the api will never open a
 * SQLite file. A Pi imports `@oto/box-agent/sqlite` directly.
 */
export * from './protocol';
export * from './contract';
export * from './credentials';
export * from './transport';
export * from './signing';
export * from './store';
export * from './store-sql';
export * from './store-postgres';
export * from './outbox';
export * from './station-session';
export * from './printing/index';
/**
 * The card terminals (S2-10a). Exported for the same reason printing is: the
 * api resolves a station's routing, queues the tender and records its outcome,
 * and it needs the `PaymentTerminal` contract's words to do any of that.
 */
export * from './terminal/index';
/**
 * Scanning and the signed staff token (S2-06). `scan-input` is the part that
 * has no I/O in it — the burst rule and the record rule — so the api imports
 * it to drive a simulated scanner through exactly the state machine that will
 * read the real one.
 */
export * from './scan';
export * from './scan-input';
export * from './staff-token';
export * from './cache-apply';
/**
 * The Lucky Wheel (S2-07a).
 *
 * `booth-draw` carries no I/O at all — the eligibility rule and the weighted
 * pick — so it is importable anywhere the draw has to be reasoned about,
 * exactly as `scan-input` is for the burst rule. `booth-http` is the `/booth/*`
 * contract as a plain function, so whatever serves the booth's kiosk wires it
 * to its own server without this package growing an opinion about which.
 */
export * from './booth-draw';
export * from './booth';
export * from './booth-http';
export * from './agent';
/**
 * The station bridge and what it prices with (offline plan Round 3): the
 * counter's surface to its box, mounted by the api for a virtual box and by a
 * Pi's runner on loopback. `offline-pricing` carries no I/O, so the api's
 * parity test prices one cart both ways through it.
 */
export * from './offline-pricing';
export * from './station-bridge';
/**
 * S2-13 round 4 — check-in on the box lane: the desk the bridge hands its
 * check-in intents to, the bounded photo store and the worker that sends the
 * photos taken offline through the platform when the link is back.
 */
export * from './checkin-desk';
export * from './blob-store';
export * from './photo-upload';
/**
 * S2-14a round 4 — credit on the box lane under the offline cap: the key
 * digests the api ships the `wallets` scope with, and the arithmetic the
 * bridge spends by.
 */
export * from './wallet-lane';
/**
 * S2-14b round 3 — counted stock on the box lane: the snapshot reader and the
 * guard's arithmetic the bridge sells by.
 */
export * from './stock-lane';
