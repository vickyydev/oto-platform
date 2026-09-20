/**
 * `@oto/box-agent` — what runs on a box (S2-04).
 *
 * The package has no dependency on the platform's database or its api process
 * on purpose: the same code runs on a Raspberry Pi at a counter in Phuket and
 * inside the api service on Render as the "virtual box". That is what makes
 * every flow in this sprint — pairing, config bundles, commands, heartbeats —
 * provable months before anybody carries hardware anywhere.
 */
export * from './protocol';
export * from './credentials';
export * from './transport';
export * from './agent';
