import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "../db";
import {
  discoveryChannels,
  insertVisitorSurveyResponseSchema,
  type DiscoveryChannel,
  type InsertVisitorSurveyResponse,
  type VisitorSurveyBranch,
  type VisitorSurveyResponse,
  type VisitorType,
  visitorSurveyBranches,
  visitorSurveyResponses,
  visitorTypes,
  VISITOR_SURVEY_BRANCH_LABELS,
} from "@shared/schema";

export function isVisitorSurveyBranch(value: unknown): value is VisitorSurveyBranch {
  return typeof value === "string" && (visitorSurveyBranches as readonly string[]).includes(value);
}

export function listVisitorSurveyBranches(): Array<{ key: VisitorSurveyBranch; name: string }> {
  return visitorSurveyBranches.map((key) => ({
    key,
    name: VISITOR_SURVEY_BRANCH_LABELS[key],
  }));
}

export async function createVisitorSurveyResponse(
  data: InsertVisitorSurveyResponse,
): Promise<VisitorSurveyResponse> {
  const parsed = insertVisitorSurveyResponseSchema.parse(data);
  const [row] = await db.insert(visitorSurveyResponses).values(parsed).returning();
  return row;
}

export async function listVisitorSurveyResponsesByDay(
  date: string,
  branch?: VisitorSurveyBranch,
): Promise<VisitorSurveyResponse[]> {
  return listVisitorSurveyResponsesByDateRange(date, date, branch);
}

export async function listVisitorSurveyResponsesByDateRange(
  startDate: string,
  endDate: string,
  branch?: VisitorSurveyBranch,
): Promise<VisitorSurveyResponse[]> {
  const startUtc = new Date(`${startDate}T00:00:00+07:00`);
  const endExclusiveUtc = new Date(
    new Date(`${endDate}T00:00:00+07:00`).getTime() + 24 * 60 * 60 * 1000,
  );

  const conditions = [
    gte(visitorSurveyResponses.submittedAt, startUtc),
    lt(visitorSurveyResponses.submittedAt, endExclusiveUtc),
  ];
  if (branch) {
    conditions.push(eq(visitorSurveyResponses.branch, branch));
  }

  return db.select().from(visitorSurveyResponses).where(and(...conditions));
}

export type VisitorSurveyBucket = {
  total: number;
  visitorType: Record<VisitorType, number>;
  discoveryChannel: Record<DiscoveryChannel, number>;
};

function emptyBucket(): VisitorSurveyBucket {
  const v = {} as Record<VisitorType, number>;
  for (const t of visitorTypes) v[t] = 0;
  const c = {} as Record<DiscoveryChannel, number>;
  for (const ch of discoveryChannels) c[ch] = 0;
  return { total: 0, visitorType: v, discoveryChannel: c };
}

export type VisitorSurveyDailySummary = {
  date: string;
  endDate: string;
  branchFilter: VisitorSurveyBranch | null;
  overall: VisitorSurveyBucket;
  perBranch: Record<VisitorSurveyBranch, VisitorSurveyBucket>;
  visitorTypes: readonly VisitorType[];
  discoveryChannels: readonly DiscoveryChannel[];
  branches: Array<{ key: VisitorSurveyBranch; name: string }>;
};

export async function getVisitorSurveyDailySummary(
  date: string,
  branch?: VisitorSurveyBranch,
  endDate?: string,
): Promise<VisitorSurveyDailySummary> {
  const effectiveEnd = endDate ?? date;
  const rows = await listVisitorSurveyResponsesByDateRange(date, effectiveEnd, branch);

  const overall = emptyBucket();
  const perBranch = {} as Record<VisitorSurveyBranch, VisitorSurveyBucket>;
  for (const b of visitorSurveyBranches) perBranch[b] = emptyBucket();

  for (const r of rows) {
    overall.total++;
    overall.visitorType[r.visitorType]++;
    overall.discoveryChannel[r.discoveryChannel]++;
    const pb = perBranch[r.branch];
    if (pb) {
      pb.total++;
      pb.visitorType[r.visitorType]++;
      pb.discoveryChannel[r.discoveryChannel]++;
    }
  }

  return {
    date,
    endDate: effectiveEnd,
    branchFilter: branch ?? null,
    overall,
    perBranch,
    visitorTypes,
    discoveryChannels,
    branches: listVisitorSurveyBranches(),
  };
}
