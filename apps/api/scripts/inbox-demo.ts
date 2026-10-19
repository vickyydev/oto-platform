/**
 * THE INBOX DEMO, PLAYED (S2-19 I2d, SCRUM-583).
 *
 *   pnpm --filter @oto/api inbox:demo
 *   pnpm --filter @oto/db seed:inbox-demo     (forwards here)
 *
 * The ten demo conversations, played into the OTO operator through the
 * simulator and the real ingest — the same delivery `POST
 * /inbox/simulator/scenario` uses on a running api. Local and CI only by
 * intent; refused on production by the demo's own guard.
 *
 * It signs with `INBOX_SIMULATOR_SECRET` when set, and otherwise with a
 * secret minted for this run: the deliveries are signed and verified inside
 * this one process, so nothing else ever needs it.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { closeDb, getDb } from '@oto/db';
import { DemoDayRefusedError, describeInboxDemo, seedInboxDemo } from '@oto/db/seed';
import { buildInboxChannels } from '../src/services/inbox/channels';
import { simulatorDemoDelivery } from '../src/services/inbox/simulator';

const channels = buildInboxChannels({
  env: {
    INBOX_SIMULATOR: 'on',
    INBOX_SIMULATOR_SECRET: process.env.INBOX_SIMULATOR_SECRET?.trim() || randomBytes(32).toString('hex'),
    INBOX_WHATSAPP_ENABLED: 'false',
    INBOX_META_APP_SECRET: '',
    INBOX_META_VERIFY_TOKEN: '',
  },
  consoleSender: () => ({
    send: () => Promise.reject(new Error('the demo sends nothing to a phone')),
  }),
});

seedInboxDemo(getDb(), { deliver: simulatorDemoDelivery(channels) })
  .then((counts) => {
    console.log(describeInboxDemo(counts));
    return closeDb();
  })
  .catch((err: unknown) => {
    console.error(err instanceof DemoDayRefusedError ? err.message : err);
    process.exitCode = 1;
    return closeDb();
  });
