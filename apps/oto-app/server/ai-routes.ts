import { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { branches, coreEvents } from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { storage, type ActivityLogInput } from "./storage";
import { canUserAccessBranch } from "./auth-middleware";
import { log } from "./lib/logger";
import { aiComplete, aiConfigured, getAnthropic } from "./lib/anthropic";
import {
  AI_TEXT_MAX,
  BeoFillSchema,
  EventExtractionSchema,
  beoParseUserMessage,
  runAiHelper,
  runLogFields,
  type AiDeps,
  type AiRun,
  type BeoFill,
} from "./lib/aiFill";
import {
  NO_TEAM_PROPOSALS,
  loadTeamCandidates,
  proposalCounts,
  proposeTeam,
  type TeamCandidates,
  type TeamProposals,
} from "./lib/beoTeamProposals";

interface ExtractEventRequest {
  notes_text: string;
  existing_form_data?: Record<string, unknown>;
  branch_context?: { branch_id: string; branch_name: string };
  timezone?: string;
}

interface ParseBeoRequest {
  text: string;
  existingData?: Record<string, unknown>;
  /** The event whose BEO is open: its park's team is what a fill may propose, and the activity row names it. */
  eventId?: string;
}

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
  recordActivity: (entry: ActivityLogInput) => Promise<unknown>;
}

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
  recordActivity: (entry) => storage.createActivityLog(entry),
};

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
    text: string;
    existingData?: unknown;
    event: BeoFillEvent | null;
    source: { kind: "pasted" } | { kind: "inbox"; conversationId: string; messageId: string };
  },
): Promise<{ run: AiRun<BeoFill>; proposals: TeamProposals }> {
  const run = await runAiHelper(
    { ...deps.ai, readSetting: (key) => deps.readSetting(req, key) },
    {
      helper: "beo_parsing",
      schema: BeoFillSchema,
      user: beoParseUserMessage(input.text, input.existingData),
      inputChars: input.text.length,
    },
  );
  const proposals =
    run.ok && input.event ? proposeTeam(run.value, await deps.teamCandidates(input.event)) : NO_TEAM_PROPOSALS;
  log().info(
    { ...runLogFields(run.facts), source: input.source.kind, eventId: input.event?.id ?? null, team: proposalCounts(proposals) },
    "ai fill run",
  );
  try {
    const from = input.source.kind === "inbox" ? "the inbox confirmation message" : "a pasted message";
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
      }),
    });
  } catch (error) {
    // The fill stands; a lost row is said in the log, without the text.
    log().warn({ err: (error as Error)?.message ?? String(error) }, "the AI fill's activity row was not written");
  }
  return { run, proposals };
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
      const { text, existingData, eventId } = (req.body ?? {}) as ParseBeoRequest;

      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ message: "text is required" });
      }
      if (text.length > AI_TEXT_MAX) {
        return res.status(400).json({ message: `The text is too long to read at once (${AI_TEXT_MAX} characters at most).` });
      }
      let event: BeoFillEvent | null = null;
      if (eventId !== undefined && eventId !== null) {
        event = typeof eventId === "string" ? await deps.loadEvent(req, eventId) : null;
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
}
