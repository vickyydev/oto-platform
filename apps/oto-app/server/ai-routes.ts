import { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "./db";
import { branches, coreEvents } from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { storage, type ActivityLogInput } from "./storage";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { log } from "./lib/logger";
import { aiComplete, aiConfigured, getAnthropic } from "./lib/anthropic";
import {
  AI_TEXT_MAX,
  BeoFillSchema,
  DEFAULT_PARK_TIME_ZONE,
  EventExtractionSchema,
  beoParseUserMessage,
  beoTodayLine,
  inboxFillAnswer,
  runAiHelper,
  runLogFields,
  type AiDeps,
  type AiRun,
  type BeoFill,
  type ParkPlace,
} from "./lib/aiFill";
import {
  NO_TEAM_PROPOSALS,
  loadTeamCandidates,
  proposalCounts,
  proposeTeam,
  type TeamCandidates,
  type TeamProposals,
} from "./lib/beoTeamProposals";
import { readInboxConfirmation, type InboxRead } from "./lib/inboxConfirmation";
import {
  BEO_FILL_WITH_CATALOGUE_SHAPE,
  CATALOGUE_ONLY_SHAPE,
  beoCatalogueSystemBlock,
  catalogueIsEmpty,
  emptyCatalogue,
  loadBeoCatalogue,
  renderTranscript,
  resolveCatalogueAnswer,
  type BeoCatalogue,
  type TranscriptRef,
} from "./lib/beoCatalogueFill";
import { approveBeoAiFill, parentSelectionOf, sectionsHeld } from "./lib/beoAiApprove";
import type { DbExecutor } from "./lib/packageSnapshot";
import { BeoAiApproveBodySchema, type BeoAiFrom, type BeoAiProposal, type BeoAiReview } from "@shared/beoAiFill";

interface ExtractEventRequest {
  notes_text: string;
  existing_form_data?: Record<string, unknown>;
  branch_context?: { branch_id: string; branch_name: string };
  timezone?: string;
}

/** What the form holds now: the baseline the model changes only where the message says so. */
const ExistingDataSchema = z.record(z.unknown()).nullish();

const ParseBeoBodySchema = z.object({
  text: z.unknown(),
  existingData: ExistingDataSchema,
  /** The event whose BEO is open: its park's team is what a fill may propose, and the activity row names it. */
  eventId: z.string().max(64).nullish(),
});

/** Create BEO's AI Fill: only the form's state; the message is read on the platform, never sent here. */
const InboxFillBodySchema = z.object({ existingData: ExistingDataSchema });

/** The event a BEO fill is for, as the BEO editor's own read fences it. */
export interface BeoFillEvent {
  id: string;
  tenantId: string;
  branchId: string | null;
  title: string;
  inboxConversationId: string | null;
}

/** What the routes reach outside themselves; a check replaces any of them. */
export interface AiRouteDeps {
  ai: Pick<AiDeps, "configured" | "complete">;
  /** The caller's park group's setting value (S2-17b round 4a), the default park group's where it has none. */
  readSetting: (req: Request, key: string) => Promise<string | null>;
  /** The event, when it is the caller's park group's and at a park they may open; else null. */
  loadEvent: (req: Request, eventId: string) => Promise<BeoFillEvent | null>;
  teamCandidates: (event: BeoFillEvent) => Promise<TeamCandidates>;
  /** An activity row; inside a transaction when one is given (SCRUM-815's approval). */
  recordActivity: (entry: ActivityLogInput, executor?: DbExecutor) => Promise<unknown>;
  /** The inbox conversation's confirmation message, read on the platform as this person. */
  inboxConfirmation: (req: Request, conversationId: string) => Promise<InboxRead>;
  /**
   * SCRUM-814: the park a BEO fill reads its dates at — the event's, else the
   * signed-in person's — for the prompt's "today".
   */
  parkPlace: (req: Request, event: BeoFillEvent | null) => Promise<ParkPlace>;
  /** The clock (a check fixes it). */
  now: () => Date;
  /** SCRUM-815: the park's catalogue for the event's park, which the fill matches the conversation to. */
  catalogue: (event: BeoFillEvent) => Promise<BeoCatalogue>;
  /** SCRUM-815: after an approval is written, the BEO's timeline is generated again, as the BEO's own Save does. */
  afterApprove: (eventId: string) => Promise<void>;
}

const PARKS_ZONE: ParkPlace = { name: null, timeZone: DEFAULT_PARK_TIME_ZONE };

/**
 * The park a BEO fill is for: the event's park; with no event, the person's
 * one park, else their park group's parks when they share one zone; else the
 * parks' zone with no name. Never refuses a fill: a read that fails is the
 * parks' zone.
 */
async function defaultParkPlace(req: Request, event: BeoFillEvent | null): Promise<ParkPlace> {
  const tenantId = event?.tenantId ?? req.userWithAccess?.tenantId ?? (req.user as { tenantId?: string } | undefined)?.tenantId;
  if (!tenantId) return PARKS_ZONE;
  try {
    const one = async (branchId: string) => {
      const [row] = await db
        .select({ name: branches.name, timeZone: branches.timezone })
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)));
      return row ? { name: row.name, timeZone: row.timeZone || DEFAULT_PARK_TIME_ZONE } : null;
    };
    if (event?.branchId) return (await one(event.branchId)) ?? PARKS_ZONE;
    const access = req.userWithAccess;
    if (access && !access.hasAllBranchesAccess && access.allowedBranchIds?.length === 1) {
      return (await one(access.allowedBranchIds[0]!)) ?? PARKS_ZONE;
    }
    const rows = await db.select({ timeZone: branches.timezone }).from(branches).where(eq(branches.tenantId, tenantId));
    const zones = new Set(rows.map((r) => r.timeZone || DEFAULT_PARK_TIME_ZONE));
    return zones.size === 1 ? { name: null, timeZone: [...zones][0]! } : PARKS_ZONE;
  } catch (error) {
    log().warn({ err: (error as Error)?.message ?? String(error) }, "the park's zone was not read; the parks' own is used");
    return PARKS_ZONE;
  }
}

/**
 * Why Create BEO's AI Fill did not run, in the one line the form shows. The
 * form still opens as it always did; nothing is filled.
 */
export const INBOX_FILL_MESSAGES = {
  not_from_inbox: "AI Fill did not run: this birthday was not booked from the inbox, so there is no confirmation message to read.",
  no_platform_session:
    "AI Fill did not run: this session was not opened from the OTO launcher, so the inbox could not be read. Use AI Fill to paste the message.",
  signed_out: "AI Fill did not run: your launcher session has ended. Open the OTO App from the launcher again.",
  inbox_not_visible: "AI Fill did not run: this birthday's conversation is not one you can see in the inbox.",
  not_a_birthday: "AI Fill did not run: the conversation is no longer in Birthdays & Events.",
  inbox_unreachable: "AI Fill did not run: the inbox did not answer. Use AI Fill to paste the message, or press Create BEO again.",
  event_mismatch: "AI Fill did not run: the inbox conversation now names another event.",
  no_confirmation:
    "AI Fill did not run: no message from the team in this conversation names the date, the time and the party details yet.",
  too_long: "AI Fill did not run: the confirmation message is too long to read at once. Use AI Fill to paste the part that matters.",
} as const;
export type InboxFillRefusal = keyof typeof INBOX_FILL_MESSAGES;

const INBOX_FILL_STATUS: Record<InboxFillRefusal, number> = {
  not_from_inbox: 409,
  no_platform_session: 409,
  signed_out: 401,
  inbox_not_visible: 404,
  not_a_birthday: 409,
  inbox_unreachable: 503,
  event_mismatch: 409,
  no_confirmation: 409,
  too_long: 409,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const defaultAiRouteDeps: AiRouteDeps = {
  ai: { configured: aiConfigured, complete: aiComplete },
  readSetting: async (req, key) => (await storage.getSetting(key, req.userWithAccess?.tenantId ?? null))?.value ?? null,
  loadEvent: async (req, eventId) => {
    // The park group as `GET /api/events/:eventId/beo` reads it: the signed-in user's own.
    const tenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
    if (!tenantId || !UUID.test(eventId)) return null;
    const [event] = await db
      .select({
        id: coreEvents.id,
        tenantId: coreEvents.tenantId,
        branchId: coreEvents.branchId,
        title: coreEvents.title,
        inboxConversationId: coreEvents.inboxConversationId,
      })
      .from(coreEvents)
      .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)));
    if (!event || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, event.branchId)) return null;
    return event;
  },
  teamCandidates: (event) => loadTeamCandidates(db, event),
  recordActivity: (entry, executor) => storage.createActivityLog(entry, executor),
  inboxConfirmation: readInboxConfirmation,
  parkPlace: defaultParkPlace,
  now: () => new Date(),
  catalogue: (event) => loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId }),
  afterApprove: async (eventId) => {
    const { generateTimelineFromBeo } = await import("./beo-routes");
    await generateTimelineFromBeo(eventId);
  },
};

/** The run's schema with the catalogue section the model adds when it is handed the catalogue (read apart, leniently). */
const BeoFillWithCatalogueSchema = BeoFillSchema.extend({ catalogue: z.unknown().optional() }) as unknown as z.ZodType<
  BeoFill & { catalogue?: unknown },
  z.ZodTypeDef,
  unknown
>;

/** The conversation's read: only its `catalogue` key is taken (anything else it answers is left). */
const CatalogueOnlySchema = z.object({ catalogue: z.unknown().optional() }).passthrough() as unknown as z.ZodType<
  { catalogue?: unknown },
  z.ZodTypeDef,
  unknown
>;

/** What the activity row says of a catalogue proposal: counts and sources, never the chat's words. */
const catalogueCounts = (p: BeoAiProposal) => ({
  package: p.package !== null,
  addOns: p.addOns.length,
  setMenu: p.setMenu !== null,
  choices: p.setMenu?.choices.length ?? 0,
  menuLines: p.menuLines.filter((l) => !l.notInMenu).length,
  notInMenu: p.menuLines.filter((l) => l.notInMenu).length,
  entertainment: p.entertainment.filter((e) => !e.notInCatalogue).length,
  notInCatalogue: p.entertainment.filter((e) => e.notInCatalogue).length + p.otherLines.length,
});

/** The sections a fill gave, for the activity row: names of sections, never their contents. */
const filledSections = (fill: BeoFill): string[] =>
  (["event", "setupPlan", "kitchenPlan", "partyDetails", "timeline", "team"] as const).filter((k) => {
    const v = fill[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && Object.keys(v).length > 0;
  });

/**
 * One BEO AI Fill: the parse, the team it may propose at the event's park, and
 * its activity row. The row says who ran it, on which event, from where and how
 * it ended; never the text that was read or what the model answered.
 */
export async function runBeoFill(
  deps: AiRouteDeps,
  req: Request,
  input: {
    /** The message the form's own fields are read from: the pasted text, or the inbox's ruling message. */
    text: string;
    existingData?: unknown;
    event: BeoFillEvent | null;
    source: { kind: "pasted" } | { kind: "inbox"; conversationId: string; messageId: string };
    /**
     * SCRUM-815: the whole conversation, numbered (`renderTranscript`): what
     * each line number stands for, and whether older lines were left out. Read
     * (with a catalogue) only for the catalogue section, beside the form's read
     * of `text`, so every value it gives names its line.
     */
    conversation?: { text: string; refs: TranscriptRef[]; cut: boolean } | null;
    /** SCRUM-815: the park's catalogue to match to; the answer then carries a checked proposal. */
    catalogue?: BeoCatalogue | null;
    /** Where a catalogue value is from when the model names no line (the ruling message, read alone). */
    fallbackFrom?: BeoAiFrom;
    /** SCRUM-814: the park, when the caller has already read it. */
    place?: ParkPlace;
  },
): Promise<{ run: AiRun<BeoFill>; proposals: TeamProposals; proposal: BeoAiProposal | null }> {
  // SCRUM-814: the park's today ends the prompt, so a year-less or relative date reads against it.
  const place = input.place ?? (await deps.parkPlace(req, input.event));
  const today = beoTodayLine(place, deps.now());
  const ai = { ...deps.ai, readSetting: (key: string) => deps.readSetting(req, key) };
  // SCRUM-815: the catalogue, with how to match it; today stays last.
  const catalogue = input.catalogue && !catalogueIsEmpty(input.catalogue) ? input.catalogue : null;
  const conversation = catalogue ? (input.conversation ?? null) : null;
  // The form's own fields: `text` alone, as SCRUM-660 read it. With a catalogue and no
  // conversation, the same read also answers the catalogue section, from `text`.
  // SCRUM-816: each read's prompt names the keys its answer is read by, whatever a saved format says.
  const formRead = runAiHelper(ai, {
    helper: "beo_parsing",
    schema: (catalogue && !conversation ? BeoFillWithCatalogueSchema : BeoFillSchema) as typeof BeoFillWithCatalogueSchema,
    requiredShape: catalogue && !conversation ? BEO_FILL_WITH_CATALOGUE_SHAPE : BeoFillSchema,
    systemExtra: (catalogue && !conversation ? beoCatalogueSystemBlock(catalogue, { conversation: false }) : "") + today,
    user: beoParseUserMessage(input.text, input.existingData),
    inputChars: input.text.length,
  });
  // With a conversation, its read answers only the catalogue section, each entry naming its line.
  const conversationRead =
    catalogue && conversation
      ? runAiHelper(ai, {
          helper: "beo_parsing",
          schema: CatalogueOnlySchema,
          requiredShape: CATALOGUE_ONLY_SHAPE,
          systemExtra: beoCatalogueSystemBlock(catalogue, { conversation: true }) + today,
          user: beoParseUserMessage(conversation.text, undefined),
          inputChars: conversation.text.length,
        })
      : null;
  const [run, catalogueRun] = await Promise.all([formRead, conversationRead]);
  let proposal: BeoAiProposal | null = null;
  if (run.ok && catalogue) {
    const { catalogue: fromForm, ...fill } = run.value as BeoFill & { catalogue?: unknown };
    run.value = fill;
    if (!conversation) proposal = resolveCatalogueAnswer(fromForm, catalogue, [], input.fallbackFrom);
    else if (catalogueRun?.ok) proposal = resolveCatalogueAnswer(catalogueRun.value.catalogue, catalogue, conversation.refs);
  }
  if (catalogueRun && !catalogueRun.ok) {
    // The form's read stands: the review is the free-text preview of before.
    log().warn({ ...runLogFields(catalogueRun.facts), eventId: input.event?.id ?? null }, "the conversation's catalogue read did not fill");
  }
  const proposals =
    run.ok && input.event ? proposeTeam(run.value, await deps.teamCandidates(input.event)) : NO_TEAM_PROPOSALS;
  log().info(
    { ...runLogFields(run.facts), source: input.source.kind, eventId: input.event?.id ?? null, team: proposalCounts(proposals) },
    "ai fill run",
  );
  try {
    const from =
      input.source.kind === "inbox"
        ? conversation
          ? "the inbox conversation"
          : "the inbox confirmation message"
        : "a pasted message";
    const on = input.event ? ` for the BEO of "${input.event.title}"` : "";
    await deps.recordActivity({
      tenantId: input.event?.tenantId ?? req.userWithAccess?.tenantId ?? null,
      branchId: input.event?.branchId ?? null,
      activityType: "beo_ai_fill",
      createdBy: req.user?.id ?? null,
      summaryText: run.ok
        ? `AI Fill read ${from}${on}`
        : `AI Fill could not fill${on} from ${from} (${run.reason.replace(/_/g, " ")})`,
      metadataJson: JSON.stringify({
        eventId: input.event?.id ?? null,
        source: input.source.kind,
        ...(input.source.kind === "inbox"
          ? { inboxConversationId: input.source.conversationId, inboxMessageId: input.source.messageId }
          : {}),
        outcome: run.facts.outcome,
        model: run.facts.model,
        promptFrom: run.facts.from,
        inputChars: run.facts.inputChars,
        sections: run.ok ? filledSections(run.value) : [],
        team: proposalCounts(proposals),
        ...(conversation ? { transcriptLines: conversation.refs.length, transcriptCut: conversation.cut } : {}),
        ...(catalogueRun
          ? { catalogueRead: { outcome: catalogueRun.facts.outcome, inputChars: catalogueRun.facts.inputChars, model: catalogueRun.facts.model } }
          : {}),
        ...(proposal ? { catalogue: catalogueCounts(proposal) } : {}),
      }),
    });
  } catch (error) {
    // The fill stands; a lost row is said in the log, without the text.
    log().warn({ err: (error as Error)?.message ?? String(error) }, "the AI fill's activity row was not written");
  }
  return { run, proposals, proposal };
}

export function registerAIRoutes(app: Express, requireAuth: any, overrides: Partial<AiRouteDeps> = {}) {
  const deps: AiRouteDeps = { ...defaultAiRouteDeps, ...overrides };

  app.get("/api/ai/available-models", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!aiConfigured()) {
        return res.status(503).json({
          message: "AI is not available on this server. Ask the system administrator.",
        });
      }
      const modelsList = await getAnthropic().models.list();

      const claudeModels = modelsList.data
        .filter(m => m.id.startsWith("claude"))
        .map(m => ({
          id: m.id,
          label: m.display_name || m.id,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

      res.json({ models: claudeModels });
    } catch (error: any) {
      log().warn({ status: error?.status ?? null }, "the AI model list could not be read");
      if (error.status === 401 || error.message?.includes("API key")) {
        return res.status(503).json({
          message: "AI is not available on this server. Ask the system administrator."
        });
      }
      next(error);
    }
  });

  app.post("/api/ai/extract-event", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { notes_text, existing_form_data, branch_context } = (req.body ?? {}) as ExtractEventRequest;

      if (typeof notes_text !== "string" || !notes_text.trim()) {
        return res.status(400).json({ message: "notes_text is required" });
      }
      if (notes_text.length > AI_TEXT_MAX) {
        return res.status(400).json({ message: `The notes are too long to read at once (${AI_TEXT_MAX} characters at most).` });
      }

      const now = new Date();

      let contextInfo = "";
      if (branch_context?.branch_name) {
        contextInfo = `\nCurrently selected branch: ${branch_context.branch_name}`;
      }

      // Fetch tenant branches and build branch list for the model
      const tenantBranches = await db.select({
        id: branches.id,
        name: branches.name,
        timezone: branches.timezone,
      }).from(branches).where(eq(branches.tenantId, req.user!.tenantId));

      const branchLines = tenantBranches.map((b) => {
        const localTime = new Intl.DateTimeFormat("en-CA", {
          timeZone: b.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(now);
        const localWeekday = new Intl.DateTimeFormat("en-US", {
          timeZone: b.timezone,
          weekday: "long",
        }).format(now);
        return `- id: ${b.id} | name: ${b.name} | timezone: ${b.timezone} | current local time: ${localTime} (${localWeekday})`;
      }).join("\n");

      const branchSection = tenantBranches.length > 0
        ? `\n\nAvailable branches:\n${branchLines}`
        : "";

      const userMessage = `Extract event details from these notes:
${contextInfo}

Notes:
${notes_text}

${existing_form_data ? `\nExisting form data (use these as the baseline — carry all values forward into extracted, only updating fields that are explicitly mentioned or corrected in the notes above):\n${JSON.stringify(existing_form_data, null, 2)}` : ""}`;

      const run = await runAiHelper(
        { ...deps.ai, readSetting: (key) => deps.readSetting(req, key) },
        {
          helper: "event_extraction",
          schema: EventExtractionSchema,
          systemExtra: branchSection,
          user: userMessage,
          inputChars: notes_text.length,
        },
      );
      log().info(runLogFields(run.facts), "ai event extraction run");
      if (!run.ok) return res.status(run.status).json({ message: run.message, reason: run.reason });

      // A branch suggestion is only ever one of this park group's branches.
      const { suggested_branch_id, ...rest } = run.value;
      const suggested = suggested_branch_id && tenantBranches.some((b) => b.id === suggested_branch_id) ? suggested_branch_id : undefined;
      res.json({ ...rest, ...(suggested ? { suggested_branch_id: suggested } : {}) });
    } catch (error: any) {
      log().warn({ err: error?.message ?? String(error) }, "the AI event extraction failed");
      next(error);
    }
  });

  app.post("/api/ai/parse-beo", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = ParseBeoBodySchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ message: "Send the text to read, the form's data as an object, and the event's id." });
      const { text, existingData, eventId } = body.data;

      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ message: "text is required" });
      }
      if (text.length > AI_TEXT_MAX) {
        return res.status(400).json({ message: `The text is too long to read at once (${AI_TEXT_MAX} characters at most).` });
      }
      let event: BeoFillEvent | null = null;
      if (eventId) {
        event = await deps.loadEvent(req, eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });
      }

      const { run, proposals } = await runBeoFill(deps, req, { text, existingData, event, source: { kind: "pasted" } });
      if (!run.ok) return res.status(run.status).json({ message: run.message, reason: run.reason });
      res.json({ ...run.value, proposals });
    } catch (error: any) {
      log().warn({ err: error?.message ?? String(error) }, "the AI BEO parse failed");
      next(error);
    }
  });

  /**
   * SCRUM-660 — Create BEO's AI Fill: the inbox's Create BEO lands on this
   * event's BEO form (`?beo=<id>&fill=inbox`) and the form asks here. The
   * event must be the caller's to open, as the form's own read decides, and
   * booked from the inbox; the message is the platform's choice, read as this
   * person; the answer is the SAME preview AI Fill shows for a pasted message,
   * with the message it read beside it. Nothing is saved here: the person
   * reviews it and presses Load into Editor, which fills the form and, as AI
   * Fill always has, writes the answer's timeline lines at once; every other
   * field waits for the form's own Save.
   */
  app.post("/api/events/:eventId/beo/ai-fill/inbox", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    const refuse = (reason: InboxFillRefusal, eventId: string | null) => {
      log().info({ reason, eventId }, "ai fill from the inbox did not run");
      return res.status(INBOX_FILL_STATUS[reason]).json({ reason, message: INBOX_FILL_MESSAGES[reason] });
    };
    try {
      const body = InboxFillBodySchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ message: "Send the form's data as an object." });
      const existingData = body.data.existingData ?? undefined;
      const event = await deps.loadEvent(req, req.params.eventId!);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (!event.inboxConversationId) return refuse("not_from_inbox", event.id);

      const read = await deps.inboxConfirmation(req, event.inboxConversationId);
      if (!read.ok) return refuse(read.reason, event.id);
      const { confirmation } = read;
      if (confirmation.eventId !== event.id) return refuse("event_mismatch", event.id);
      const message = confirmation.message;
      if (!message) return refuse("no_confirmation", event.id);
      if (message.body.length > AI_TEXT_MAX) return refuse("too_long", event.id);

      // SCRUM-815: the form's own fields are read from the ruling message alone,
      // as SCRUM-660 read them. With the park's catalogue, the whole conversation
      // (the platform's transcript, the ruling message marked in it) is read
      // beside it into the catalogue section, every value naming its line. A
      // park with no catalogue, or a platform that sends no transcript, never
      // has the conversation read: the ruling message alone, as before.
      const ruling = { id: message.id, body: message.body, at: message.sentAt ?? message.createdAt };
      const catalogue = await deps.catalogue(event).catch((error: unknown) => {
        // The fill still runs, as before the catalogue: the review is the free-text preview.
        log().warn({ err: (error as Error)?.message ?? String(error), eventId: event.id }, "the park's catalogue was not read for the AI fill");
        return emptyCatalogue();
      });
      // SCRUM-814's park, read once: the prompt's today and the transcript's clock.
      const place = await deps.parkPlace(req, event);
      const transcript = confirmation.transcript ?? [];
      const transcriptCut = confirmation.transcriptCut ?? false;
      const rendered =
        transcript.length > 0 && !catalogueIsEmpty(catalogue) ? renderTranscript(transcript, ruling, place.timeZone) : null;
      const conversation = rendered ? { text: rendered.text, refs: rendered.refs, cut: rendered.cut || transcriptCut } : null;
      const rulingFrom: BeoAiFrom = conversation
        ? { source: "team", at: ruling.at, line: conversation.refs.find((r) => r.ruling)?.line ?? null }
        : { source: "team", at: ruling.at, line: null };
      const { run, proposals, proposal } = await runBeoFill(deps, req, {
        text: message.body,
        existingData,
        event,
        source: { kind: "inbox", conversationId: confirmation.conversationId, messageId: message.id },
        conversation,
        catalogue,
        fallbackFrom: rulingFrom,
        place,
      });
      if (!run.ok) return res.status(run.status).json({ message: run.message, reason: run.reason });
      // Final Message to Parent: this very message while the form's is empty;
      // a person's own one is kept, and the model's text for it never reaches the screen.
      const { fill, fillsFinalMessage } = inboxFillAnswer(run.value, message.body, existingData);
      // SCRUM-815: the proposed BEO for the review in edit mode; nothing is written until it is approved.
      const review: BeoAiReview | null = proposal
        ? {
            proposal,
            catalogue,
            finalMessage: fillsFinalMessage ? message.body : null,
            ruling: rulingFrom,
            transcript: { lines: conversation?.refs.length ?? 1, cut: conversation?.cut ?? false },
            replaces: await sectionsHeld(db, event.id),
            parentSelection: await parentSelectionOf(db, event.id),
          }
        : null;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        source: {
          conversationId: confirmation.conversationId,
          messageId: message.id,
          body: message.body,
          authorName: message.authorName,
          sentAt: message.sentAt,
          createdAt: message.createdAt,
          fillsFinalMessage,
        },
        fill: { ...fill, proposals },
        ...(review ? { review } : {}),
      });
    } catch (error: any) {
      log().warn({ err: error?.message ?? String(error) }, "the AI fill from the inbox failed");
      next(error);
    }
  });

  /**
   * SCRUM-815 — "Approve and create": the BEO the AI Fill proposed from the
   * conversation, as the reviewer left it in the review's edit mode, written
   * at once in one transaction (server/lib/beoAiApprove.ts): the package with
   * its add-ons, the kitchen plan's set menu, choices and extra dishes, the
   * bar plan's lines, the entertainment, the event's counts and times, the
   * deposit, and one activity row with the sources and the catalogue items
   * matched. A manager's write, on an event the caller may open, as the BEO's
   * own Save is; every id is checked again against the park's catalogue.
   */
  app.post("/api/events/:eventId/beo/ai-fill/approve", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = BeoAiApproveBodySchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ message: "The reviewed BEO is not in the shape the approval takes. Open the review again." });
      const event = await deps.loadEvent(req, req.params.eventId!);
      if (!event) return res.status(404).json({ message: "Event not found" });
      const outcome = await approveBeoAiFill(db, {
        event,
        userId: req.user?.id ?? null,
        body: body.data,
        now: new Date(),
        recordActivity: (entry, executor) => deps.recordActivity(entry, executor),
      });
      if (!outcome.ok) return res.status(outcome.status).json({ message: outcome.message });
      try {
        await deps.afterApprove(event.id);
      } catch (error) {
        // The BEO stands; the timeline catches up at the next Save.
        log().warn({ err: (error as Error)?.message ?? String(error), eventId: event.id }, "the BEO timeline was not generated after an AI fill approval");
      }
      log().info({ eventId: event.id, written: outcome.written }, "ai fill approved");
      res.json({ written: outcome.written });
    } catch (error: any) {
      log().warn({ err: error?.message ?? String(error) }, "the AI fill approval failed");
      next(error);
    }
  });
}
