import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Logger } from 'pino';
// The SDK's zod helper is built on zod's v4 API, so the schema it is handed
// has to be too.
import { z } from 'zod/v4';
import type { CommitInfo, Section } from './message.js';

const Digest = z.object({
  sections: z.array(
    z.object({
      title: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
});

const SYSTEM = `You write the morning "what's new" note for the people who run an indoor children's play park. They use this software every day — the till, reception check-in, the staff app, the admin console — but they are not engineers. The note is posted to a WhatsApp group.

You are given every git commit that went live since the last note. Turn them into a short, skimmable summary.

Structure:
- 1 to 4 sections. Each section is a part of the system as its users know it, named in two or three plain words — for example "Till and reception", "Staff app", "Admin console", "Bookings", "Reliability and security". Use the areas the commits actually touch; do not invent sections to fill space.
- 1 to 5 bullets per section, and no more than 12 bullets in the whole note. On a busy day, merge related commits into one bullet and keep only what matters most; never list commits one by one.
- Put the section people will notice most first. Behind-the-scenes work (tests, refactors, documentation, tooling, internal clean-up) goes last, in one section with one or two bullets, or is left out when there is visible work to report. If everything was behind the scenes, say so plainly in a single section.

Each bullet:
- One sentence, under 22 words, in plain everyday English, saying what is now different or possible for the person using or running the system.
- Start with the change itself ("Reception can now…", "Receipts show…", "Fixed the…"). No "we", no "this commit", no praise or sales language.
- Never mention file names, function or table names, libraries, commit types, ticket numbers or branch names. Never mention who asked for the work or any business arrangement.
- Do not use the characters * _ ~ or backticks, do not use emoji, and do not include links.
- Do not invent or guess at anything the commits do not say. If a commit is too cryptic to explain, fold it into a general bullet or leave it out.`;

/**
 * A plain-English digest of the commits, or null when none could be written
 * (no key, an API error, a refusal, or a reply outside the asked-for shape).
 * The caller falls back to the commit subjects, so the morning digest never
 * waits on, or fails because of, this call.
 */
export async function summarise(
  apiKey: string,
  model: string,
  commits: CommitInfo[],
  log: Logger,
): Promise<Section[] | null> {
  if (!apiKey || commits.length === 0) return null;
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: commits.map((c, n) => `Commit ${n + 1}:\n${c.message.trim()}`).join('\n\n'),
        },
      ],
      output_config: { format: zodOutputFormat(Digest) },
    });
    if (response.stop_reason !== 'end_turn' || !response.parsed_output) {
      log.warn({ stopReason: response.stop_reason }, 'summary not usable');
      return null;
    }
    const sections = response.parsed_output.sections
      .map((s) => ({
        title: s.title.trim(),
        bullets: s.bullets.map((b) => b.trim()).filter(Boolean),
      }))
      .filter((s) => s.title && s.bullets.length > 0);
    const bulletCount = sections.reduce((n, s) => n + s.bullets.length, 0);
    if (sections.length === 0 || bulletCount > 20) return null;
    log.info(
      {
        model,
        sections: sections.length,
        bullets: bulletCount,
        // Model usage, for keeping an eye on cost. (Named without the word the
        // log-safety rule reserves for credentials.)
        usageIn: response.usage.input_tokens,
        usageOut: response.usage.output_tokens,
      },
      'summary written',
    );
    return sections;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      log.warn('summary skipped: rate limited');
    } else if (err instanceof Anthropic.APIError) {
      // The API's own sentence is what tells a low balance from a bad request.
      log.warn({ status: err.status, reason: err.message }, 'summary skipped: api error');
    } else {
      log.warn({ err }, 'summary skipped');
    }
    return null;
  }
}
