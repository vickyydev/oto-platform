import { z } from "zod";
import { sameKitchenDishNames } from "@shared/kitchenAdults";
import { DEFAULT_AI_MODEL, resolveAiModel, stripJsonFences, type AiCompleteOptions } from "./anthropic";

/**
 * THE APP'S TWO AI HELPERS (SCRUM-660): the BEO editor's AI Fill
 * (`POST /api/ai/parse-beo`) and the Events page's AI Event Assistant
 * (`POST /api/ai/extract-event`).
 *
 * Both read five per-park-group settings. Those rows only ever came from the
 * old full seed, which staging no longer runs, so both helpers answered with
 * "missing setting". Each setting now has a built-in default here, used
 * whenever the park group has no saved value: a saved value still wins, and a
 * saved model that is not a model this provider serves falls back to the
 * app's default model (`resolveAiModel`, and once more on a "model not found").
 *
 * The model's answer is validated before it reaches a screen: an answer that
 * is not the shape the form needs is a plain message a person can act on,
 * never a crash and never half applied. Nothing here logs the customer's
 * message, the prompt or the answer; the routes log sizes and the outcome.
 */

// --- The settings and their built-in defaults ---------------------------------------

export const AI_SETTING_KEYS = {
  model: "ai_event_extraction_model",
  eventAdvice: "ai_event_extraction_advice",
  eventOutputFormat: "ai_event_extraction_output_format",
  beoAdvice: "ai_beo_parsing_advice",
  beoOutputFormat: "ai_beo_parsing_output_format",
} as const;

export const BUILT_IN_EVENT_EXTRACTION_ADVICE = `You extract structured event data from notes about a booking at a children's indoor play park.

The notes may be written in Thai, English or Russian, or mix them, and may contain casual wording, abbreviations or emojis. Ignore emojis and decorative symbols.

Extraction rules:
- Do not invent or guess information that is not explicitly written in the notes
- Do not estimate timing, calculate totals, or round numbers
- If the same information appears more than once, use the latest confirmed version
- Keep exact dates, times, and numbers as stated; write a Buddhist-era year (2569) as its Common Era year (2026)
- Keep the notes' own wording and language in every free-text field (names, programme, cake, requests, notes). Do not translate.

Branch selection:
The available branches are listed at the end of this prompt, each with their current local date, time, and timezone. If the notes mention a location or branch name that matches one of them, include a "suggested_branch_id" key at the top level of your JSON response with the matching branch id. Use the local date and time of the matched branch to resolve any relative date expressions (e.g. "next Saturday", "this weekend"). If no branch is mentioned or the location is ambiguous, omit "suggested_branch_id" entirely.`;

/** The output format the old full seed held, unchanged: the Events form reads these keys. */
export const BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT = `Given notes about an event (like a birthday party booking), extract the following fields when present:
- title: A short title for the event
- event_type: One of "birthday", "private_event", "school_group", or "other"
- event_date: Date in YYYY-MM-DD format
- start_time: Time in HH:MM format (24-hour)
- end_time: Time in HH:MM format (24-hour) if mentioned
- child_name: Name of the birthday child or main guest
- booking_name: Name used for the booking (could be company or parent)
- parent_name: Parent/guardian name
- whatsapp_phone: Phone number (preserve format as given)
- num_children: Number of children expected
- num_adults: Number of adults expected
- program_name: Name of the program/package booked
- program_details: Additional program details
- allergies_notes: Any allergy information
- cake_notes: Cake requirements or notes. State whether the cake is external (guest-provided) or ordered/included.
- special_requests: Any special requests or requirements, including decoration notes
- internal_staff_notes: Notes for staff only
- total_value: Total event price/value in THB (integer, extract number only, do not calculate or estimate)
- prepayment_amount: Deposit or prepayment amount in THB (integer, extract number only, do not calculate or estimate)
- prepayment_date: Date deposit was paid in YYYY-MM-DD format
- prepayment_method: Payment method used (cash, bank_transfer, credit_card, promptpay, or other)

Return a JSON object with these keys:
{
  "extracted": {
    // only include fields that were found in the text
    // use null for fields that weren't mentioned
  },
  "missing_required": ["list", "of", "missing", "required", "fields"],
  "assumptions": ["list any assumptions you made"],
  "suggested_branch_id": "branch-uuid-here" // only if a matching branch was identified
}

Required fields are: event_date, start_time, child_name (for birthday), num_children`;

export const BUILT_IN_BEO_PARSING_ADVICE = `You read the final confirmation message of a birthday party at a children's indoor play park, and fill the park's BEO (Banquet Event Order) form from it. The park's team sends this message to the family; it gives the date, time, programme, food and other requests.

The message may be written in Thai, English or Russian, or mix them, and may use casual wording, abbreviations or emojis.

Parsing rules:
- Use only what the message writes. Never invent, guess or estimate a value, and never calculate a total
- Keep the message's own wording and language in every free-text field (names, menu items, activities, decoration, tasks, notes, requests). Do not translate
- Keep exact times, numbers, and names as stated. Write every time as HH:MM on the 24-hour clock (2 pm is 14:00; "14.00 น." is 14:00)
- Write a date as YYYY-MM-DD, and a Buddhist-era year (2569) as its Common Era year (2026)
- Resolve every relative or year-less date against today's date, given at the end of this prompt: the party's date without a year is its next occurrence on or after today; a deposit or payment already received is on or before today
- The party's date (event.eventDate) comes only from the new text, never from the existing event data: give it with event.eventDateText, the message's own words for that date; when the message names no date, give null for both
- If the same information appears more than once, use the latest confirmed version
- Cake mode must be one of: INTERNAL (venue provides the cake), EXTERNAL (guest brings their own cake), NONE (no cake), or NOT_SAID when the message gives a cake time or cake details but does not say who brings the cake. Never guess who brings it
- Menu items included in the package have included: true; extras have included: false, with their price when the message gives one
- The adults eat what the kids eat unless the message says otherwise: put every dish in kidsMenu and leave adultsMenu out. When the message says the adults' food differs, adultsMenu is everything the adults eat — the dishes they share with the kids included, each in the adults' own count when the message gives one — and nothing the adults do not get: "nuggets for the kids, pasta for the adults" gives adultsMenu only the pasta; "nuggets for everyone, and a cheese platter for the adults" gives adultsMenu the nuggets and the cheese platter
- Team: give a person or a role only when the message itself names them (for example "Host: Nok" or "our animator team"), written as the message writes the name itself: leave out a role word, a title or "the" before it ("Host: Nok" is "Nok", "พิธีกร พี่นก" is "พี่นก", "the Event Department" is "Event Department"). Never choose a person yourself

When existing event data is provided: only update fields that are explicitly mentioned or corrected in the new text. Carry all other fields forward from the existing data unchanged. Never invent or clear a field just because it is not mentioned in the new text.`;

export const BUILT_IN_BEO_PARSING_OUTPUT_FORMAT = `Parse the message and return a JSON object with the following structure:
{
  "summary": "One sentence summary of the event",
  "event": {
    "title": "Event title",
    "childName": "Name of the birthday child or main guest",
    "bookingName": "Name used for the booking",
    "eventDate": "YYYY-MM-DD: the party's date as this message names it; null when it names none",
    "eventDateText": "The message's own words for that date, exactly as written",
    "numChildren": 0,
    "numAdults": 0,
    "startTime": "HH:MM (24-hour)",
    "endTime": "HH:MM (24-hour)",
    "locationText": "Room or area name",
    "specialRequests": "Any special requests",
    "internalStaffNotes": "Notes for staff only",
    "activities": "Planned activities",
    "decoration": "Decoration notes"
  },
  "setupPlan": {
    "readyBy": "HH:MM time the room must be ready by",
    "responsible": "Name or role responsible for setup, as written, without a role word or \"the\" before it",
    "simplifiedTasks": [
      { "itemLabel": "Task name", "notes": "Additional notes" }
    ]
  },
  "kitchenPlan": {
    "kidsMenu": [
      { "itemName": "Item name", "quantity": 1, "notes": "", "included": true, "price": 0 }
    ],
    "adultsMenu": [
      { "itemName": "Item name", "quantity": 1, "notes": "", "included": true, "price": 0 }
    ],
    "cakeMode": "INTERNAL | EXTERNAL | NONE | NOT_SAID",
    "cakeNotes": "Cake description or notes",
    "cakeTime": "HH:MM when cake is served",
    "cakeIncluded": true,
    "cakePrice": 0,
    "cakeQuantity": 1
  },
  "partyDetails": {
    "packageName": "Package or POS name",
    "packageBasePrice": 0,
    "prepaymentReceived": 0,
    "depositDate": "YYYY-MM-DD",
    "notes": "Package notes",
    "items": [
      { "description": "Item description", "type": "included | extra", "price": 0, "notes": "" }
    ]
  },
  "timeline": [
    { "time": "HH:MM", "label": "Activity or milestone label" }
  ],
  "team": {
    "partyHost": "The party host's name or role, as written, without a role word or \"the\" before it",
    "entertainmentHost": "The entertainment host's name or role, as written, without a role word or \"the\" before it"
  }
}

Omit any top-level key entirely if no relevant information was found for it. Within objects, omit keys that have no value rather than returning null.`;

export type AiHelper = "event_extraction" | "beo_parsing";

/** Where a value came from: the park group's own saved setting, or the built-in default. */
export type AiValueSource = "setting" | "built_in";

export interface AiPrompt {
  advice: string;
  outputFormat: string;
  model: string;
  /**
   * `requiredFields`: the fields the app's code reads (`requiredFieldsBlock`)
   * ride after the output format on every run, saved format or built-in
   * (SCRUM-816).
   */
  from: { advice: AiValueSource; outputFormat: AiValueSource; model: AiValueSource; requiredFields: "appended" };
}

/** The caller's park group's setting value, or nothing when it has none. */
export type SettingReader = (key: string) => Promise<string | null | undefined>;

const saved = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? value!.trim() : null;
};

/**
 * The helper's prompt and model: each saved value where the park group has
 * one, the built-in default where it has none (or saved an empty one). A saved
 * model that is not a Claude model — the old seed held an OpenAI name — is the
 * default model.
 */
export async function resolveAiPrompt(helper: AiHelper, read: SettingReader): Promise<AiPrompt> {
  const [adviceRow, formatRow, modelRow] = await Promise.all([
    read(helper === "beo_parsing" ? AI_SETTING_KEYS.beoAdvice : AI_SETTING_KEYS.eventAdvice),
    read(helper === "beo_parsing" ? AI_SETTING_KEYS.beoOutputFormat : AI_SETTING_KEYS.eventOutputFormat),
    read(AI_SETTING_KEYS.model),
  ]);
  const advice = saved(adviceRow);
  const outputFormat = saved(formatRow);
  const storedModel = saved(modelRow);
  const model = resolveAiModel(storedModel);
  return {
    advice: advice ?? (helper === "beo_parsing" ? BUILT_IN_BEO_PARSING_ADVICE : BUILT_IN_EVENT_EXTRACTION_ADVICE),
    outputFormat:
      outputFormat ?? (helper === "beo_parsing" ? BUILT_IN_BEO_PARSING_OUTPUT_FORMAT : BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT),
    model,
    from: {
      advice: advice ? "setting" : "built_in",
      outputFormat: outputFormat ? "setting" : "built_in",
      model: storedModel && model === storedModel ? "setting" : "built_in",
      requiredFields: "appended",
    },
  };
}

// --- The fields the app's code reads (SCRUM-816) ---------------------------------------

/**
 * A park group's saved output format REPLACES the built-in one, so a field the
 * code came to read after the format was saved (SCRUM-814's party date,
 * SCRUM-815's catalogue matches) was never asked of the model there. The saved
 * setting customises the WORDING, never the SHAPE: every run's prompt names,
 * after the output format (saved or built-in), each key the code reads the
 * answer by and its format, taken from the very schema that reads it, so the
 * list cannot drift from the code.
 */
export const REQUIRED_FIELDS_HEADING = "FIELDS THE APP REQUIRES";

type AnyZod = z.ZodTypeAny;
type ZodDefLike = {
  typeName?: string;
  innerType?: AnyZod;
  schema?: AnyZod;
  checks?: Array<{ kind: string; message?: string }>;
  values?: readonly string[];
};

/** The schema under its wrappers (optional, nullable, default, preprocess, transform), and the first description met. */
function unwrapField(schema: AnyZod): { inner: AnyZod; optional: boolean; description: string | undefined } {
  let at = schema;
  let optional = false;
  let description: string | undefined;
  for (;;) {
    description ??= at.description;
    const def = at._def as ZodDefLike;
    if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable" || def.typeName === "ZodDefault") {
      optional = true;
      at = def.innerType!;
    } else if (def.typeName === "ZodEffects") {
      at = def.schema!;
    } else {
      return { inner: at, optional, description };
    }
  }
}

/** A value's format as its schema checks it. */
function formatOf(schema: AnyZod): string {
  const def = schema._def as ZodDefLike;
  switch (def.typeName) {
    case "ZodString":
      return def.checks?.find((c) => c.kind === "regex")?.message ?? "text";
    case "ZodNumber":
      return def.checks?.some((c) => c.kind === "int") ? "a whole number" : "a number";
    case "ZodBoolean":
      return "true or false";
    case "ZodEnum":
      return `one of ${(def.values ?? []).map((v) => JSON.stringify(v)).join(", ")}`;
    default:
      return "a value";
  }
}

/** One line per key the schema reads: its path in the answer and its format; a list's entries as `list[].key`. */
function fieldLines(schema: AnyZod, path: string, inEntry: boolean, out: string[]): void {
  const { inner, optional, description } = unwrapField(schema);
  const typeName = (inner._def as ZodDefLike).typeName;
  if (!description && typeName === "ZodObject") {
    for (const [key, value] of Object.entries((inner as z.AnyZodObject).shape)) {
      fieldLines(value as AnyZod, path ? `${path}.${key}` : key, inEntry, out);
    }
    return;
  }
  if (!description && typeName === "ZodArray") {
    const entry = unwrapField((inner as z.ZodArray<AnyZod>).element);
    if (!entry.description && (entry.inner._def as ZodDefLike).typeName === "ZodObject") {
      fieldLines(entry.inner, `${path}[]`, true, out);
    } else {
      out.push(`- ${path}: a list, each entry ${entry.description ?? formatOf(entry.inner)}`);
    }
    return;
  }
  out.push(`- ${path}: ${description ?? formatOf(inner)}${inEntry && !optional ? " (in every entry)" : ""}`);
}

/**
 * The block every run's system prompt carries after the output format: each
 * key of `shape` (the schema the code reads this run's answer by) with its
 * format, required in addition to whatever the format above describes.
 */
export function requiredFieldsBlock(shape: AnyZod): string {
  const lines: string[] = [];
  fieldLines(shape, "", false, lines);
  return (
    `\n\n${REQUIRED_FIELDS_HEADING}\n` +
    "The app's own code reads your answer by the keys below. They are required in addition to whatever the format above " +
    "describes: answer with exactly these key names, at these places in the JSON object and in these formats, including " +
    'any key the format above leaves out or names differently. "a[]" is a list and "a[].b" a key of each of its entries. ' +
    "A key the text does not speak to may be left out or given as null: the app reads both as nothing said.\n" +
    lines.join("\n")
  );
}

// --- Reading the model's answer ------------------------------------------------------

/** Empty, null and absent are the same: nothing said. */
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const optText = (max: number) =>
  z.preprocess(
    (v) => (blank(v) ? undefined : typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v),
    z.string().max(max).optional(),
  );

const reqText = (max: number) =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v), z.string().min(1).max(max));

/** A whole count: 12, "12". */
const optCount = z.preprocess(
  (v) => (blank(v) ? undefined : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
  z.number().int().min(0).max(100_000).optional(),
);

/** An amount in baht: 1500, "1,500", "1500฿". */
const optAmount = z.preprocess((v) => {
  if (blank(v)) return undefined;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s฿]|THB|บาท/gi, "");
    return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : v;
  }
  return v;
}, z.number().min(0).max(100_000_000).optional()).describe("an amount in baht, as a number");

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "14:00", "9:30" and "14.00" are a time; anything else is not. */
const normaliseTime = (v: unknown) => {
  if (blank(v)) return undefined;
  if (typeof v !== "string") return v;
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(v);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : v;
};
const optTime = z.preprocess(normaliseTime, z.string().regex(TIME, "a time as HH:MM on the 24-hour clock").optional());
const reqTime = z.preprocess(normaliseTime, z.string().regex(TIME, "a time as HH:MM on the 24-hour clock"));

const optDate = z.preprocess(
  (v) => (blank(v) ? undefined : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD").optional(),
);

const optBool = z.preprocess((v) => (v === null || v === undefined ? undefined : v), z.boolean().optional());

/**
 * SCRUM-814: the party's date the model read. It changes nothing by itself
 * (the review step shows it beside the booked date and a person ticks it), so
 * one that is not a real YYYY-MM-DD day is dropped, never fatal to the fill.
 */
const readPartyDay = z.preprocess((v) => {
  if (typeof v !== "string") return undefined;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}, z.string().optional()).describe(
  "a date as YYYY-MM-DD: the party's date as the new text names it, never taken from the existing event data; null when the text names no date",
);

/** A person or a role the message itself names: the review proposes a real one of the park from it. */
const namedPerson = optText(200).describe(
  // SCRUM-786: the bare name, so it can match the park's roster exactly.
  "a person or a role only as the message itself names them, their name as it writes it without a role word, a title or \"the\" before it (host, MC, พิธีกร, ведущий, аниматор); never one you choose",
);

/** A list: null is none; blank entries (null, or with every value empty) are dropped, as a person would. */
const list = <T extends z.ZodTypeAny>(item: T, max = 100) =>
  z.preprocess((v) => {
    if (v === null || v === undefined) return undefined;
    if (!Array.isArray(v)) return v;
    return v.filter(
      (entry) =>
        entry !== null &&
        entry !== undefined &&
        !(typeof entry === "object" && !Array.isArray(entry) && Object.values(entry).every(blank)),
    );
  }, z.array(item).max(max).optional());

/** An object section: null is none. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess((v) => (v === null ? undefined : v), z.object(shape).optional());

/**
 * SCRUM-829: the adults eat what the kids eat unless the message says otherwise. The advice
 * tells the model so, and the model does not always obey: told "the adults will eat the
 * same", it has answered the kids' dishes a second time as adultsMenu, in the adults'
 * headcount and noted "adults eat the same as the kids". The read holds the rule whatever
 * the model answers: an adults' list naming the kids' dishes and no other is dropped — the
 * shape the answer has when the model does obey — so the preview shows one list and the
 * editor opens with "Different for adults" off. A list naming a dish of the adults' own, or
 * leaving one of the kids' out, is kept as their own list (shared/kitchenAdults.ts).
 */
function foldAdultsMenu<T extends { kidsMenu?: unknown[]; adultsMenu?: unknown[] }>(plan: T): T {
  if (!plan.adultsMenu?.length || !sameKitchenDishNames(plan.kidsMenu, plan.adultsMenu)) return plan;
  const folded = { ...plan };
  delete folded.adultsMenu;
  return folded;
}

const MenuLineSchema = z.object({
  itemName: reqText(300),
  quantity: z.preprocess((v) => (blank(v) ? 1 : v), optCount).transform((n) => (n && n > 0 ? n : 1)),
  notes: optText(1000),
  included: optBool,
  price: optAmount,
});

const PackageItemSchema = z.object({
  description: reqText(500),
  type: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(["included", "extra"]).optional(),
  ),
  price: optAmount,
  notes: optText(1000),
});

/** The BEO editor's AI Fill: what the preview shows and Load into Editor applies. */
export const BeoFillSchema = z.object({
  summary: optText(600),
  event: section({
    title: optText(300),
    childName: optText(200),
    bookingName: optText(200),
    eventDate: readPartyDay,
    eventDateText: optText(300).describe("the new text's own words for that date, exactly as written; null when it names none"),
    numChildren: optCount,
    numAdults: optCount,
    startTime: optTime,
    endTime: optTime,
    locationText: optText(300),
    specialRequests: optText(4000),
    internalStaffNotes: optText(4000),
    activities: optText(4000),
    decoration: optText(4000),
  }),
  setupPlan: section({
    readyBy: optTime,
    responsible: namedPerson,
    simplifiedTasks: list(z.object({ itemLabel: reqText(300), notes: optText(1000) })),
  }),
  kitchenPlan: z.preprocess(
    (v) => (v === null ? undefined : v),
    z
      .object({
        kidsMenu: list(MenuLineSchema),
        // SCRUM-829: everything the adults eat, only when the message says their food differs from
        // the kids' (the rule is in the advice; a list is not described here, so the required-fields
        // block keeps naming each entry's keys). The editor opens it as the adults' own list.
        adultsMenu: list(MenuLineSchema),
        // SCRUM-787: NOT_SAID is a cake the message times or describes without saying who brings it;
        // the form's cake type is then left as it was, never guessed.
        cakeMode: z.preprocess(
          (v) => (blank(v) ? undefined : typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : v),
          z.enum(["INTERNAL", "EXTERNAL", "NONE", "NOT_SAID"]).optional(),
        ),
        cakeNotes: optText(1000),
        cakeTime: optTime,
        cakeIncluded: optBool,
        cakePrice: optAmount,
        cakeQuantity: optCount,
      })
      .transform(foldAdultsMenu)
      .optional(),
  ),
  partyDetails: section({
    packageName: optText(300),
    packageBasePrice: optAmount,
    prepaymentReceived: optAmount,
    depositDate: optDate,
    notes: optText(4000),
    items: list(PackageItemSchema),
  }),
  timeline: list(z.object({ time: reqTime, label: reqText(300) })),
  team: section({
    partyHost: namedPerson,
    entertainmentHost: namedPerson,
  }),
});
export type BeoFill = z.infer<typeof BeoFillSchema>;

/**
 * SCRUM-660 — Create BEO's AI Fill on the inbox confirmation, and the form's
 * "Final Message to Parent" (`event.internalStaffNotes`, "Paste the final
 * message sent to the parent..."). While the form holds none, it is the
 * message that was read, word for word, whatever the model wrote for it.
 * Once a person has put one there it stays theirs: the model's text for that
 * field is dropped, because the review step does not show it and Load into
 * Editor would replace the field with it.
 */
export function inboxFillAnswer(
  fill: BeoFill,
  messageBody: string,
  existingData: unknown,
): { fill: BeoFill; fillsFinalMessage: boolean } {
  const formEvent =
    existingData && typeof existingData === "object" ? (existingData as Record<string, unknown>).event : undefined;
  const existingFinal =
    formEvent && typeof formEvent === "object" ? (formEvent as Record<string, unknown>).internalStaffNotes : undefined;
  const fillsFinalMessage = typeof existingFinal !== "string" || existingFinal.trim() === "";
  const event = { ...(fill.event ?? {}) };
  delete event.internalStaffNotes;
  if (fillsFinalMessage) return { fill: { ...fill, event: { ...event, internalStaffNotes: messageBody } }, fillsFinalMessage };
  const kept: BeoFill = { ...fill, event };
  if (Object.keys(event).length === 0) delete kept.event;
  return { fill: kept, fillsFinalMessage };
}

const EVENT_TYPES = ["birthday", "private_event", "school_group", "other"] as const;

/** The AI Event Assistant: the Events form's keys (`client/src/components/ai-event-assistant.tsx`). */
export const EventExtractionSchema = z.object({
  extracted: z.preprocess(
    (v) => (v === null || v === undefined ? {} : v),
    z.object({
      title: optText(300),
      event_type: z.preprocess(
        (v) => (blank(v) ? undefined : typeof v === "string" ? v.trim().toLowerCase() : v),
        z.enum(EVENT_TYPES).optional(),
      ),
      event_date: optDate,
      start_time: optTime,
      end_time: optTime,
      child_name: optText(200),
      booking_name: optText(200),
      parent_name: optText(200),
      whatsapp_phone: optText(60),
      num_children: optCount,
      num_adults: optCount,
      program_name: optText(300),
      program_details: optText(4000),
      allergies_notes: optText(4000),
      cake_notes: optText(4000),
      special_requests: optText(4000),
      internal_staff_notes: optText(4000),
      total_value: optAmount,
      prepayment_amount: optAmount,
      prepayment_date: optDate,
      prepayment_method: optText(60),
    }),
  ),
  missing_required: list(z.string().max(100), 40),
  assumptions: list(z.string().max(1000), 40),
  suggested_branch_id: optText(100).describe(
    "the id of one of the branches listed at the end of this prompt, only when the notes name that branch",
  ),
});
export type EventExtraction = z.infer<typeof EventExtractionSchema>;

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/**
 * The answer as the schema reads it, or why it cannot be read. The issues name
 * paths and rules only, never a value, so they can be logged.
 */
export function readModelAnswer<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): ReadOutcome<T> {
  const stripped = stripJsonFences(text ?? "");
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    // A sentence before or after the object: the object alone, once.
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, issues: ["not JSON"] };
    try {
      raw = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return { ok: false, issues: ["not JSON"] };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: ["not a JSON object"] };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
    };
  }
  return { ok: true, value: parsed.data };
}

// --- Running a helper ------------------------------------------------------------------

export type AiFailReason = "not_configured" | "quota" | "model_error" | "unreadable";

export const AI_FILL_MESSAGES: Record<AiFailReason, string> = {
  not_configured: "AI is not available on this server. Ask the system administrator.",
  quota: "AI service quota exceeded. Please try again later.",
  model_error: "The AI service did not answer, so nothing was filled in. Try again in a moment, or fill the form by hand.",
  unreadable: "The AI's answer could not be read, so nothing was filled in. Try again, or fill the form by hand.",
};

const STATUS: Record<AiFailReason, number> = { not_configured: 503, quota: 429, model_error: 502, unreadable: 502 };

export interface AiDeps {
  /** Whether this server holds an AI key at all. */
  configured: () => boolean;
  /** One system+user round trip returning the answer text (`aiComplete`). */
  complete: (opts: AiCompleteOptions) => Promise<string>;
  /** The caller's park group's setting. */
  readSetting: SettingReader;
}

/** What a run tells the log and the activity row: sizes, sources and the outcome; never the text. */
export interface AiRunFacts {
  helper: AiHelper;
  model: string | null;
  from: AiPrompt["from"] | null;
  inputChars: number;
  answerChars: number;
  outcome: "filled" | AiFailReason;
  issues: string[];
}

export type AiRun<T> =
  | { ok: true; value: T; facts: AiRunFacts }
  | { ok: false; status: number; reason: AiFailReason; message: string; facts: AiRunFacts };

const errorStatus = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
};

function failureOf(error: unknown): AiFailReason {
  const status = errorStatus(error);
  const message = (error as { message?: unknown } | null)?.message;
  if (status === 401 || status === 403 || (typeof message === "string" && message.includes("API key"))) return "not_configured";
  if (status === 429 || (error as { code?: unknown } | null)?.code === "insufficient_quota") return "quota";
  return "model_error";
}

/**
 * One helper run: the prompt (saved settings, else the built-in defaults), the
 * model (with one retry on the default model when a saved one is not found),
 * and the answer read through `schema`. Never throws for a model problem.
 */
export async function runAiHelper<T>(
  deps: AiDeps,
  input: {
    helper: AiHelper;
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    /**
     * The shape the app's code reads this run's answer by, named after the output
     * format whatever a saved format says (SCRUM-816): the helper's own schema
     * (`BeoFillSchema`, `EventExtractionSchema`) when not given.
     */
    requiredShape?: z.ZodTypeAny;
    /** Appended to the system prompt after the advice, the output format and the required fields (the branch list). */
    systemExtra?: string;
    user: string;
    inputChars: number;
  },
): Promise<AiRun<T>> {
  const facts: AiRunFacts = {
    helper: input.helper,
    model: null,
    from: null,
    inputChars: input.inputChars,
    answerChars: 0,
    outcome: "not_configured",
    issues: [],
  };
  const fail = (reason: AiFailReason): AiRun<T> => {
    facts.outcome = reason;
    return { ok: false, status: STATUS[reason], reason, message: AI_FILL_MESSAGES[reason], facts };
  };
  if (!deps.configured()) return fail("not_configured");

  const prompt = await resolveAiPrompt(input.helper, deps.readSetting);
  facts.from = prompt.from;
  // SCRUM-816: a saved format words the answer; the keys the code reads ride after it regardless.
  const requiredShape = input.requiredShape ?? (input.helper === "beo_parsing" ? BeoFillSchema : EventExtractionSchema);
  const system =
    prompt.advice +
    "\n\n" +
    prompt.outputFormat +
    requiredFieldsBlock(requiredShape) +
    (input.systemExtra ?? "") +
    "\n\nReturn ONLY a valid JSON object, with no markdown fences or commentary.";

  // No temperature: the app's default model takes none, and the answer is read
  // by the schema, not trusted for its sampling.
  const ask = (model: string) =>
    deps.complete({ model, system, user: input.user, maxTokens: 16_000 });

  let answer: string;
  facts.model = prompt.model;
  try {
    answer = await ask(prompt.model);
  } catch (error) {
    if (errorStatus(error) === 404 && prompt.model !== DEFAULT_AI_MODEL) {
      // A saved model this provider does not serve (retired, misspelt): the default.
      facts.model = DEFAULT_AI_MODEL;
      facts.from = { ...prompt.from, model: "built_in" };
      try {
        answer = await ask(DEFAULT_AI_MODEL);
      } catch (retryError) {
        return fail(failureOf(retryError));
      }
    } else {
      return fail(failureOf(error));
    }
  }

  facts.answerChars = answer?.length ?? 0;
  if (!answer || !answer.trim()) return fail("unreadable");
  const read = readModelAnswer(answer, input.schema);
  if (!read.ok) {
    facts.issues = read.issues;
    return fail("unreadable");
  }
  facts.outcome = "filled";
  return { ok: true, value: read.value, facts };
}

/** The log line of a run: sizes, sources and outcome. */
export function runLogFields(facts: AiRunFacts): Record<string, unknown> {
  return {
    helper: facts.helper,
    model: facts.model,
    adviceFrom: facts.from?.advice ?? null,
    outputFormatFrom: facts.from?.outputFormat ?? null,
    modelFrom: facts.from?.model ?? null,
    requiredFields: facts.from?.requiredFields ?? null,
    inputChars: facts.inputChars,
    answerChars: facts.answerChars,
    outcome: facts.outcome,
    issues: facts.issues,
  };
}

/** The user message of a BEO parse: the existing data as the baseline, then the text. */
export function beoParseUserMessage(text: string, existingData: unknown): string {
  return existingData && typeof existingData === "object"
    ? `Existing event data (only update fields that are explicitly mentioned in the new text, leave everything else unchanged):
${JSON.stringify(existingData, null, 2)}

New text to parse:
${text}`
    : text;
}

/** The longest text a person may paste, or the inbox may hand over, for one run. */
export const AI_TEXT_MAX = 20_000;

// --- Today, for the BEO fill (SCRUM-814) ----------------------------------------------

/** The parks' zone, when a park names none (or an unknown one): every branch is in Bangkok today. */
export const DEFAULT_PARK_TIME_ZONE = "Asia/Bangkok";

/** The park a fill is for: its name and its zone. */
export interface ParkPlace {
  name: string | null;
  timeZone: string;
}

/** The park's own calendar day, clock and weekday at `now`, read field by field (no locale's pattern). */
export function parkClockAt(now: Date, timeZone: string): { date: string; time: string; weekday: string; timeZone: string } {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      date: `${get("year").padStart(4, "0")}-${get("month").padStart(2, "0")}-${get("day").padStart(2, "0")}`,
      time: `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`,
      weekday: get("weekday"),
      timeZone: zone,
    };
  };
  try {
    return read(timeZone);
  } catch {
    // A zone this runtime does not know: the parks' own.
    return read(DEFAULT_PARK_TIME_ZONE);
  }
}

/**
 * The line the BEO fill's system prompt ends with: the park's today, so a
 * year-less or relative date ("9 ноября", "next Saturday") is read against the
 * park's day, as the event extraction prompt reads it against each branch's.
 * Without it the model guessed the year (a deposit of "9 ноября" read as 2025).
 */
export function beoTodayLine(place: ParkPlace, now: Date): string {
  const clock = parkClockAt(now, place.timeZone);
  const where = place.name?.trim() ? place.name.trim() : "the park";
  return (
    `\n\nToday at ${where} is ${clock.date} (${clock.weekday}), ${clock.time} local time (${clock.timeZone}). ` +
    "Resolve every relative or year-less date in the message against it: the party's date without a year is its next " +
    "occurrence on or after today; a deposit or payment already received is on or before today."
  );
}
