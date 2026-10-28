/**
 * The prompt builder (PLAN §B.1 "Request shape", §C.3, §C.4).
 *
 *   system block 1  STATIC: persona, rules, intent table, output contract.
 *                   Byte-identical on every call (`STATIC_SYSTEM_TEXT`).
 *   system block 2  the knowledge: approved KB rows, live facts (branch
 *                   addresses, hours, standard prices), approved examples.
 *                   Changes only when marketing publishes or a fact changes.
 *                   A one-hour cache breakpoint ends it.
 *   ---------------- cache breakpoint: nothing about the customer above it ---
 *   messages        one user turn: the context line and the episode as data.
 *
 * Nothing here reads a clock, an environment variable or a database: the
 * caller passes everything, so the same input always builds the same bytes.
 */

import { createHash } from 'node:crypto';
import { formatTHB, isoDateInTz, type Satang } from '@oto/shared';
import { AI_REASON_CODES, type AiBranchKey, type AiReplyLanguage } from './decision';
import type { GroundingSource } from './gate';
import { AI_INTENTS, AI_KB_TOPICS, INTENT_TABLE, type AiIntent, type AiKbTopic } from './intents';
import {
  CERTAINTY_RULE,
  DATA_RULE,
  DISCLOSE_AUTOMATION,
  EN_PERSONA,
  GREETING_RULE,
  LANGUAGE_RULE,
  MULTI_PART_RULE,
  ONE_QUESTION_RULE,
  OUTPUT_CONTRACT,
  PERSONA_VERSION,
  PLAYBOOK_LINES,
  PRICING_RULE,
  PROHIBITIONS,
  REGISTER_RULE,
  RU_PERSONA,
  SELLING_POINTS_RULE,
  TH_PERSONA,
} from './persona';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface KbEntryInput {
  /** The stable slug, e.g. `faq.food-outside`. */
  key: string;
  topic: AiKbTopic;
  language: AiReplyLanguage;
  /** Null = both parks. */
  branch: AiBranchKey | null;
  question: string;
  body: string;
  /** A row still holding the English source is not sent (§C.1). */
  needsTranslation: boolean;
}

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
/** `core.branch.opening_hours` (`schema/tenancy.ts`): per weekday, null for a closing day. */
export type OpeningHours = Partial<Record<WeekdayKey, { open: string; close: string } | null>>;

export interface TicketPackageFact {
  name: string;
  kidWeekday: Satang;
  kidWeekend: Satang;
  adultWeekday: Satang;
  adultWeekend: Satang;
  includedAdults: number;
  overflowAdult: Satang | null;
  /**
   * SCRUM-220 playbook (owner D3): the package's prices for the customer
   * tiers beside the standard one (Thai, resident), in satang. Rendered in
   * the branch's price fact, so the model may quote them from a cited
   * source; the engine fills them from the catalogue's `tier_pricing`.
   */
  tierPrices?: readonly TierPriceFact[];
}

/** One customer tier's prices on a package (SCRUM-220 playbook). */
export interface TierPriceFact {
  /** `crm.tier.code`, e.g. `thai`, `expat`. */
  tierCode: string;
  kidWeekday: Satang;
  kidWeekend: Satang;
  adultWeekday: Satang;
  adultWeekend: Satang;
}

export interface BranchFacts {
  key: AiBranchKey;
  name: string;
  address: string | null;
  /** Null = nobody has said yet; rendered as unknown, never as closed. */
  openingHours: OpeningHours | null;
  /** Active standard ticket packages (`pos.ticket_package`). */
  packages: TicketPackageFact[];
}

export const AI_EXAMPLE_VERDICTS = [
  'should_answer',
  'should_handover',
  'should_stay_silent',
] as const;
export type AiExampleVerdict = (typeof AI_EXAMPLE_VERDICTS)[number];

export interface ExampleInput {
  intent: AiIntent;
  language: AiReplyLanguage;
  /** De-identified by the approver (§D.5). */
  customerText: string;
  goodReply: string;
  verdict: AiExampleVerdict;
}

export interface KnowledgeInput {
  kb: readonly KbEntryInput[];
  branches: readonly BranchFacts[];
  /** Approved examples, newest first per intent and language (§E). At most 30 are used. */
  examples: readonly ExampleInput[];
}

export type EpisodeAuthor = 'customer' | 'ai' | 'staff' | 'system';

export interface EpisodeMessage {
  from: EpisodeAuthor;
  at: Date;
  /** Null for a message with no text (a voice note, an image, a sticker). */
  text: string | null;
}

export interface TurnContext {
  now: Date;
  /** The thread's branch, if it has one. */
  threadBranch: AiBranchKey | null;
  /** Today's price mode per branch (weekend detection + `branch_holiday`, computed by the caller). */
  priceModeToday: Partial<Record<AiBranchKey, 'weekday' | 'weekend'>>;
  /**
   * SCRUM-220 playbook: the calling code of the contact's phone (`66`
   * Thailand, `7` Russia), without the plus, when it is known. Rendered in
   * the context line (null when unknown): it decides the one language offer
   * ("Languages"). A Thai number is a hint of residency, never proof.
   */
  contactCountryCode?: string | null;
  /** What the AI already did this episode. */
  earlier: {
    answered: number;
    brochureSent: boolean;
    branchAsked: boolean;
    identityAnswered: boolean;
    /** SCRUM-220 playbook: the one language offer was already made (the engine records it from the verdict). */
    languageOffered?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const EPISODE_MAX_MESSAGES = 20;
export const EPISODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_EXAMPLES = 30;
/** §C.4: the system prompt is refused at 40k tokens; the turn goes silent with KB_TOO_LARGE. */
export const SYSTEM_TOKEN_LIMIT = 40_000;
const ZONE = 'Asia/Bangkok';

/**
 * A conservative token estimate with no network call: UTF-8 bytes / 3. It
 * over-counts English (about 4 bytes a token) and is near one token per
 * character for Thai (3 bytes a character), the token-heavy case §B.7 warns
 * of. Over-counting only refuses early, which is the safe side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

// ---------------------------------------------------------------------------
// Block 1: static
// ---------------------------------------------------------------------------

/** One line per intent for the model; the action column is read from INTENT_TABLE. */
const INTENT_MEANING: Readonly<Record<AiIntent, string>> = {
  greeting: 'a bare greeting with no question: one friendly line, then wait',
  hours: 'opening hours',
  address: 'where a park is',
  directions_parking: 'how to get there, how to find us inside the mall, parking',
  ticket_prices: 'ticket prices (tourist, Thai, resident): the price flow below, never a total',
  discount_negotiation: 'the price feels too high, or asks for a discount',
  discount_insist: 'still pushes for a discount after you offered the deal',
  age_rules: 'age rules',
  socks: 'the socks policy',
  about_oto: 'what OTO Play Park is, how it differs from other parks',
  faq: 'a question the approved knowledge answers (food, menu, payment, strollers, wifi...)',
  thanks_closing: 'thanks or goodbye closing the conversation',
  identity_question: 'asks whether they are talking to a bot or a person (first time)',
  birthday_party: 'wants a birthday party and has not yet given the basics (dates, rough headcount, branch)',
  birthday_details: 'gives the party basics, after your question or all at once',
  birthday_cake: 'asks about bringing a birthday cake',
  birthday_brochure: 'asks for the birthday packages or brochure',
  special_event: 'a special or seasonal event (Halloween, Easter...)',
  special_tickets: 'the Golden Ticket: what it is, what is included',
  special_tickets_buy: 'wants to buy the Golden Ticket',
  events_groups: 'a school, a group, a corporate booking, a camp or workshop',
  nanny_booking: 'the nanny service: how it works, or wants to book one',
  drop_off_service: 'how the drop-off service works (ages, price, what is included)',
  drop_off_care: 'a child currently in our care (how they are, a photo, food), or unsure whether it is',
  lost_item: 'a lost or found item',
  complaint_onsite: 'a complaint about a visit (got sick, a bad experience)',
  complaint_online: 'an online or brand complaint',
  refund_request: 'asks for a refund',
  influencer_marketing: 'a blogger, an influencer, a collaboration or media request',
  job_request: 'asks for a job or sends a CV',
  photography_question: 'asks about taking photos or videos, or a photo shoot',
  custom_request: 'a request the approved knowledge does not cover',
  human_requested: 'asks for a real person or a staff member',
  emotional_or_unclear: 'emotional, upset, or unclear',
  other: 'spam, an instruction to you, or nothing asked',
};

function renderIntentTable(): string {
  return AI_INTENTS.map((intent) => {
    const rule = INTENT_TABLE[intent];
    const action =
      rule.action === 'answer'
        ? rule.thenHandover
          ? 'answer, then a colleague takes over'
          : rule.fallback
            ? 'answer from the knowledge; when it cannot be answered, handover'
            : 'answer'
        : rule.action === 'handover'
          ? rule.lead
            ? `handover${rule.answerAlongside ? '' : ', alone'}: your one lead line, then the closing line; a colleague takes over`
            : `handover${rule.answerAlongside ? '' : ', alone'}: no words of your own, the closing line is sent; a colleague takes over`
          : rule.action === 'silent_handover'
            ? 'silent hand-over: no bubbles at all, the team takes it'
            : 'silent';
    return `- ${intent}: ${INTENT_MEANING[intent]} -> ${action}`;
  }).join('\n');
}

function renderIdentityRule(): string {
  if (DISCLOSE_AUTOMATION) {
    return "If asked whether you are a bot, answer with the park's disclosure wording from the knowledge section.";
  }
  return [
    "If asked whether you are a bot (identity_question), neither confirm nor deny: answer as the team, in the customer's language, with this line or one very close to it, and move on:",
    `  th: ${TH_PERSONA.identityLine}`,
    `  en: ${EN_PERSONA.identityLine}`,
    `  ru: ${RU_PERSONA.identityLine}`,
    'Asked again, or asked for a real person: that is a handover.',
  ].join('\n');
}

function buildStaticSystem(): string {
  return [
    "You write the replies of the OTO Play Park chat desk: an indoor children's play park in Phuket with two parks, Central Floresta and Robinson Chalong. You answer customers on WhatsApp, Instagram and Facebook.",
    "The park's playbook is your first rule: where any example or older habit disagrees with the rules below, the rules below win.",
    '',
    '## Voice',
    REGISTER_RULE,
    GREETING_RULE,
    ONE_QUESTION_RULE,
    TH_PERSONA.voice,
    EN_PERSONA.voice,
    RU_PERSONA.voice,
    '',
    '## Languages',
    LANGUAGE_RULE,
    '',
    '## Never',
    ...PROHIBITIONS.map((p) => `- ${p.text}`),
    '',
    '## Who you are',
    renderIdentityRule(),
    '',
    '## Intents and what each may do',
    renderIntentTable(),
    '',
    '## Playbook lines',
    PLAYBOOK_LINES,
    '',
    '## Prices',
    PRICING_RULE,
    '',
    '## Selling points',
    SELLING_POINTS_RULE,
    '',
    '## The park question',
    'For a general enquiry, when the thread has no branch, the one question may ask which park (the price question above is its own), e.g.:',
    `  th: ${TH_PERSONA.branchQuestion}`,
    `  en: ${EN_PERSONA.branchQuestion}`,
    `  ru: ${RU_PERSONA.branchQuestion}`,
    'Never add the park question to a birthday: the birthday question asks the branch itself.',
    '',
    '## Several questions at once',
    MULTI_PART_RULE,
    '',
    '## Certainty',
    CERTAINTY_RULE,
    '',
    '## The conversation',
    DATA_RULE,
    '',
    '## Output',
    OUTPUT_CONTRACT,
    `reason words: ${AI_REASON_CODES.join(', ')}`,
  ].join('\n');
}

/** Block 1, computed once at module load: identical bytes on every call (cache stability). */
export const STATIC_SYSTEM_TEXT: string = buildStaticSystem();

// ---------------------------------------------------------------------------
// Block 2: knowledge
// ---------------------------------------------------------------------------

export interface KnowledgeBlock {
  text: string;
  /** Short hash of `text`: the turn row's `kb_version`. */
  version: string;
  /** Every citable source, by the key the model cites. */
  grounding: ReadonlyMap<string, GroundingSource>;
}

const DAY_LABEL: Readonly<Record<WeekdayKey, string>> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

function renderHours(hours: OpeningHours | null): string {
  if (hours === null) return 'not set (do not state hours for this park)';
  const parts = WEEKDAY_KEYS.map((d) => {
    const h = hours[d];
    return h ? `${h.open}–${h.close}` : 'closed';
  });
  if (parts.every((p) => p === parts[0]))
    return parts[0] === 'closed' ? 'closed' : `every day ${parts[0]}`;
  return WEEKDAY_KEYS.map((d, i) => `${DAY_LABEL[d]} ${parts[i]}`).join(', ');
}

/**
 * A tier's name as the price fact says it. `expat` is the playbook's
 * resident tier; its prices are a discount, and the fact says so, so the
 * playbook's "Residents get a discount at Central" rests on a cited source.
 */
function tierLabel(code: string): string {
  if (code === 'thai') return 'Thai price';
  if (code === 'expat' || code === 'resident') return 'resident discount price (residents and expats)';
  return `${code} price`;
}

/** A tier's "starts from" phrase. */
function tierFromLabel(code: string): string {
  if (code === 'thai') return 'Thai prices';
  if (code === 'expat' || code === 'resident') return 'resident discount prices';
  return `${code} prices`;
}

/** An adult price; nothing to pay reads as "free" (the Thai first parent at Central). */
const adultPrice = (satang: Satang) => (satang === 0 ? 'free' : formatTHB(satang));

function renderPackage(p: TicketPackageFact): string {
  const adults =
    p.includedAdults > 0
      ? `includes ${p.includedAdults} adult${p.includedAdults === 1 ? '' : 's'} per child ticket` +
        (p.overflowAdult === null ? '' : `, each further adult ${formatTHB(p.overflowAdult)}`)
      : `adult weekday ${formatTHB(p.adultWeekday)}, adult weekend ${formatTHB(p.adultWeekend)}`;
  const tiers = (p.tierPrices ?? []).map(
    (t) =>
      `; ${tierLabel(t.tierCode)}: child weekday ${formatTHB(t.kidWeekday)}, child weekend ${formatTHB(t.kidWeekend)}, ` +
      `adult weekday ${adultPrice(t.adultWeekday)}, adult weekend ${adultPrice(t.adultWeekend)}`,
  );
  return `${p.name}: child weekday ${formatTHB(p.kidWeekday)}, child weekend ${formatTHB(p.kidWeekend)}; ${adults}${tiers.join('')}`;
}

/**
 * The playbook's "Prices start from" (the weekday 1-hour ticket), read from
 * the catalogue, never hard-coded: the lowest weekday child price per tier,
 * over the packages that charge one. A choice of the lowest, not arithmetic
 * on a price.
 */
function renderStartsFrom(packages: readonly TicketPackageFact[]): string {
  const lowest = (prices: number[]) => (prices.length === 0 ? null : Math.min(...prices));
  const standard = lowest(packages.map((p) => p.kidWeekday).filter((v) => v > 0));
  if (standard === null) return '';
  const parts = [`Prices start from ${formatTHB(standard)} per child (the lowest weekday child price)`];
  const codes: string[] = [];
  for (const p of packages) for (const t of p.tierPrices ?? []) if (!codes.includes(t.tierCode)) codes.push(t.tierCode);
  for (const code of codes) {
    const from = lowest(
      packages.flatMap((p) => (p.tierPrices ?? []).filter((t) => t.tierCode === code).map((t) => t.kidWeekday)).filter((v) => v > 0),
    );
    if (from !== null) parts.push(`${tierFromLabel(code)} start from ${formatTHB(from)}`);
  }
  return `. ${parts.join('; ')}.`;
}

/** Deterministic order whatever order the database returned rows in. */
function compareKb(a: KbEntryInput, b: KbEntryInput): number {
  const topic = AI_KB_TOPICS.indexOf(a.topic) - AI_KB_TOPICS.indexOf(b.topic);
  if (topic !== 0) return topic;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  const ab = a.branch ?? '';
  const bb = b.branch ?? '';
  if (ab !== bb) return ab < bb ? -1 : 1;
  return a.language < b.language ? -1 : a.language > b.language ? 1 : 0;
}

/**
 * The id the model cites for a KB row. A row for one park is cited as
 * `key@branch`, so a Chalong fact never grounds a Central answer.
 */
export function kbCitation(entry: Pick<KbEntryInput, 'key' | 'branch'>): string {
  return entry.branch === null ? entry.key : `${entry.key}@${entry.branch}`;
}

export function buildKnowledge(input: KnowledgeInput): KnowledgeBlock {
  const grounding = new Map<string, GroundingSource>();
  const lines: string[] = [
    '# Park knowledge (cite the [key] of each source you use)',
    '',
    '## Live facts',
  ];

  const branches = [...input.branches].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const b of branches) {
    const facts: Array<[string, GroundingSource['topic'], string]> = [
      [`fact.hours.${b.key}`, 'hours', `${b.name} opening hours: ${renderHours(b.openingHours)}`],
      [
        `fact.address.${b.key}`,
        'address',
        `${b.name} address: ${b.address ?? 'not set (do not state it)'}`,
      ],
      [
        `fact.prices.${b.key}`,
        'prices',
        b.packages.length === 0
          ? `${b.name} standard ticket prices: not set (do not state prices)`
          : `${b.name} standard ticket prices (weekday = Mon–Fri; weekend = Sat, Sun and park holidays): ` +
            b.packages.map(renderPackage).join(' | ') +
            renderStartsFrom(b.packages),
      ],
    ];
    for (const [key, topic, text] of facts) {
      grounding.set(key, { key, topic, text });
      lines.push(`[${key}] ${text}`);
    }
  }

  lines.push('', '## Approved answers');
  const usable = input.kb.filter((e) => !e.needsTranslation).sort(compareKb);
  for (const e of usable) {
    const key = kbCitation(e);
    const text = `Q: ${e.question}\nA: ${e.body}`;
    const prior = grounding.get(key);
    // The same key in several languages is one source: its rows say the same thing.
    grounding.set(key, { key, topic: e.topic, text: prior ? `${prior.text}\n${text}` : text });
    lines.push(`[${key}] (${e.topic}, ${e.language}) Q: ${e.question}`, `A: ${e.body}`);
  }

  lines.push(
    '',
    '## Examples of good decisions (style and boundaries only; never a source of facts)',
  );
  for (const ex of input.examples.slice(0, MAX_EXAMPLES)) {
    lines.push(
      `- ${ex.intent} (${ex.language}, ${ex.verdict}) customer: ${JSON.stringify(ex.customerText)} reply: ${JSON.stringify(ex.goodReply)}`,
    );
  }

  const text = lines.join('\n');
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { text, version, grounding };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl: '1h' };
}

export interface BuiltPrompt {
  system: [SystemBlock, SystemBlock];
  messages: [{ role: 'user'; content: string }];
  personaVersion: string;
  kbVersion: string;
  grounding: ReadonlyMap<string, GroundingSource>;
  /** Estimated tokens of the two system blocks. */
  systemTokens: number;
}

export type PromptResult =
  { ok: true; prompt: BuiltPrompt } | { ok: false; reason: 'KB_TOO_LARGE'; systemTokens: number };

const HOUR_MINUTE = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  numberingSystem: 'latn',
});
const WEEKDAY_NAME = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long' });

/** "2026-10-20 14:05" in Bangkok time. */
export function bangkokStamp(at: Date): string {
  let hour = '00';
  let minute = '00';
  for (const p of HOUR_MINUTE.formatToParts(at)) {
    if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  return `${isoDateInTz(at, ZONE)} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** JSON with `<`, `>` and `&` escaped, so customer text can never close the data tags. */
export function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** The current episode, oldest first: at most 20 messages, none older than 24 hours. */
export function selectEpisode(messages: readonly EpisodeMessage[], now: Date): EpisodeMessage[] {
  const floor = now.getTime() - EPISODE_MAX_AGE_MS;
  return [...messages]
    .filter((m) => m.at.getTime() >= floor && m.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-EPISODE_MAX_MESSAGES);
}

function buildUserTurn(episode: readonly EpisodeMessage[], context: TurnContext): string {
  const ctx = {
    now: `${bangkokStamp(context.now)} (${WEEKDAY_NAME.format(context.now)}, Bangkok)`,
    threadBranch: context.threadBranch,
    priceModeToday: context.priceModeToday,
    // SCRUM-220 playbook: the one language offer reads it ("Languages").
    contactCountryCode: context.contactCountryCode ?? null,
    earlierThisEpisode: context.earlier,
  };
  const lines = selectEpisode(episode, context.now).map((m) =>
    inertJson(
      m.text === null
        ? { from: m.from, at: bangkokStamp(m.at), text: null, noText: true }
        : { from: m.from, at: bangkokStamp(m.at), text: m.text },
    ),
  );
  return [
    '<context>',
    inertJson(ctx),
    '</context>',
    '<conversation>',
    ...lines,
    '</conversation>',
    'Decide this turn.',
  ].join('\n');
}

export interface PromptInput {
  knowledge: KnowledgeBlock;
  episode: readonly EpisodeMessage[];
  context: TurnContext;
}

export function buildPrompt(input: PromptInput): PromptResult {
  const systemTokens = estimateTokens(STATIC_SYSTEM_TEXT) + estimateTokens(input.knowledge.text);
  if (systemTokens > SYSTEM_TOKEN_LIMIT) return { ok: false, reason: 'KB_TOO_LARGE', systemTokens };
  return {
    ok: true,
    prompt: {
      system: [
        { type: 'text', text: STATIC_SYSTEM_TEXT },
        {
          type: 'text',
          text: input.knowledge.text,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: buildUserTurn(input.episode, input.context) }],
      personaVersion: PERSONA_VERSION,
      kbVersion: input.knowledge.version,
      grounding: input.knowledge.grounding,
      systemTokens,
    },
  };
}
