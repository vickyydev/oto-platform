import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

// Local runs only — on Render there are no .env files and the service's own
// environment is all there is. The bot's .env is read first and wins; the
// repository's main .env fills in whatever that leaves out, so keys that
// already live there (Render, Anthropic, Twilio) are not copied into a second
// file. A variable already set in the real environment beats both.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: [join(here, '../.env'), join(here, '../../../.env')], quiet: true });

const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Digits only, country code first — the form WhatsApp addresses a number by. */
const waNumber = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine(
    (v) => v === '' || (v.length >= 8 && v.length <= 15),
    'expected a full international number',
  );

/** `HH:MM`, read as minutes after midnight. */
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .transform((v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3)));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8790),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  // The bot keeps everything in its own schema so nothing it does can touch,
  // or be touched by, the platform's tables and migrations.
  DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('deploybot'),

  // Guards /send and /admin/*. Anyone holding it can post to the group.
  ADMIN_TOKEN: z.string().min(24),

  RENDER_API_KEY: z.string().default(''),
  // Injected by Render. The bot's own deploys are never part of a digest.
  RENDER_SERVICE_ID: z.string().default(''),
  // Service names to report on. Empty means every service the key can see.
  WATCH_SERVICES: list,
  IGNORE_SERVICES: list,

  WHATSAPP_PHONE: waNumber.default(''),
  WHATSAPP_GROUP_ID: z
    .string()
    .regex(/^[0-9-]+@g\.us$/)
    .or(z.literal(''))
    .default(''),
  OWNER_PHONE: waNumber.default(''),

  ENV_LABEL: z.string().default('OTO staging'),
  DIGEST_TZ: z.string().default('Asia/Bangkok'),
  // The digest goes out at DIGEST_TIME. A bot that was down at that moment
  // still sends when it comes back, but not after DIGEST_LATEST: a "morning"
  // message in the evening is noise, and nothing is lost by waiting — the
  // next digest covers everything since the last one that was sent.
  DIGEST_TIME: clock.default('09:00'),
  DIGEST_LATEST: clock.default('12:00'),
  PART_MAX_CHARS: z.coerce.number().int().min(400).max(4000).default(1500),
  PART_INTERVAL_MIN: z.coerce.number().int().min(1).default(30),
  MAX_PARTS: z.coerce.number().int().min(1).max(6).default(4),
  MESSAGE_TTL_HOURS: z.coerce.number().int().min(1).default(6),

  ANTHROPIC_API_KEY: z.string().default(''),
  // One short message a day, read by the people the work is for: worth the
  // better writer. Opus costs roughly $0.15 on a busy day; `claude-haiku-4-5`
  // is about a cent, and noticeably vaguer.
  SUMMARY_MODEL: z.string().default('claude-opus-5'),

  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_API_KEY_SID: z.string().default(''),
  TWILIO_API_KEY_SECRET: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  // A deadline before the send time is a window that never opens: the bot
  // would run, look healthy, and never send a digest.
  if (parsed.data.DIGEST_LATEST < parsed.data.DIGEST_TIME) {
    throw new Error('Invalid environment:\n  DIGEST_LATEST must not be earlier than DIGEST_TIME');
  }
  return parsed.data;
}
