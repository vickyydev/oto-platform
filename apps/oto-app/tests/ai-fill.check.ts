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
//   - SCRUM-816: a park group's saved output format words the answer but
//     never drops a key the code reads: every run's prompt names, after the
//     format, each key of the schema the answer is read by (the party's date,
//     the catalogue section with its ids and sources), so a format saved
//     before those keys existed still gets them asked, and the answer's date
//     still reaches the review.
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
  resolveCatalogueAnswer,
  type BeoCatalogue,
} from "../server/lib/beoCatalogueFill";
import { aiFillDateLine, dayLabel } from "../client/src/lib/beo-ai-date";

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
} finally {
  // Nothing to clean: no database, no network.
}

console.log(JSON.stringify({ results, failures }, null, 2));
if (Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 13) process.exit(1);
