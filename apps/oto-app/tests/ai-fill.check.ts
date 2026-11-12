// seed: none — this file talks to nothing: the model is a stub and the
// settings a map. Run it with `npx tsx tests/ai-fill.check.ts`; CI runs it
// beside the other database-free checks.
//
// SCRUM-660 — the app's two AI helpers (the BEO editor's AI Fill and the
// Events page's AI Event Assistant) work with no hand-seeded settings:
//   - each of the five settings has a built-in default used when the park
//     group has none (or saved an empty one); a saved value still wins; a
//     saved model that is not a Claude model is the app's default model, and a
//     saved Claude model the provider does not serve falls back to it once;
//   - the built-in advice names Thai, English and Russian and keeps the
//     message's own wording (no translation);
//   - the model's answer is validated: fences and a sentence around the object
//     are tidied, "14.00" is 14:00, and anything else that is not the form's
//     shape is a plain message with nothing to apply;
//   - a stubbed model reads a Thai, an English and a Russian confirmation;
//   - nothing a run reports for the log carries the message or the answer;
//   - the team a fill may propose: one real person (or department) of the
//     park by the name the message wrote, else flagged, never a guess;
//   - Create BEO's Final Message to Parent: the message read, while the
//     form's is empty; a person's own is kept and the model's text dropped.
//   - SCRUM-814: the BEO prompt ends with the park's today (date, weekday,
//     clock, zone) so a year-less or relative date reads against it; the
//     answer names the party's date and the message's words for it, a date
//     that is not a real day is dropped (never fatal), and the review line
//     shows it beside the booked date, marked when they differ.
//   - SCRUM-903: the conversation's read of a BEO fill (`retryOnce`) asks
//     once more when its answer cannot be read or the model does not answer,
//     never on a missing key or the quota, and says so in its log fields.
//   - SCRUM-816: a park group's saved output format words the answer but
//     never drops a key the code reads: every run's prompt names, after the
//     format, each key of the schema the answer is read by (the party's date,
//     the catalogue section with its ids and sources), so a format saved
//     before those keys existed still gets them asked, and the answer's date
//     still reaches the review.
//   - SCRUM-787: a cake time with no word of whose cake it is: the answer may
//     say NOT_SAID (or give no type), the preview's cake line says "not said"
//     (and, when the form's type is No Cake, what to choose to keep the time),
//     Load into Editor applies the time and notes and leaves the form's cake
//     type; the catalogue review proposes the cake with no type and the
//     approval sends none; an empty Party Details box is not shown.
//   - SCRUM-827: the rest of the BEO is proposed in the same pass, each
//     value with its source — the conversation's requests and timed steps
//     by their lines (the later line winning a repeated wish), the ruling's
//     booking name, location, setup plan and POS box as the team's, the title
//     from the app's own naming rule as the park's default, never the model's
//     own title; a value the form already holds is not proposed; the review
//     keeps what the form holds and offers the chat's beside it, sends only
//     what differs from the SAVED BEO (text typed before the review and not
//     yet saved is written as it stands), names the park's default as such
//     in the offer, and the approval body carries it with its sources.
//   - SCRUM-829: the adults eat what the kids eat unless the message says
//     otherwise, whatever the model answers: an adults' list that only names
//     the kids' dishes again (in the adults' headcount, noted "adults eat the
//     same as the kids", as the staging proof saw) is folded away by the read,
//     so the preview shows one list and the editor opens with the switch off;
//     a dish of the adults' own, or one of the kids' left out, is their own
//     list, kept as answered.
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AI_FILL_MESSAGES,
  AI_SETTING_KEYS,
  BUILT_IN_BEO_PARSING_ADVICE,
  BUILT_IN_BEO_PARSING_OUTPUT_FORMAT,
  BUILT_IN_EVENT_EXTRACTION_ADVICE,
  BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT,
  BeoFillSchema,
  EventExtractionSchema,
  REQUIRED_FIELDS_HEADING,
  beoTodayLine,
  inboxFillAnswer,
  parkClockAt,
  readModelAnswer,
  requiredFieldsBlock,
  resolveAiPrompt,
  runAiHelper,
  runLogFields,
  type AiDeps,
  type BeoFill,
} from "../server/lib/aiFill";
import { DEFAULT_AI_MODEL, type AiCompleteOptions } from "../server/lib/anthropic";
import { normaliseName, proposeTeam, type TeamCandidates } from "../server/lib/beoTeamProposals";
import {
  BEO_CATALOGUE_OUTPUT_FORMAT,
  BEO_FILL_WITH_CATALOGUE_SHAPE,
  CATALOGUE_ONLY_SHAPE,
  beoCatalogueSystemBlock,
  detailsFromFill,
  resolveCatalogueAnswer,
  type BeoCatalogue,
} from "../server/lib/beoCatalogueFill";
import { aiFillDateLine, dayLabel } from "../client/src/lib/beo-ai-date";
import { aiFillCakeApply, aiFillCakeLine, aiFillCakeNotSaidNote, aiFillPartyDetailsShown, aiReviewCakeNotSaidNote, cakeUnderNoCakeNote } from "../client/src/lib/beo-ai-preview";
import {
  NOTHING_HELD,
  approveBodyOf,
  approvedMarksOf,
  approvedSectionsOf,
  chatOffered,
  chatOfferWords,
  editedText,
  initialReviewState,
  sourceOf,
  useChatText,
} from "../client/src/lib/beo-ai-review";
import { BeoAiApproveBodySchema, beoAiSourceLabel, beoEventTitleOf } from "../shared/beoAiFill";
import { sameKitchenDishNames } from "../shared/kitchenAdults";

const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}

/** A park group's settings, as `storage.getSetting` would answer them. */
const settingsOf = (rows: Record<string, string> = {}) => async (key: string) => rows[key] ?? null;

/** A model stub: records every call, answers with `reply(call)`. */
function stubModel(reply: (call: AiCompleteOptions) => string | Promise<string>) {
  const calls: AiCompleteOptions[] = [];
  const complete = async (call: AiCompleteOptions) => {
    calls.push(call);
    return reply(call);
  };
  return { calls, complete };
}

const deps = (complete: AiDeps["complete"], rows: Record<string, string> = {}): AiDeps => ({
  configured: () => true,
  complete,
  readSetting: settingsOf(rows),
});

const beoRun = (d: AiDeps, user = "a message") =>
  runAiHelper(d, { helper: "beo_parsing", schema: BeoFillSchema, user, inputChars: user.length });

// The three confirmations a manager sends, and what a model answers to each.
const THAI = `ยืนยันงานวันเกิดน้องมะลิ วันเสาร์ที่ 21 มีนาคม 2570 เวลา 14.00-16.00 น.
เด็ก 15 คน ผู้ใหญ่ 10 คน ห้อง Jungle Room
เมนูเด็ก: นักเก็ตไก่ 15 ที่, เฟรนช์ฟรายส์ 15 ที่
เค้กนำมาเอง เป่าเค้กเวลา 15.30 น.
พิธีกร: น้องนก`;
const ENGLISH = `Confirming Emma's 6th birthday on Saturday 21 March at 14:00 to 16:00.
15 kids, 10 adults, Jungle Room. Kids menu: 15 x chicken nuggets, 15 x fries.
You bring your own cake, cake at 15:30. Your host will be Nok, with Ploy on the disco.`;
const RUSSIAN = `Подтверждаем день рождения Маши в субботу 21 марта в 14:00 до 16:00.
15 детей, 10 взрослых, Jungle Room. Детское меню: наггетсы 15 шт., картофель фри 15 шт.
Свой торт, торт в 15:30. Аниматор: Нок.`;

const ANSWERS: Record<string, unknown> = {
  th: {
    summary: "งานวันเกิดน้องมะลิ",
    event: { childName: "น้องมะลิ", numChildren: 15, numAdults: 10, startTime: "14.00", endTime: "16.00", locationText: "Jungle Room" },
    kitchenPlan: {
      kidsMenu: [
        { itemName: "นักเก็ตไก่", quantity: 15, included: true },
        { itemName: "เฟรนช์ฟรายส์", quantity: "15", included: true },
        { itemName: "", quantity: null },
      ],
      cakeMode: "external",
      cakeTime: "15.30",
    },
    team: { partyHost: "น้องนก" },
  },
  en: {
    summary: "Emma's 6th birthday",
    event: { childName: "Emma", numChildren: 15, numAdults: 10, startTime: "14:00", endTime: "16:00", locationText: "Jungle Room", specialRequests: null },
    kitchenPlan: {
      kidsMenu: [
        { itemName: "chicken nuggets", quantity: 15 },
        { itemName: "fries", quantity: 15 },
      ],
      cakeMode: "EXTERNAL",
      cakeTime: "15:30",
    },
    timeline: [{ time: "15:30", label: "Cake" }],
    team: { partyHost: "Nok", entertainmentHost: "Ploy" },
  },
  ru: {
    summary: "День рождения Маши",
    event: { childName: "Маша", numChildren: 15, numAdults: 10, startTime: "14:00", endTime: "16:00", locationText: "Jungle Room" },
    kitchenPlan: {
      kidsMenu: [
        { itemName: "наггетсы", quantity: 15 },
        { itemName: "картофель фри", quantity: 15 },
      ],
      cakeMode: "EXTERNAL",
      cakeTime: "15:30",
    },
    team: { partyHost: "Нок" },
  },
};

/** The stub reads the message the way a model would be asked it, and answers in its language. */
const languageOf = (user: string) => (/[฀-๿]/.test(user) ? "th" : /[Ѐ-ӿ]/.test(user) ? "ru" : "en");

/**
 * SCRUM-816: an output format a park group saved before SCRUM-814 and
 * SCRUM-815 (the old seed's shape, as Central Floresta's of 1 May 2026): no
 * party date, no team, no catalogue section.
 */
const SAVED_MAY_FORMAT = `Parse the BEO document and return a JSON object with the following structure:
{
  "summary": "One sentence summary of the event",
  "event": { "title": "Event title", "childName": "Name of the birthday child or main guest", "numChildren": 0, "startTime": "HH:MM (24-hour)" },
  "partyDetails": { "packageName": "Package or POS name", "prepaymentReceived": 0, "depositDate": "YYYY-MM-DD" }
}

Omit any top-level key entirely if no relevant information was found for it.`;

/** A park's catalogue of one package, as `loadBeoCatalogue` gives it (satang). */
const CATALOGUE: BeoCatalogue = {
  packages: [
    {
      id: "zz-816-floresta",
      name: "ZZ TEST Birthday package, Central Floresta",
      kidsIncluded: 10,
      adultsIncluded: 4,
      hours: 3,
      priceWeekday: 1_690_000,
      priceWeekend: 2_090_000,
      basePrice: 1_690_000,
      setMenuTemplateId: null,
      lines: [],
    },
  ],
  setMenus: [],
  entertainment: [],
  food: [],
};

/** The keys a block names, as written: `kitchenPlan.kidsMenu[].itemName`. */
const blockKeys = (block: string) =>
  block
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2, l.indexOf(": ")));

try {
  await check("builtInAdviceNamesTheThreeLanguagesAndKeepsWording", () => {
    for (const advice of [BUILT_IN_BEO_PARSING_ADVICE, BUILT_IN_EVENT_EXTRACTION_ADVICE]) {
      assert.match(advice, /Thai, English or Russian/);
      assert.match(advice, /Do not translate/);
      assert.doesNotMatch(advice, /translate all field values into English/i);
    }
    assert.match(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT, /"team"/);
    assert.match(BUILT_IN_BEO_PARSING_ADVICE, /Never choose a person yourself/);
    assert.match(BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT, /"suggested_branch_id"/);
  });

  await check("defaultsWhenNoSetting", async () => {
    for (const helper of ["beo_parsing", "event_extraction"] as const) {
      const prompt = await resolveAiPrompt(helper, settingsOf());
      assert.equal(prompt.model, DEFAULT_AI_MODEL);
      assert.deepEqual(prompt.from, { advice: "built_in", outputFormat: "built_in", model: "built_in", requiredFields: "appended" });
      assert.equal(prompt.advice, helper === "beo_parsing" ? BUILT_IN_BEO_PARSING_ADVICE : BUILT_IN_EVENT_EXTRACTION_ADVICE);
    }
    // An empty saved value is no value.
    const blank = await resolveAiPrompt("beo_parsing", settingsOf({ [AI_SETTING_KEYS.beoAdvice]: "   " }));
    assert.equal(blank.from.advice, "built_in");

    const model = stubModel((call) => JSON.stringify(ANSWERS[languageOf(call.user)]));
    const run = await beoRun(deps(model.complete), ENGLISH);
    assert.equal(run.ok, true, JSON.stringify(run.ok ? null : run.reason));
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0]!.model, DEFAULT_AI_MODEL);
    assert.ok(model.calls[0]!.system.startsWith(BUILT_IN_BEO_PARSING_ADVICE));
    assert.ok(model.calls[0]!.system.includes(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT));
    assert.equal(model.calls[0]!.temperature, undefined, "the default model takes no temperature");
    assert.equal(model.calls[0]!.maxTokens, 16_000);
  });

  await check("savedSettingWins", async () => {
    const rows = {
      [AI_SETTING_KEYS.beoAdvice]: "PARK ADVICE",
      [AI_SETTING_KEYS.beoOutputFormat]: "PARK FORMAT",
      [AI_SETTING_KEYS.model]: "claude-sonnet-4-6",
    };
    const prompt = await resolveAiPrompt("beo_parsing", settingsOf(rows));
    assert.deepEqual(prompt.from, { advice: "setting", outputFormat: "setting", model: "setting", requiredFields: "appended" });
    const model = stubModel(() => JSON.stringify(ANSWERS.en));
    const run = await beoRun(deps(model.complete, rows));
    assert.equal(run.ok, true);
    assert.equal(model.calls[0]!.model, "claude-sonnet-4-6");
    assert.ok(model.calls[0]!.system.startsWith("PARK ADVICE\n\nPARK FORMAT"));
    assert.ok(!model.calls[0]!.system.includes(BUILT_IN_BEO_PARSING_ADVICE));
    // The event helper reads its own two keys and the shared model key.
    const event = await resolveAiPrompt("event_extraction", settingsOf({ [AI_SETTING_KEYS.eventAdvice]: "EVENT ADVICE" }));
    assert.equal(event.advice, "EVENT ADVICE");
    assert.equal(event.outputFormat, BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT);
  });

  await check("savedModelNotServedFallsBack", async () => {
    // The old seed's OpenAI name is never sent to this provider.
    const openai = await resolveAiPrompt("beo_parsing", settingsOf({ [AI_SETTING_KEYS.model]: "gpt-4o-mini" }));
    assert.equal(openai.model, DEFAULT_AI_MODEL);
    assert.equal(openai.from.model, "built_in");
    // A Claude name the provider does not serve: one retry on the default model.
    const model = stubModel((call) => {
      if (call.model !== DEFAULT_AI_MODEL) throw Object.assign(new Error("model not found"), { status: 404 });
      return JSON.stringify(ANSWERS.en);
    });
    const run = await beoRun(deps(model.complete, { [AI_SETTING_KEYS.model]: "claude-retired-1" }));
    assert.equal(run.ok, true);
    assert.deepEqual(model.calls.map((c) => c.model), ["claude-retired-1", DEFAULT_AI_MODEL]);
    assert.equal(run.facts.model, DEFAULT_AI_MODEL);
    assert.equal(run.facts.from?.model, "built_in");
    // The default model itself not found is the service's problem, said plainly.
    const gone = stubModel(() => {
      throw Object.assign(new Error("model not found"), { status: 404 });
    });
    const refused = await beoRun(deps(gone.complete));
    assert.equal(refused.ok, false);
    assert.equal(gone.calls.length, 1);
    if (!refused.ok) assert.equal(refused.reason, "model_error");
  });

  await check("thaiEnglishRussianConfirmations", async () => {
    const model = stubModel((call) => JSON.stringify(ANSWERS[languageOf(call.user)]));
    const fills: Record<string, BeoFill> = {};
    for (const [lang, text] of [["th", THAI], ["en", ENGLISH], ["ru", RUSSIAN]] as const) {
      const run = await beoRun(deps(model.complete), text);
      assert.equal(run.ok, true, `${lang}: ${run.ok ? "" : run.reason}`);
      if (run.ok) fills[lang] = run.value;
      assert.ok(model.calls.at(-1)!.user.includes(text), `${lang}: the model is given the message whole`);
    }
    // Free text stays in the message's own language; times read as HH:MM.
    assert.equal(fills.th!.event?.childName, "น้องมะลิ");
    assert.deepEqual(fills.th!.kitchenPlan?.kidsMenu?.map((m) => [m.itemName, m.quantity]), [["นักเก็ตไก่", 15], ["เฟรนช์ฟรายส์", 15]]);
    assert.equal(fills.th!.event?.startTime, "14:00");
    assert.equal(fills.th!.kitchenPlan?.cakeTime, "15:30");
    assert.equal(fills.th!.kitchenPlan?.cakeMode, "EXTERNAL");
    assert.equal(fills.th!.team?.partyHost, "น้องนก");
    assert.equal(fills.en!.event?.childName, "Emma");
    assert.equal(fills.en!.event?.specialRequests, undefined, "null is nothing said");
    assert.deepEqual(fills.en!.team, { partyHost: "Nok", entertainmentHost: "Ploy" });
    assert.equal(fills.ru!.event?.childName, "Маша");
    assert.deepEqual(fills.ru!.kitchenPlan?.kidsMenu?.map((m) => m.itemName), ["наггетсы", "картофель фри"]);
    assert.equal(fills.ru!.team?.partyHost, "Нок");
  });

  await check("finalMessageToParent", () => {
    // The model wrote staff notes for the field the review step does not show.
    const answer: BeoFill = {
      summary: "Emma's 6th birthday",
      event: { childName: "Emma", internalStaffNotes: "ZZ TEST the model's own staff notes" },
      timeline: [{ time: "14:00", label: "Arrival" }],
    };
    // An empty Final Message to Parent: the message that was read, word for word, never the model's text.
    for (const form of [undefined, {}, { event: {} }, { event: { internalStaffNotes: "  " } }, { event: { internalStaffNotes: null } }]) {
      const out = inboxFillAnswer(answer, ENGLISH, form);
      assert.equal(out.fillsFinalMessage, true, JSON.stringify(form));
      assert.equal(out.fill.event?.internalStaffNotes, ENGLISH);
      assert.equal(out.fill.event?.childName, "Emma");
    }
    // A person's own Final Message to Parent: kept, and the model's text for it is dropped.
    const kept = inboxFillAnswer(answer, ENGLISH, { event: { internalStaffNotes: "A person's own note" } });
    assert.equal(kept.fillsFinalMessage, false);
    assert.equal(kept.fill.event?.internalStaffNotes, undefined, "Load into Editor finds nothing to replace it with");
    assert.ok(!("internalStaffNotes" in (kept.fill.event ?? {})));
    assert.equal(kept.fill.event?.childName, "Emma", "the rest of the event section stands");
    assert.deepEqual(kept.fill.timeline, answer.timeline, "the other sections stand");
    // A section that held only that field is no section.
    const only = inboxFillAnswer({ event: { internalStaffNotes: "notes" } }, ENGLISH, { event: { internalStaffNotes: "mine" } });
    assert.equal(only.fill.event, undefined);
    // The model's answer itself is not changed.
    assert.equal(answer.event?.internalStaffNotes, "ZZ TEST the model's own staff notes");
  });

  await check("malformedAnswerIsAPlainMessage", async () => {
    const bad: Array<[string, string]> = [
      ["prose", "Sorry, I could not find a birthday in that message."],
      ["array", "[1, 2, 3]"],
      ["cut off", '{"event": {"childName": "Emma", "numChildren": 1'],
      ["wrong type", JSON.stringify({ event: { numChildren: "twelve" } })],
      ["impossible time", JSON.stringify({ event: { startTime: "2pm" } })],
      ["section as text", JSON.stringify({ kitchenPlan: "nuggets for everyone" })],
      ["unknown cake", JSON.stringify({ kitchenPlan: { cakeMode: "MAYBE" } })],
      ["empty", "   "],
    ];
    for (const [what, answer] of bad) {
      const model = stubModel(() => answer);
      const run = await beoRun(deps(model.complete));
      assert.equal(run.ok, false, what);
      if (run.ok) continue;
      assert.equal(run.reason, "unreadable", what);
      assert.equal(run.status, 502, what);
      assert.equal(run.message, AI_FILL_MESSAGES.unreadable, what);
      assert.ok(!("value" in run), `${what}: nothing to apply`);
    }
    // What a careful person would tidy is tidied: fences, a sentence around the object.
    for (const answer of ["```json\n" + JSON.stringify(ANSWERS.en) + "\n```", "Here is the BEO:\n" + JSON.stringify(ANSWERS.en) + "\nDone."]) {
      const read = readModelAnswer(answer, BeoFillSchema);
      assert.equal(read.ok, true);
    }
    // The event helper's answer is read the same way.
    assert.equal(readModelAnswer(JSON.stringify({ extracted: { num_children: "many" } }), EventExtractionSchema).ok, false);
    const event = readModelAnswer(JSON.stringify({ extracted: { event_type: "Birthday", start_time: "9.30", total_value: "1,500" } }), EventExtractionSchema);
    assert.equal(event.ok, true);
    if (event.ok) {
      assert.equal(event.value.extracted.event_type, "birthday");
      assert.equal(event.value.extracted.start_time, "09:30");
      assert.equal(event.value.extracted.total_value, 1500);
    }
  });

  await check("modelProblemsAreSaid", async () => {
    const cases: Array<[unknown, string, number]> = [
      [Object.assign(new Error("invalid x-api-key"), { status: 401 }), "not_configured", 503],
      [Object.assign(new Error("rate limited"), { status: 429 }), "quota", 429],
      [Object.assign(new Error("overloaded"), { status: 529 }), "model_error", 502],
      [new Error("socket hang up"), "model_error", 502],
    ];
    for (const [error, reason, status] of cases) {
      const model = stubModel(() => {
        throw error;
      });
      const run = await beoRun(deps(model.complete));
      assert.equal(run.ok, false);
      if (!run.ok) {
        assert.equal(run.reason, reason);
        assert.equal(run.status, status);
        assert.equal(run.message, AI_FILL_MESSAGES[run.reason]);
      }
    }
    const model = stubModel(() => "{}");
    const off = await runAiHelper(
      { configured: () => false, complete: model.complete, readSetting: settingsOf() },
      { helper: "event_extraction", schema: EventExtractionSchema, user: "x", inputChars: 1 },
    );
    assert.equal(off.ok, false);
    if (!off.ok) assert.equal(off.reason, "not_configured");
    assert.equal(model.calls.length, 0, "no key, no call");
  });

  await check("aRunThatMayRetryAsksOnceMore", async () => {
    // SCRUM-903: the conversation's read of a BEO fill asks once more when its answer could not be
    // read or the model did not answer; never on a missing key or the quota; a run that may not, never.
    const good = JSON.stringify(ANSWERS.en);
    const replies = (...answers: Array<string | Error>) => {
      const queue = [...answers];
      return stubModel(() => {
        const next = queue.shift() ?? good;
        if (next instanceof Error) throw next;
        return next;
      });
    };
    const retrying = (d: AiDeps) =>
      runAiHelper(d, { helper: "beo_parsing", schema: BeoFillSchema, user: "a conversation", inputChars: 14, retryOnce: true });
    const unreadableOnce = replies("Sorry, no JSON here.");
    const once = await retrying(deps(unreadableOnce.complete));
    assert.equal(once.ok, true, "the second answer is read");
    assert.equal(unreadableOnce.calls.length, 2);
    assert.equal(once.facts.attempts, 2);
    assert.equal(runLogFields(once.facts).attempts, 2, "the log says it was asked twice");
    assert.equal(unreadableOnce.calls[0]!.system, unreadableOnce.calls[1]!.system, "the same prompt");
    assert.equal(unreadableOnce.calls[0]!.user, unreadableOnce.calls[1]!.user);
    const errorOnce = replies(Object.assign(new Error("overloaded"), { status: 529 }));
    assert.equal((await retrying(deps(errorOnce.complete))).ok, true, "the model did not answer once: asked again");
    assert.equal(errorOnce.calls.length, 2);
    const twice = replies("nope", "still nope");
    const failed = await retrying(deps(twice.complete));
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.reason, "unreadable");
    assert.equal(twice.calls.length, 2, "once more, never a third time");
    assert.equal(failed.facts.attempts, 2);
    for (const [error, reason] of [[Object.assign(new Error("rate limited"), { status: 429 }), "quota"], [Object.assign(new Error("invalid x-api-key"), { status: 401 }), "not_configured"]] as const) {
      const model = replies(error);
      const run = await retrying(deps(model.complete));
      assert.equal(run.ok, false);
      if (!run.ok) assert.equal(run.reason, reason);
      assert.equal(model.calls.length, 1, `${reason}: not asked again`);
    }
    const plain = replies("Sorry, no JSON here.");
    assert.equal((await beoRun(deps(plain.complete))).ok, false, "a run that may not retry stops at the first");
    assert.equal(plain.calls.length, 1);
    const firstTime = replies();
    const ok = await retrying(deps(firstTime.complete));
    assert.equal(ok.ok, true);
    assert.equal(firstTime.calls.length, 1);
    assert.equal(ok.facts.attempts, undefined, "asked once: nothing to say");
    assert.equal("attempts" in runLogFields(ok.facts), false);
  });

  await check("logFieldsCarryNoText", async () => {
    const secretAnswer = { ...(ANSWERS.en as object), summary: "ANSWER-ONLY-PHRASE" };
    const model = stubModel(() => JSON.stringify(secretAnswer));
    const message = `${ENGLISH}\nMESSAGE-ONLY-PHRASE`;
    const run = await beoRun(deps(model.complete), message);
    const fields = JSON.stringify(runLogFields(run.facts));
    for (const phrase of ["MESSAGE-ONLY-PHRASE", "ANSWER-ONLY-PHRASE", "Emma", "nuggets", BUILT_IN_BEO_PARSING_ADVICE.slice(0, 40)]) {
      assert.ok(!fields.includes(phrase), `the log line carries no "${phrase}"`);
    }
    assert.equal(run.facts.inputChars, message.length);
    assert.ok(run.facts.answerChars > 0);
    // An unreadable answer's issues name paths and rules, never the value.
    const bad = await beoRun(deps(stubModel(() => JSON.stringify({ event: { startTime: "VALUE-ONLY-PHRASE" } })).complete));
    assert.ok(!JSON.stringify(runLogFields(bad.facts)).includes("VALUE-ONLY-PHRASE"));
    assert.deepEqual(bad.facts.issues, ["event.startTime: invalid_string"]);
  });

  await check("teamProposals", () => {
    const people: TeamCandidates = {
      hostSource: "employee",
      employees: [
        { id: "e-nok", names: ["Nok", "Siriporn Sae-Lim", "น้องนก"], label: "Nok (Siriporn Sae-Lim)" },
        { id: "e-ploy", names: ["Ploy", "Ploypailin Chai"], label: "Ploy (Ploypailin Chai)" },
        { id: "e-bee1", names: ["Bee", "Bee One"], label: "Bee (Bee One)" },
        { id: "e-bee2", names: ["Bee", "Bee Two"], label: "Bee (Bee Two)" },
      ],
      departments: [{ id: "d-ent", names: ["Entertainment"], label: "Entertainment (Dept)" }],
    };
    const p = proposeTeam(
      { team: { partyHost: "Nok", entertainmentHost: "ploy" }, setupPlan: { responsible: "Entertainment team" } },
      people,
    );
    assert.deepEqual(p.partyHost, { asked: "Nok", match: { kind: "employee", id: "e-nok", label: "Nok (Siriporn Sae-Lim)" }, why: null });
    assert.equal(p.entertainmentHost?.match?.id, "e-ploy");
    assert.deepEqual(p.setupResponsible?.match, { kind: "department", id: "d-ent", label: "Entertainment (Dept)" });
    // The Thai name, and the editor's own label, name the same person.
    assert.equal(proposeTeam({ team: { partyHost: "น้องนก" } }, people).partyHost?.match?.id, "e-nok");
    assert.equal(proposeTeam({ team: { partyHost: "Nok (Siriporn Sae-Lim)" } }, people).partyHost?.match?.id, "e-nok");
    // Two people of one name: neither.
    assert.deepEqual(proposeTeam({ team: { partyHost: "Bee" } }, people).partyHost, { asked: "Bee", match: null, why: "several" });
    // Nobody of this park by that name: the name stays as written, flagged.
    assert.deepEqual(proposeTeam({ setupPlan: { responsible: "Mr. Somchai" } }, people).setupResponsible, {
      asked: "Mr. Somchai",
      match: null,
      why: "no_match",
    });
    // A role the park has no department for is no match either: no guessing at "the animator".
    assert.equal(proposeTeam({ team: { partyHost: "our animator" } }, people).partyHost?.match, null);
    // The entertainment host is never the party host.
    assert.equal(proposeTeam({ team: { partyHost: "Nok", entertainmentHost: "Nok" } }, people).entertainmentHost?.why, "same_as_party_host");
    // A park group whose host fields list users, not employees: no host proposed.
    assert.equal(proposeTeam({ team: { partyHost: "Nok" } }, { ...people, hostSource: "user" }).partyHost?.why, "host_list_not_employees");
    // Nothing named, nothing proposed.
    assert.deepEqual(proposeTeam({}, people), { partyHost: null, entertainmentHost: null, setupResponsible: null });
    assert.equal(normaliseName('  "Nok"  '), "nok");
    assert.equal(normaliseName("Kitchen Department"), "kitchen");

    // SCRUM-786: a role word, "the" or a Thai honorific before the name is not the name.
    const roster: TeamCandidates = {
      ...people,
      employees: [...people.employees, { id: "e-gm", names: ["ZZ GM", "ZZ TEST General Manager"], label: "ZZ GM (ZZ TEST General Manager)" }, { id: "e-theo", names: ["Theo"], label: "Theo" }],
      departments: [...people.departments, { id: "d-event", names: ["Event Department"], label: "Event Department (Dept)" }],
    };
    const host = (asked: string) => proposeTeam({ team: { partyHost: asked } }, roster).partyHost;
    const who = (asked: string) => proposeTeam({ setupPlan: { responsible: asked } }, roster).setupResponsible;
    assert.deepEqual(host("พิธีกร ZZ GM"), { asked: "พิธีกร ZZ GM", match: { kind: "employee", id: "e-gm", label: "ZZ GM (ZZ TEST General Manager)" }, why: null });
    assert.deepEqual(who("the Event Department")?.match, { kind: "department", id: "d-event", label: "Event Department (Dept)" });
    for (const asked of ["Host: Nok", "host Nok", "MC Nok", "the host Nok", "พิธีกร: Nok", "พิธีกรน้องนก", "คุณนก", "พี่นก", "ведущий Nok", "аниматор Nok", "Аниматор: Nok"]) {
      assert.equal(host(asked)?.match?.id, "e-nok", `${asked}: Nok`);
    }
    assert.equal(who("the Entertainment team")?.match?.id, "d-ent");
    // Only before a name: "Theo" is a name, and a role word alone names nobody.
    assert.equal(host("Theo")?.match?.id, "e-theo");
    assert.equal(normaliseName("Host"), "host");
    assert.equal(normaliseName("the"), "the");
    // Still an exact match after the clean-up: a near name, or a name in another script than the roster's, is none.
    assert.deepEqual(host("พิธีกร ZZ G"), { asked: "พิธีกร ZZ G", match: null, why: "no_match" });
    assert.deepEqual(host("ведущий Нок"), { asked: "ведущий Нок", match: null, why: "no_match" });
    assert.equal(host("the animator")?.match, null, "a role with no name is no match");
    assert.equal(normaliseName("พิธีกร พี่นก"), "นก");
  });

  await check("beoPromptKnowsTheParksToday", async () => {
    // 03:05 UTC is 10:05 on Tuesday 10 November at the park.
    const now = new Date("2026-11-10T03:05:00Z");
    assert.deepEqual(parkClockAt(now, "Asia/Bangkok"), { date: "2026-11-10", time: "10:05", weekday: "Tuesday", timeZone: "Asia/Bangkok" });
    const line = beoTodayLine({ name: "ZZ TEST Park", timeZone: "Asia/Bangkok" }, now);
    assert.ok(line.startsWith("\n\nToday at ZZ TEST Park is 2026-11-10 (Tuesday), 10:05 local time (Asia/Bangkok). "), line);
    assert.match(line, /Resolve every relative or year-less date in the message against it/);
    assert.match(line, /next occurrence on or after today/);
    assert.match(line, /deposit or payment already received is on or before today/);
    // Late evening in UTC is already the next day at the park; no park name, "the park".
    assert.match(beoTodayLine({ name: null, timeZone: "Asia/Bangkok" }, new Date("2026-11-10T20:00:00Z")), /Today at the park is 2026-11-11 \(Wednesday\), 03:00/);
    // A zone this runtime does not know is the parks' own, never a crash.
    assert.match(beoTodayLine({ name: "ZZ TEST Park", timeZone: "Not/A_Zone" }, now), /2026-11-10 \(Tuesday\), 10:05 local time \(Asia\/Bangkok\)/);
    // The run's system prompt ends with it, after the advice and the output format.
    const model = stubModel((call) => JSON.stringify(ANSWERS[languageOf(call.user)]));
    const run = await runAiHelper(deps(model.complete), {
      helper: "beo_parsing",
      schema: BeoFillSchema,
      systemExtra: line,
      user: RUSSIAN,
      inputChars: RUSSIAN.length,
    });
    assert.equal(run.ok, true);
    const system = model.calls[0]!.system;
    assert.ok(system.startsWith(BUILT_IN_BEO_PARSING_ADVICE));
    assert.ok(system.indexOf(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT) < system.indexOf("Today at ZZ TEST Park is 2026-11-10"));
    assert.match(BUILT_IN_BEO_PARSING_ADVICE, /Resolve every relative or year-less date against today's date/);
    // A park group's own saved advice still gets today: it rides after the advice and the format.
    const saved = stubModel(() => JSON.stringify(ANSWERS.ru));
    await runAiHelper(deps(saved.complete, { [AI_SETTING_KEYS.beoAdvice]: "PARK ADVICE" }), {
      helper: "beo_parsing",
      schema: BeoFillSchema,
      systemExtra: line,
      user: RUSSIAN,
      inputChars: RUSSIAN.length,
    });
    assert.ok(saved.calls[0]!.system.startsWith("PARK ADVICE") && saved.calls[0]!.system.includes("Today at ZZ TEST Park is 2026-11-10"));
  });

  await check("eventDateReadBesideTheBookedDate", () => {
    assert.match(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT, /"eventDate": "YYYY-MM-DD/);
    assert.match(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT, /"eventDateText"/);
    assert.match(BUILT_IN_BEO_PARSING_ADVICE, /never from the existing event data/);
    // A real day and the message's own words are kept.
    const read = readModelAnswer(
      JSON.stringify({ event: { childName: "Маша", eventDate: "2026-11-21", eventDateText: "21 ноября" }, partyDetails: { depositDate: "2026-11-09" } }),
      BeoFillSchema,
    );
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.event?.eventDate, "2026-11-21");
      assert.equal(read.value.event?.eventDateText, "21 ноября");
      assert.equal(read.value.partyDetails?.depositDate, "2026-11-09");
    }
    // Anything else is dropped, and the rest of the fill stands.
    for (const bad of ["21 Nov", "2026-02-31", 20261121, null, ""]) {
      const r = readModelAnswer(JSON.stringify({ event: { childName: "Маша", eventDate: bad } }), BeoFillSchema);
      assert.equal(r.ok, true, String(bad));
      if (r.ok) {
        assert.equal(r.value.event?.eventDate, undefined, String(bad));
        assert.equal(r.value.event?.childName, "Маша");
      }
    }
    // The review line: the read date beside the booked one, marked when they differ.
    assert.deepEqual(aiFillDateLine({ event: { eventDate: "2026-11-22", eventDateText: "22 ноября" } }, "2026-11-21"), {
      read: "2026-11-22",
      readText: "22 ноября",
      booked: "2026-11-21",
      differs: true,
    });
    assert.equal(aiFillDateLine({ event: { eventDate: "2026-11-21" } }, "2026-11-21")?.differs, false);
    assert.deepEqual(aiFillDateLine({ event: { eventDate: "2026-11-21", eventDateText: "  " } }, undefined), {
      read: "2026-11-21",
      readText: null,
      booked: null,
      differs: true,
    });
    assert.equal(aiFillDateLine({ event: { childName: "Маша" } }, "2026-11-21"), null, "no date read, no line");
    assert.equal(aiFillDateLine(null, "2026-11-21"), null);
    assert.equal(dayLabel("2026-11-21"), "Sat 21 Nov 2026");
    // Create BEO's answer keeps the read date: only Final Message to Parent is the platform's own.
    const kept = inboxFillAnswer({ event: { eventDate: "2026-11-22", internalStaffNotes: "x" } }, ENGLISH, { event: { internalStaffNotes: "mine" } });
    assert.equal(kept.fill.event?.eventDate, "2026-11-22");
  });

  await check("savedFormatStillCarriesTheFieldsTheAppReads", async () => {
    assert.ok(!SAVED_MAY_FORMAT.includes("eventDate") && !SAVED_MAY_FORMAT.includes("catalogue") && !SAVED_MAY_FORMAT.includes("team"));
    const rows = { [AI_SETTING_KEYS.beoAdvice]: "PARK ADVICE", [AI_SETTING_KEYS.beoOutputFormat]: SAVED_MAY_FORMAT };
    const today = beoTodayLine({ name: "ZZ TEST Park", timeZone: "Asia/Bangkok" }, new Date("2026-11-10T03:05:00Z"));
    const catalogueAnswer = { package: { templateId: CATALOGUE.packages[0]!.id, said: "пакет Флореста", line: 1, source: "team" } };
    const answer = { summary: "ZZ Маша", event: { childName: "Маша", eventDate: "2026-11-21", eventDateText: "21 ноября" }, catalogue: catalogueAnswer };

    // The form's read handed the park's catalogue (Create BEO with no transcript), as ai-routes' runBeoFill runs it.
    const model = stubModel(() => JSON.stringify(answer));
    const run = await runAiHelper(deps(model.complete, rows), {
      helper: "beo_parsing",
      schema: BeoFillSchema.extend({ catalogue: z.unknown().optional() }),
      requiredShape: BEO_FILL_WITH_CATALOGUE_SHAPE,
      systemExtra: beoCatalogueSystemBlock(CATALOGUE, { conversation: false }) + today,
      user: RUSSIAN,
      inputChars: RUSSIAN.length,
    });
    assert.equal(run.ok, true, JSON.stringify(run.ok ? null : run.reason));
    const system = model.calls[0]!.system;
    // The saved advice and format still word it, first; the fields the app reads ride right after
    // them, before the catalogue and today.
    const block = requiredFieldsBlock(BEO_FILL_WITH_CATALOGUE_SHAPE);
    assert.ok(system.startsWith(`PARK ADVICE\n\n${SAVED_MAY_FORMAT}${block}\n\nTHE PARK'S CATALOGUE`), system.slice(0, 600));
    assert.ok(system.indexOf("THE PARK'S CATALOGUE") < system.indexOf("Today at ZZ TEST Park is 2026-11-10"));
    assert.ok(block.startsWith(`\n\n${REQUIRED_FIELDS_HEADING}\n`));
    assert.match(block, /required in addition to whatever the format above describes/);
    const keys = blockKeys(block);
    for (const key of [
      "event.eventDate",
      "event.eventDateText",
      "team.partyHost",
      "team.entertainmentHost",
      "catalogue.package.templateId",
      "catalogue.package.line",
      "catalogue.package.source",
      "catalogue.addOns[].lineId",
      "catalogue.setMenu.templateId",
      "catalogue.setMenu.choices[].itemId",
      "catalogue.setMenu.choices[].option",
      "catalogue.menuLines[].productCode",
      "catalogue.entertainment[].templateId",
      "catalogue.event.numChildren.value",
      "catalogue.deposit.paid",
    ]) {
      assert.ok(keys.includes(key), `the block names ${key}`);
    }
    assert.match(block, /\n- event\.eventDate: a date as YYYY-MM-DD: the party's date as the new text names it, never taken from the existing event data; null when the text names no date\n/);
    assert.match(block, /\n- catalogue\.package\.source: one of "team", "family"\n/);
    assert.match(block, /\n- timeline\[\]\.time: a time as HH:MM on the 24-hour clock \(in every entry\)\n/);
    // The sources say so, in the log line and the activity row.
    assert.deepEqual(run.facts.from, { advice: "setting", outputFormat: "setting", model: "built_in", requiredFields: "appended" });
    assert.equal(runLogFields(run.facts).requiredFields, "appended");
    // The stubbed answer's date reaches the review's Date line, and its catalogue section the proposal.
    if (run.ok) {
      assert.equal(run.value.event?.eventDate, "2026-11-21");
      assert.deepEqual(aiFillDateLine(run.value, "2026-11-20"), { read: "2026-11-21", readText: "21 ноября", booked: "2026-11-20", differs: true });
      const proposal = resolveCatalogueAnswer(run.value.catalogue, CATALOGUE, [], { source: "team", at: null, line: null });
      assert.equal(proposal.package?.templateId, CATALOGUE.packages[0]!.id);
    }

    // The conversation's read answers only the catalogue: its block names the catalogue's keys, none of the form's.
    const conversation = stubModel(() => JSON.stringify({ catalogue: catalogueAnswer }));
    await runAiHelper(deps(conversation.complete, rows), {
      helper: "beo_parsing",
      schema: z.object({ catalogue: z.unknown().optional() }),
      requiredShape: CATALOGUE_ONLY_SHAPE,
      systemExtra: beoCatalogueSystemBlock(CATALOGUE, { conversation: true }) + today,
      user: "#1 [team, RULING] 2026-11-03 14:00: ZZ",
      inputChars: 1,
    });
    const conversationSystem = conversation.calls[0]!.system;
    assert.ok(conversationSystem.startsWith(`PARK ADVICE\n\n${SAVED_MAY_FORMAT}${requiredFieldsBlock(CATALOGUE_ONLY_SHAPE)}\n\nTHE CONVERSATION`));
    const conversationKeys = blockKeys(requiredFieldsBlock(CATALOGUE_ONLY_SHAPE));
    assert.ok(conversationKeys.length > 0 && conversationKeys.every((k) => k.startsWith("catalogue.")), conversationKeys.join(", "));

    // One source: every key a block names is the schema's, and the built-in formats ask each of them too.
    const segments = (key: string) => key.replace(/\[\]/g, "").split(".");
    for (const key of blockKeys(requiredFieldsBlock(BeoFillSchema))) {
      for (const s of segments(key)) assert.ok(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT.includes(`"${s}"`), `the built-in format asks ${key}`);
    }
    for (const key of conversationKeys) {
      for (const s of segments(key)) assert.ok(BEO_CATALOGUE_OUTPUT_FORMAT.includes(`"${s}"`), `the catalogue format asks ${key}`);
    }
    // The Events helper's saved format cannot drop a key its form reads either; with nothing saved the block rides too.
    const events = stubModel(() => JSON.stringify({ extracted: {} }));
    await runAiHelper(deps(events.complete, { [AI_SETTING_KEYS.eventOutputFormat]: "ZZ EVENT FORMAT" }), {
      helper: "event_extraction",
      schema: EventExtractionSchema,
      user: "x",
      inputChars: 1,
    });
    assert.ok(events.calls[0]!.system.includes(`\n\nZZ EVENT FORMAT${requiredFieldsBlock(EventExtractionSchema)}\n\nReturn ONLY`));
    for (const key of blockKeys(requiredFieldsBlock(EventExtractionSchema))) {
      for (const s of segments(key)) assert.ok(BUILT_IN_EVENT_EXTRACTION_OUTPUT_FORMAT.includes(s), `the built-in event format asks ${key}`);
    }
    const builtIn = stubModel(() => JSON.stringify(ANSWERS.en));
    await beoRun(deps(builtIn.complete));
    assert.ok(builtIn.calls[0]!.system.includes(`${BUILT_IN_BEO_PARSING_OUTPUT_FORMAT}${requiredFieldsBlock(BeoFillSchema)}\n\nReturn ONLY`));
  });
  await check("aCakeTimeWithNoOwnerLeavesTheCakeType", async () => {
    // SCRUM-787: "the cake at 15:30" says when, not whose cake it is.
    const message = "Подтверждаем день рождения Маши 21 марта в 14:00. Торт в 15:30. 15 детей.";
    const model = stubModel(() => JSON.stringify({ kitchenPlan: { cakeTime: "15.30", cakeNotes: "Торт" }, partyDetails: {} }));
    const run = await beoRun(deps(model.complete), message);
    assert.equal(run.ok, true, JSON.stringify(run.ok ? null : run.reason));
    const system = model.calls[0]!.system;
    // The prompt lets the answer say so, and never guess it.
    assert.ok(BUILT_IN_BEO_PARSING_ADVICE.includes("NOT_SAID when the message gives a cake time or cake details but does not say who brings the cake. Never guess who brings it"));
    assert.ok(BUILT_IN_BEO_PARSING_OUTPUT_FORMAT.includes('"cakeMode": "INTERNAL | EXTERNAL | NONE | NOT_SAID"'));
    assert.ok(system.includes('\n- kitchenPlan.cakeMode: one of "INTERNAL", "EXTERNAL", "NONE", "NOT_SAID"'), "the fields the app requires name NOT_SAID");
    assert.ok(BEO_CATALOGUE_OUTPUT_FORMAT.includes('"mode": "INTERNAL | EXTERNAL | NONE | NOT_SAID"'));
    assert.ok(beoCatalogueSystemBlock(CATALOGUE, { conversation: true }).includes("The cake's \"mode\" is NOT_SAID when the conversation gives a cake time"));
    if (!run.ok) return;
    // No type in the answer: the preview's cake line says "not said", and Load into Editor leaves the form's type.
    assert.equal(run.value.kitchenPlan?.cakeMode, undefined);
    assert.deepEqual(aiFillCakeLine(run.value.kitchenPlan), { type: null, notSaid: true, notes: "Торт", time: "15:30" });
    assert.deepEqual(aiFillCakeApply(run.value.kitchenPlan), { notes: "Торт", time: "15:30" }, "the time and notes; no type, price or quantity");
    // NOT_SAID in the answer reads the same.
    const said = BeoFillSchema.parse({ kitchenPlan: { cakeMode: "not said", cakeTime: "15:30" } });
    assert.equal(said.kitchenPlan?.cakeMode, "NOT_SAID");
    assert.deepEqual(aiFillCakeLine(said.kitchenPlan), { type: null, notSaid: true, notes: null, time: "15:30" });
    assert.deepEqual(aiFillCakeApply(said.kitchenPlan), { time: "15:30" });
    // A type the message does say is shown and applied, as before; "No cake" alone is no line.
    assert.deepEqual(aiFillCakeLine({ cakeMode: "EXTERNAL", cakeTime: "15:30" }), { type: "The family's own cake", notSaid: false, notes: null, time: "15:30" });
    assert.deepEqual(aiFillCakeApply({ cakeMode: "EXTERNAL", cakeTime: "15:30", cakePrice: 200 }), { mode: "EXTERNAL", time: "15:30", included: true, price: 200 });
    assert.equal(aiFillCakeLine({ cakeMode: "NONE" }), null);
    assert.deepEqual(aiFillCakeApply({ cakeMode: "NONE", cakeTime: "15:30" }), {});
    assert.equal(aiFillCakeLine({}), null, "no cake named: no line");
    // The form's cake type is No Cake (every new BEO's): the preview says so and what to choose to keep the time;
    // Load into Editor writes the time and notes and leaves No Cake, and the editor's Cake block then shows them
    // under No Cake with the same words, never out of sight.
    const notSaid = aiFillCakeLine(run.value.kitchenPlan);
    assert.equal(aiFillCakeNotSaidNote(notSaid, "NONE"), "not said — the BEO says No Cake: choose Our Cake or Own Cake to keep the 15:30 cake time");
    assert.equal(aiFillCakeNotSaidNote(notSaid, "EXTERNAL"), "not said — the form's cake type stays as it is (Own Cake)");
    assert.equal(aiFillCakeNotSaidNote(notSaid, "INTERNAL"), "not said — the form's cake type stays as it is (Our Cake)");
    assert.equal(aiFillCakeNotSaidNote(notSaid, undefined), "not said — the form's cake type stays as it is");
    assert.equal(
      aiFillCakeNotSaidNote(aiFillCakeLine({ cakeMode: "NOT_SAID", cakeNotes: "Торт" }), "NONE"),
      "not said — the BEO says No Cake: choose Our Cake or Own Cake to keep the cake notes",
    );
    assert.equal(aiFillCakeNotSaidNote(aiFillCakeLine({ cakeMode: "EXTERNAL", cakeTime: "15:30" }), "NONE"), null, "a type the message says: no note");
    const form = { mode: "NONE", time: "", notes: "" };
    const loaded = aiFillCakeApply(run.value.kitchenPlan);
    const onForm = { mode: loaded.mode ?? form.mode, time: loaded.time ?? form.time, notes: loaded.notes ?? form.notes };
    assert.deepEqual(onForm, { mode: "NONE", time: "15:30", notes: "Торт" }, "Load leaves No Cake and writes the time and notes");
    assert.equal(cakeUnderNoCakeNote(onForm.mode, onForm.time, onForm.notes), "No Cake is chosen: choose Our Cake or Own Cake to keep the 15:30 cake time.");
    assert.equal(cakeUnderNoCakeNote("NONE", "", "Торт"), "No Cake is chosen: choose Our Cake or Own Cake to keep the cake notes.");
    assert.equal(cakeUnderNoCakeNote("INTERNAL", "15:30", "Торт"), null, "under a cake type the Cake block shows them as before");
    assert.equal(cakeUnderNoCakeNote("NONE", "", " "), null, "nothing under No Cake: nothing shown");
    // The catalogue review's words, given the BEO's own type.
    assert.equal(
      aiReviewCakeNotSaidNote({ mode: null, time: "15:30", notes: null }, "NONE"),
      "Not said who brings the cake, and the BEO says No cake: choose the park's or the family's cake here to keep the 15:30 cake time.",
    );
    assert.equal(aiReviewCakeNotSaidNote({ mode: null, time: "15:30" }, "INTERNAL"), "Not said who brings the cake: the BEO keeps its own cake type (the park's cake).");
    assert.equal(aiReviewCakeNotSaidNote({ mode: null, time: "15:30" }, null), "Not said who brings the cake: the BEO keeps its own cake type.");
    assert.equal(aiReviewCakeNotSaidNote({ mode: "INTERNAL", time: "15:30" }, "NONE"), null);
    // A value that is no cake type is still refused, as before.
    assert.equal(BeoFillSchema.safeParse({ kitchenPlan: { cakeMode: "MAYBE" } }).success, false);
    // An empty Party Details box is not shown.
    assert.equal(aiFillPartyDetailsShown(run.value.partyDetails), false, "the answer's empty Party Details");
    assert.equal(aiFillPartyDetailsShown({ prepaymentReceived: 0, items: [], notes: " " }), false);
    assert.equal(aiFillPartyDetailsShown(undefined), false);
    assert.equal(aiFillPartyDetailsShown({ packageName: "Floresta" }), true);
    assert.equal(aiFillPartyDetailsShown({ prepaymentReceived: 5000 }), true);
    // The catalogue review: a cake with a time and no owner is proposed with no type; the approval sends no type.
    const ruling = { source: "team" as const, at: null, line: null };
    const proposal = resolveCatalogueAnswer({ cake: { mode: "NOT_SAID", time: "15:30", line: 1 } }, CATALOGUE, [], ruling);
    assert.deepEqual(proposal.cake, { mode: null, notes: null, time: "15:30", from: ruling });
    assert.deepEqual(resolveCatalogueAnswer({ cake: { time: "15.30" } }, CATALOGUE, [], ruling).cake?.mode, null, "no mode at all: the same");
    assert.equal(resolveCatalogueAnswer({ cake: { mode: "internal" } }, CATALOGUE, [], ruling).cake?.mode, "INTERNAL");
    assert.equal(resolveCatalogueAnswer({ cake: { line: 1 } }, CATALOGUE, [], ruling).cake, null, "nothing of a cake: no cake");
    const review = {
      origin: "pasted" as const, proposal, catalogue: CATALOGUE, finalMessage: null, ruling, transcript: { lines: 1, cut: false }, replaces: [], parentSelection: null,
    };
    const state = initialReviewState(review);
    assert.deepEqual(state.cake?.value, { mode: null, notes: "", time: "15:30" });
    assert.deepEqual(approveBodyOf(review, state, { conversationId: null, messageId: null }).cake, { mode: null, notes: null, time: "15:30" });
    assert.equal(BeoAiApproveBodySchema.shape.cake.safeParse({ mode: null, notes: null, time: "15:30" }).success, true);
  });

  await check("theRestOfTheBeoIsProposedWithItsSource", () => {
    // SCRUM-827: the conversation's requests and timed steps, each its line's author; the later line wins a repeated wish.
    const refs = [1, 2, 3].map((line) => ({ line, id: `l${line}`, source: (line === 2 ? "team" : "family") as "team" | "family", at: `2026-11-0${line}T07:00:00.000Z`, ruling: line === 2 }));
    const proposal = resolveCatalogueAnswer(
      {
        requests: [
          { kind: "decoration", text: "unicorn theme", line: 1, source: "team" }, // the model calls it the team's: the line is the family's
          { kind: "special_request", text: "no nuts", line: 2 },
          { kind: "Special Request", text: "No nuts", line: 3 }, // the same wish again: the later line's
          { kind: "activity", text: "treasure hunt", line: 3 },
          { text: "quiet corner", line: 1 }, // no kind: a special request
          { kind: "decoration", line: 2 }, // no words: dropped
        ],
        timeline: [
          { time: "16.00", label: "cake", line: 2 },
          { time: "15:00", label: "the show", line: 1 },
          { time: "16:00", label: "Cake", line: 3 }, // the same step: the later line's
          { label: "no time", line: 1 }, // dropped
        ],
      },
      CATALOGUE,
      refs,
    );
    const at = (line: number) => refs[line - 1]!.at;
    assert.deepEqual(proposal.details.requests, [
      { kind: "decoration", text: "unicorn theme", from: { source: "family", at: at(1), line: 1 } },
      { kind: "special_request", text: "No nuts", from: { source: "family", at: at(3), line: 3 } },
      { kind: "activity", text: "treasure hunt", from: { source: "family", at: at(3), line: 3 } },
      { kind: "special_request", text: "quiet corner", from: { source: "family", at: at(1), line: 1 } },
    ]);
    assert.deepEqual(proposal.details.timeline, [
      { time: "15:00", label: "the show", from: { source: "family", at: at(1), line: 1 } },
      { time: "16:00", label: "Cake", from: { source: "family", at: at(3), line: 3 } },
    ], "in clock order, the repeated step the later line's");
    // The prompt asks for them, and the fields the app requires name them (SCRUM-816).
    const block = beoCatalogueSystemBlock(CATALOGUE, { conversation: true });
    assert.ok(block.includes('"requests": [ { "kind": "special_request | decoration | activity"') && block.includes('"timeline": [ { "time": "HH:MM"'));
    assert.ok(block.includes("Never invent a time or a step") && block.includes("a wish the team declined is left out"));
    const required = requiredFieldsBlock(CATALOGUE_ONLY_SHAPE);
    assert.ok(required.includes('\n- catalogue.requests[].kind: one of "special_request", "decoration", "activity"'), required);
    assert.ok(required.includes("\n- catalogue.timeline[].time: a time as HH:MM on the 24-hour clock"));
    assert.ok(requiredFieldsBlock(BEO_FILL_WITH_CATALOGUE_SHAPE).includes("\n- catalogue.requests[].text: "));

    // The rest from the form's own read: the ruling's, but what the form already holds; the title the app's rule.
    const ruling = { source: "team" as const, at: at(2), line: 2 };
    const fill = BeoFillSchema.parse({
      event: { title: "Model's own title", childName: "Mali", bookingName: "Khun Noi", locationText: "Jungle Room", specialRequests: "no nuts please", decoration: "balloons", activities: "treasure hunt and games" },
      setupPlan: { readyBy: "13:30", responsible: "Ying", simplifiedTasks: [{ itemLabel: "Balloon arch" }, { itemLabel: "Kids' table", notes: "12 seats" }] },
      partyDetails: { packageName: "Floresta", notes: "pay the rest on the day", items: [{ description: "Kids' table", type: "included" }, { description: "Extra hour", type: "extra" }] },
      timeline: [{ time: "17:00", label: "the end" }],
    });
    const existing = {
      event: { childName: "Mali", bookingName: "Khun Noi", locationText: "" },
      setupPlan: { readyBy: "", responsible: "", simplifiedTasks: [{ itemLabel: "balloon arch" }] },
      partyDetails: { packageName: "Floresta", notes: "", items: [] },
    };
    const d = detailsFromFill(proposal, fill, { existingData: existing, from: ruling, event: { childName: null, kidTurningAge: 6, eventType: "birthday" } });
    assert.deepEqual(d.title, { value: "Mali's 6th Birthday", from: { source: "default", at: null, line: null } }, "the title: the app's rule, the park's default, never the model's");
    assert.equal(d.bookingName, null, "carried forward from the form: not proposed");
    assert.deepEqual(d.locationText, { value: "Jungle Room", from: ruling });
    assert.deepEqual(d.setup.readyBy, { value: "13:30", from: ruling });
    assert.deepEqual(d.setup.responsible, { value: "Ying", from: ruling });
    assert.deepEqual(d.setup.tasks, [{ itemLabel: "Kids' table", notes: "12 seats", from: ruling }], "a task the form holds (case aside) is not proposed again");
    assert.equal(d.pos.name, null, "the POS name the form holds");
    assert.deepEqual(d.pos.notes, { value: "pay the rest on the day", from: ruling });
    assert.deepEqual(d.pos.items.map((i) => [i.description, i.type, i.from]), [["Kids' table", "included", ruling], ["Extra hour", "extra", ruling]]);
    assert.deepEqual(
      d.requests.map((r) => [r.kind, r.text, r.from.source]),
      [["decoration", "unicorn theme", "family"], ["special_request", "No nuts", "family"], ["activity", "treasure hunt", "family"], ["special_request", "quiet corner", "family"], ["decoration", "balloons", "team"]],
      "the ruling's own words join only where the conversation holds no such words",
    );
    assert.deepEqual(d.timeline.map((t) => [t.time, t.label]), [["15:00", "the show"], ["16:00", "Cake"]], "the conversation's steps stand; the ruling's are not added beside them");
    // No conversation read (the ruling alone): the ruling's requests and steps, all the team's; the title without an age
    // (no event loaded: the form's own type says it is a birthday).
    const bare = detailsFromFill(resolveCatalogueAnswer({}, CATALOGUE, [], ruling), fill, { existingData: { event: { eventType: "birthday" } }, from: ruling, event: null });
    assert.deepEqual(bare.title, { value: "Mali's Birthday", from: { source: "default", at: null, line: null } });
    assert.deepEqual(bare.bookingName, { value: "Khun Noi", from: ruling });
    assert.deepEqual(bare.requests.map((r) => [r.kind, r.text, r.from]), [["special_request", "no nuts please", ruling], ["decoration", "balloons", ruling], ["activity", "treasure hunt and games", ruling]]);
    assert.deepEqual(bare.timeline, [{ time: "17:00", label: "the end", from: ruling }]);
    assert.equal(bare.setup.tasks.length, 2);
    assert.equal(detailsFromFill(resolveCatalogueAnswer({}, CATALOGUE, [], ruling), BeoFillSchema.parse({}), { existingData: {}, from: ruling, event: { childName: "  ", kidTurningAge: 5, eventType: "birthday" } }).title, null, "no child's name: no title, never a made-up one");
    // SCRUM-827 review: "Mali's 6th Birthday" is a birthday's name (as apps/api's Book Date names only birthdays so):
    // a camp or a corporate event is not named after a child's birthday — the event's type decides, else the form's.
    const titled = (event: { childName?: string | null; kidTurningAge?: number | null; eventType?: string | null } | null, existingData: unknown = {}) =>
      detailsFromFill(resolveCatalogueAnswer({}, CATALOGUE, [], ruling), fill, { existingData, from: ruling, event }).title;
    assert.equal(titled({ childName: null, kidTurningAge: 6, eventType: "camp" }), null, "a camp");
    assert.equal(titled({ childName: null, kidTurningAge: 6, eventType: "private_event" }), null, "a corporate event");
    assert.equal(titled({ childName: null, kidTurningAge: 6, eventType: "camp" }, { event: { eventType: "birthday" } }), null, "the event's type wins over the form's");
    assert.deepEqual(titled({ childName: null, kidTurningAge: 6, eventType: "birthday" })?.value, "Mali's 6th Birthday");
    assert.equal(titled(null, { event: { eventType: "camp" } }), null, "no event: the form's type");
    assert.equal(titled(null, {}), null, "no type known: no title, never a guess");
    // The naming rule, as Book Date and the Events form name a party.
    assert.equal(beoEventTitleOf("Mali", 1), "Mali's 1st Birthday");
    assert.equal(beoEventTitleOf("Mali", 2), "Mali's 2nd Birthday");
    assert.equal(beoEventTitleOf("Mali", 3), "Mali's 3rd Birthday");
    assert.equal(beoEventTitleOf("Mali", 11), "Mali's 11th Birthday");
    assert.equal(beoEventTitleOf("Mali", 12), "Mali's 12th Birthday");
    assert.equal(beoEventTitleOf("Mali", 13), "Mali's 13th Birthday");
    assert.equal(beoEventTitleOf("Mali", 21), "Mali's 21st Birthday");
    assert.equal(beoEventTitleOf("Mali", 0), "Mali's Birthday");
    assert.equal(beoEventTitleOf("Mali", null), "Mali's Birthday");
    assert.equal(beoEventTitleOf(null, 6), null);
    // The marks' words.
    assert.equal(beoAiSourceLabel("default"), "the park's default");
    assert.equal(beoAiSourceLabel("template"), "from a template");
    assert.equal(beoAiSourceLabel("team"), "from the team");
  });

  await check("theReviewKeepsWhatIsHeldAndSendsTheRest", () => {
    // SCRUM-827: the review opens with the rest; a value the form holds stays, the chat's offered beside it.
    const refs = [1, 2, 3].map((line) => ({ line, id: `l${line}`, source: (line === 2 ? "team" : "family") as "team" | "family", at: `2026-11-0${line}T07:00:00.000Z`, ruling: line === 2 }));
    const ruling = { source: "team" as const, at: refs[1]!.at, line: 2 };
    const proposal = resolveCatalogueAnswer(
      {
        event: { childName: { value: "Mali", line: 1 } },
        requests: [
          { kind: "decoration", text: "unicorn theme", line: 1 },
          { kind: "special_request", text: "No nuts", line: 3 },
          { kind: "special_request", text: "quiet corner", line: 1 },
          { kind: "activity", text: "treasure hunt", line: 3 },
        ],
        timeline: [{ time: "16:00", label: "Cake", line: 2 }],
      },
      CATALOGUE,
      refs,
    );
    proposal.details = detailsFromFill(
      proposal,
      BeoFillSchema.parse({
        event: { locationText: "Jungle Room", decoration: "balloons" },
        setupPlan: { readyBy: "13:30", responsible: "Ying", simplifiedTasks: [{ itemLabel: "Kids' table", notes: "12 seats" }] },
        partyDetails: { notes: "pay the rest on the day", items: [{ description: "Extra hour", type: "extra" }] },
      }),
      { existingData: {}, from: ruling, event: { childName: null, kidTurningAge: 6, eventType: "birthday" } },
    );
    const review = {
      origin: "inbox" as const, proposal, catalogue: CATALOGUE, finalMessage: null, ruling, transcript: { lines: 3, cut: false }, replaces: [], parentSelection: null,
    };
    const held = { ...NOTHING_HELD, title: "ZZ typed title", specialRequests: "No nuts\nquiet corner", activities: "Games" };
    const fill = {
      proposals: {
        partyHost: { asked: "Nok", match: { kind: "employee", id: "emp-1", label: "Nok (Siriporn)" }, why: null },
        entertainmentHost: null,
        setupResponsible: { asked: "Ying", match: null, why: "no_match" },
      },
    };
    const state = initialReviewState(review, { held, fill });
    const d = state.details;
    // The typed title stays, nobody's line; the park's default is offered beside it.
    assert.equal(d.title.value, "ZZ typed title");
    assert.equal(d.title.from, null);
    assert.equal(d.title.chat, "Mali's 6th Birthday");
    assert.equal(chatOffered(d.title), true);
    // A held value the chat gives as well wears the chat's marks (the latest line's, every line shown).
    assert.equal(d.specialRequests.value, "No nuts\nquiet corner");
    assert.deepEqual(d.specialRequests.from, { source: "family", at: refs[2]!.at, line: 3 });
    assert.deepEqual(d.specialRequests.froms.map((f) => f.source), ["family"]);
    assert.equal(chatOffered(d.specialRequests), false);
    // Typed activities stay; the chat's is offered and taken with one press.
    assert.equal(d.activities.value, "Games");
    assert.equal(chatOffered(d.activities), true);
    const taken = useChatText(d.activities);
    assert.equal(taken.value, "treasure hunt");
    assert.equal(sourceOf(taken), "family");
    // A field the form holds nothing of starts at the chat's, with both lines' marks on a joined one.
    assert.equal(d.locationText.value, "Jungle Room");
    assert.equal(sourceOf(d.locationText), "team");
    assert.equal(d.decoration.value, "unicorn theme\nballoons");
    assert.deepEqual(d.decoration.froms.map((f) => f.source), ["family", "team"]);
    assert.equal(d.setupReadyBy.value, "13:30");
    assert.deepEqual(d.setupTasks.map((t) => [t.label, t.extra, t.from?.source]), [["Kids' table", "12 seats", "team"]]);
    assert.deepEqual(d.posItems.map((i) => [i.label, i.extra]), [["Extra hour", "extra"]]);
    assert.deepEqual(d.timeline.map((s) => [s.extra, s.label, s.from?.source]), [["16:00", "Cake", "team"]]);
    assert.equal(d.team.proposals.partyHost?.match?.label, "Nok (Siriporn)");
    assert.deepEqual(d.team.accepted, []);
    assert.equal(sourceOf(editedText(d.posNotes, "typed here")), "staff");
    // The offer's words name where the offered text is from: the park's default is never called the chat's.
    assert.deepEqual(chatOfferWords(d.title), { line: `The park's default is "Mali's 6th Birthday"`, button: "Use the park's default" });
    assert.deepEqual(chatOfferWords(d.activities), { line: 'The chat says "treasure hunt"', button: "Use the chat's" });
    assert.deepEqual(chatOfferWords({ chat: "Balloon arch", chatFrom: { source: "template", at: null, line: null } }), { line: 'The template gives "Balloon arch"', button: "Use the template's" });

    // What Approve and create sends: only what differs from the form, the lines kept, the team ticked.
    const ids = { conversationId: null, messageId: null };
    const untouched = approveBodyOf(review, state, ids);
    assert.equal(untouched.details?.title, undefined, "a held title is not sent: nothing typed is overwritten");
    assert.equal(untouched.details?.specialRequests, undefined, "the held special requests are the chat's already: nothing to write");
    assert.equal(untouched.details?.activities, undefined);
    assert.equal(untouched.details?.locationText, "Jungle Room");
    assert.equal(untouched.details?.decoration, "unicorn theme\nballoons");
    assert.equal(untouched.details?.setupReadyBy, "13:30");
    assert.equal(untouched.details?.setupResponsible, "Ying");
    assert.deepEqual(untouched.details?.setupTasks, [{ itemLabel: "Kids' table", notes: "12 seats" }]);
    assert.deepEqual(untouched.details?.posItems, [{ description: "Extra hour", type: "extra" }]);
    assert.deepEqual(untouched.details?.timeline, [{ time: "16:00", label: "Cake" }]);
    assert.equal(untouched.details?.team, undefined, "nobody ticked: nobody assigned");
    assert.ok(!untouched.sources.some((s) => s.field === "title"), "a typed title is nobody's line: no source");
    assert.ok(untouched.sources.some((s) => s.field === "specialRequests" && s.source === "family"), "held and the chat's: its source is recorded though nothing is written");
    assert.ok(untouched.sources.some((s) => s.field === "locationText" && s.source === "team"));
    assert.ok(untouched.sources.some((s) => s.field === "timeline:0" && s.source === "team"));
    assert.equal(BeoAiApproveBodySchema.safeParse(untouched).success, true, JSON.stringify(BeoAiApproveBodySchema.safeParse(untouched)));
    // Typed before the review and not yet saved: the review keeps it, and the one Save writes it as it stands
    // (the saved BEO holds nothing of it), with no source — it is nobody's line; a saved value is still not sent.
    const typed = initialReviewState(review, { held, saved: { ...NOTHING_HELD, activities: "Games" }, fill });
    assert.equal(typed.details.title.value, "ZZ typed title", "kept as typed");
    assert.equal(typed.details.title.saved, null);
    assert.equal(typed.details.activities.saved, "Games");
    const written = approveBodyOf(review, typed, ids);
    assert.equal(written.details?.title, "ZZ typed title", "unsaved typed text is written by the one Save");
    assert.equal(written.details?.specialRequests, "No nuts\nquiet corner");
    assert.equal(written.details?.activities, undefined, "the saved value is not written back over itself");
    assert.ok(!written.sources.some((s) => s.field === "title"), "typed text is nobody's line: no source");
    assert.ok(written.sources.some((s) => s.field === "specialRequests" && s.source === "family"), "the chat's words, typed before: the chat's source");
    assert.equal(BeoAiApproveBodySchema.safeParse(written).success, true);
    // The park's default taken, the chat's activities taken, the host ticked, a note typed.
    const chosen = {
      ...state,
      details: { ...d, title: useChatText(d.title), activities: taken, posNotes: editedText(d.posNotes, "typed here"), team: { ...d.team, accepted: ["partyHost" as const, "setupResponsible" as const] } },
    };
    const body = approveBodyOf(review, chosen, ids);
    assert.equal(body.details?.title, "Mali's 6th Birthday");
    assert.equal(body.details?.activities, "treasure hunt");
    assert.equal(body.details?.posNotes, "typed here");
    assert.deepEqual(body.details?.team, { partyHost: { kind: "employee", id: "emp-1", label: "Nok (Siriporn)" } }, "an unmatched name is never assigned, ticked or not");
    const source = (field: string) => body.sources.find((s) => s.field === field)?.source;
    assert.equal(source("title"), "default");
    assert.equal(source("activities"), "family");
    assert.equal(source("posNotes"), "staff");
    assert.equal(source("team:partyHost"), "team");
    assert.equal(source("childName"), "family");
    assert.equal(BeoAiApproveBodySchema.safeParse(body).success, true);
    assert.equal(BeoAiApproveBodySchema.safeParse({ ...body, sources: [{ field: "title", source: "model", at: null }] }).success, false, "a source the row does not know is refused");
    // The marks the form wears afterwards, by field, and the sections they open.
    const marks = approvedMarksOf(body.sources);
    assert.equal(marks.title, "default");
    assert.equal(marks["team:partyHost"], "team");
    assert.equal(marks.posNotes, "staff");
    assert.deepEqual(approvedSectionsOf(marks).sort(), ["event-info", "party-details", "party-host", "setup-plan", "timeline"]);
    assert.deepEqual(approvedSectionsOf({}), []);
  });

  await check("theAdultsListFoldsIntoTheKidsUnlessItIsTheirOwn", async () => {
    // SCRUM-829: the model is told the adults eat what the kids eat unless the message says
    // otherwise, and on staging it still split the lists — the kids' dishes again as adultsMenu,
    // in the adults' headcount, each noted "Adults eat the same as the kids". This stub answers
    // exactly that, so what is proved is the read's fold, not the model's obedience.
    const kids = [{ itemName: "Nuggets", quantity: 10 }, { itemName: "Juice", quantity: 10 }];
    const splitting = (adults: unknown[]) =>
      stubModel(() => JSON.stringify({ event: { numChildren: 10, numAdults: 4 }, kitchenPlan: { kidsMenu: kids, adultsMenu: adults } })).complete;
    const theSame = [
      { itemName: "Nuggets", quantity: 4, notes: "Adults eat the same as the kids" },
      { itemName: "Juice", quantity: 4, notes: "Adults eat the same as the kids" },
    ];
    // "The adults will eat the same": the adults' list is the kids' in other words — folded, one list.
    const same = await beoRun(deps(splitting(theSame)), "Confirmed: nuggets and juice for the kids, and the adults will eat the same.");
    assert.equal(same.ok, true, JSON.stringify(same.ok ? null : same.reason));
    if (!same.ok) return;
    assert.deepEqual(same.value.kitchenPlan?.kidsMenu?.map((l) => [l.itemName, l.quantity]), [["Nuggets", 10], ["Juice", 10]], "the kids' list as answered");
    assert.equal(same.value.kitchenPlan?.adultsMenu, undefined, "no adults' list: the preview shows one list and the editor opens with the switch off");
    assert.equal("adultsMenu" in (same.value.kitchenPlan ?? {}), false, "the key is gone, as when the model obeys");
    // Nothing said of the adults' food and the model still writes them the kids' dishes: the same,
    // whatever the order, the case, the spacing or the count.
    const silent = await beoRun(deps(splitting([{ itemName: "juice", quantity: 4 }, { itemName: " NUGGETS", quantity: 2 }])), "Confirmed: nuggets and juice for the kids.");
    assert.equal(silent.ok, true);
    if (!silent.ok) return;
    assert.equal(silent.value.kitchenPlan?.adultsMenu, undefined, "folded");
    // "Pasta for the adults": a dish of their own — the adults' list, kept as answered, the switch on.
    const differ = await beoRun(deps(splitting([{ itemName: "Pasta", quantity: 4 }])), "Confirmed: nuggets and juice for the kids, pasta for the adults.");
    assert.equal(differ.ok, true);
    if (!differ.ok) return;
    assert.deepEqual(differ.value.kitchenPlan?.adultsMenu?.map((l) => [l.itemName, l.quantity]), [["Pasta", 4]], "their own dish is kept");
    // "Nuggets and juice for everyone, and a cheese platter for the adults": everything the adults eat, kept.
    const beside = await beoRun(
      deps(splitting([{ itemName: "Nuggets", quantity: 4 }, { itemName: "Juice", quantity: 4 }, { itemName: "Cheese platter", quantity: 1 }])),
      "Confirmed: nuggets and juice for everyone, and a cheese platter for the adults.",
    );
    assert.equal(beside.ok, true);
    if (!beside.ok) return;
    assert.deepEqual(beside.value.kitchenPlan?.adultsMenu?.map((l) => l.itemName), ["Nuggets", "Juice", "Cheese platter"], "a shared dish beside their own is not folded");
    // The adults get only some of the kids' dishes: less is a difference, so their list is kept.
    const fewer = await beoRun(deps(splitting([{ itemName: "Nuggets", quantity: 4 }])), "Confirmed: nuggets and juice for the kids; nuggets only for the adults.");
    assert.equal(fewer.ok, true);
    if (!fewer.ok) return;
    assert.deepEqual(fewer.value.kitchenPlan?.adultsMenu?.map((l) => l.itemName), ["Nuggets"]);
    // An empty adults' list, or none, reads as before.
    assert.deepEqual(BeoFillSchema.parse({ kitchenPlan: { kidsMenu: kids, adultsMenu: [] } }).kitchenPlan?.adultsMenu, []);
    assert.equal(BeoFillSchema.parse({ kitchenPlan: { kidsMenu: kids, adultsMenu: null } }).kitchenPlan?.adultsMenu, undefined);
    // The rule itself, shared with Load into Editor and the review's approval: the same dish names, nothing else.
    assert.equal(sameKitchenDishNames(kids, theSame), true);
    assert.equal(sameKitchenDishNames(kids, [{ itemName: "Pasta", quantity: 4 }]), false);
    assert.equal(sameKitchenDishNames(kids, [{ itemName: "Nuggets" }]), false, "one of the kids' dishes left out");
    assert.equal(sameKitchenDishNames(kids, [...theSame, { itemName: "Wine" }]), false, "a dish of their own beside the kids'");
    assert.equal(sameKitchenDishNames(kids, []), false, "nothing is not the same");
    assert.equal(sameKitchenDishNames([], [{ itemName: "Pasta" }]), false, "a list of the adults' own over no kids' list");
    // The prompt's rule stands beside the fold; the required-fields block still names the adults' line keys.
    const model = splitting(theSame);
    await beoRun(deps(model), "a message");
    assert.match(BUILT_IN_BEO_PARSING_ADVICE, /The adults eat what the kids eat unless the message says otherwise/);
    assert.ok(requiredFieldsBlock(BeoFillSchema).includes("- kitchenPlan.adultsMenu[].itemName: text (in every entry)"), "the transform is unwrapped for the block");
  });
} finally {
  // Nothing to clean: no database, no network.
}

console.log(JSON.stringify({ results, failures }, null, 2));
if (Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 18) process.exit(1);
