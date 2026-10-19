/**
 * `@oto/messaging` — the Inbox's channel seam (S2-19, SCRUM-580, round I2a).
 *
 * `docs/progress/plans/inbox-build/PLAN.md` §2 is the authority. The package
 * has the shape of `@oto/payments-2c2p`: pure Node, no database, no routes, no
 * environment reads, and its own Vitest checks.
 *
 *   contract.ts        `MessagingChannel`, the normalised inbound and
 *                      outbound shapes, the five send refusals.
 *   webhook.ts         Meta's `X-Hub-Signature-256` envelope and GET
 *                      challenge, shared by the skeleton and the simulator;
 *                      the delivery id.
 *   window.ts          the 24-hour free-text rule, once.
 *   console.ts         `ConsoleChannel`: wraps the api's console SMS sender;
 *                      send-only, `reply: false` (Cut A and B).
 *   simulator.ts       `SimulatorChannel`: signed synthetic deliveries,
 *                      acknowledged sends, scheduled receipts, no network.
 *   whatsapp-cloud.ts  `WhatsAppCloudChannel`: the skeleton, tested on
 *                      recorded fixtures only, never live in this story.
 *   config.ts          the `INBOX_*` variable names and their one reading.
 */

export * from './contract';
export * from './webhook';
export * from './window';
export * from './config';
export {
  ConsoleChannel,
  type ConsoleChannelDeps,
  type ConsoleRecord,
  type ConsoleSender,
} from './console';
export {
  SimulatorChannel,
  SIMULATOR_FIXTURE_IMAGE,
  type SimulatedInbound,
  type SimulatedInboundResult,
  type SimulatedSend,
  type SimulatorChannelDeps,
} from './simulator';
export {
  WhatsAppCloudChannel,
  GRAPH_API_VERSION,
  GRAPH_BASE_URL,
  DEFAULT_MEDIA_HOST_SUFFIXES,
  buildMediaMetadataRequest,
  buildSendRequest,
  parseWhatsAppPayload,
  phoneFromWaId,
  recipientOf,
  refusalForGraphError,
  type FetchLike,
  type GraphRequest,
  type ParseOptions,
  type WhatsAppCloudConfig,
  type WhatsAppCloudDeps,
} from './whatsapp-cloud';
