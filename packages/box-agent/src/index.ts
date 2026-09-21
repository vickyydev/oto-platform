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
 * Scanning and the signed staff token (S2-06). `scan-input` is the part that
 * has no I/O in it — the burst rule and the record rule — so the api imports
 * it to drive a simulated scanner through exactly the state machine that will
 * read the real one.
 */
export * from './scan';
export * from './scan-input';
export * from './staff-token';
export * from './agent';
