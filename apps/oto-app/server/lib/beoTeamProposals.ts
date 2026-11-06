import { and, eq } from "drizzle-orm";
import { departmentBranchAssignments, departments, employees } from "../../shared/schema";
import type { db as appDb } from "../db";
import type { BeoFill } from "./aiFill";

/**
 * THE TEAM AN AI FILL PROPOSES (SCRUM-660).
 *
 * Only where the BEO already has an assignment field: the Party Host and the
 * Entertainment Host (a person) and the setup plan's Who (a person or a
 * department, else typed text). A person is proposed only when the message
 * names them or their role AND that name is exactly one real person — or, for
 * Who, one department — of the event's park. Anything else stays as the
 * message wrote it, flagged in the preview: the model's words are never turned
 * into somebody by a guess, and no rule of who does what is applied here.
 *
 * The match is plain: the same letters, ignoring case, spacing, punctuation
 * around the name and a trailing "team" or "department". A name that fits two
 * people is not a match.
 */

export interface TeamCandidate {
  id: string;
  /** Every name the person is known by here: nickname, full name, Thai name. */
  names: string[];
  /** What the BEO editor shows for them: "Nok (Siriporn Sae-Lim)", or the full name. */
  label: string;
}

export interface TeamCandidates {
  /** Active employees whose park is the event's. Empty when the app lists users as hosts instead. */
  employees: TeamCandidate[];
  /** Active departments assigned to the event's park. */
  departments: TeamCandidate[];
  /**
   * Where the editor's host fields pick from (`GET /api/beo/party-hosts`):
   * employees, or users when the park group has no active employee. A host is
   * proposed only on the employee list, the one the matching reads.
   */
  hostSource: "employee" | "user";
}

export type TeamMatch = { kind: "employee" | "department"; id: string; label: string };

export interface TeamProposal {
  /** The name or role as the message wrote it. */
  asked: string;
  /** The one person (or department) of the park it names, or null. */
  match: TeamMatch | null;
  /** Why there is no match: nobody of this park, several, or the field picks from another list. */
  why: "no_match" | "several" | "same_as_party_host" | "host_list_not_employees" | null;
}

export interface TeamProposals {
  partyHost: TeamProposal | null;
  entertainmentHost: TeamProposal | null;
  setupResponsible: TeamProposal | null;
}

export const NO_TEAM_PROPOSALS: TeamProposals = { partyHost: null, entertainmentHost: null, setupResponsible: null };

/** Lower case, one space, no punctuation around the name, no trailing "team"/"department". */
export function normaliseName(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/^[\s"'“”«»@(\[\-:.,]+|[\s"'“”«»)\]\-:.,!]+$/g, "")
    .replace(/\s+(team|department|dept|команда|отдел|ทีม|แผนก)$/u, "")
    .trim();
}

function find(asked: string, candidates: TeamCandidate[], kind: TeamMatch["kind"]): TeamMatch[] {
  const wanted = normaliseName(asked);
  if (!wanted) return [];
  // The editor's own label ("Nok (Siriporn Sae-Lim)") names the person too.
  const labelled = /^(.+?)\s*\((.+)\)$/.exec(asked.trim());
  const wantedLabel = labelled ? [normaliseName(labelled[1]!), normaliseName(labelled[2]!)] : null;
  return candidates
    .filter((c) => {
      const names = c.names.map(normaliseName).filter(Boolean);
      if (names.includes(wanted)) return true;
      return wantedLabel !== null && wantedLabel.every((part) => names.includes(part));
    })
    .map((c) => ({ kind, id: c.id, label: c.label }));
}

function propose(asked: string | undefined, pools: Array<[TeamCandidate[], TeamMatch["kind"]]>): TeamProposal | null {
  const name = asked?.trim();
  if (!name) return null;
  const found = pools.flatMap(([pool, kind]) => find(name, pool, kind));
  if (found.length === 1) return { asked: name, match: found[0]!, why: null };
  return { asked: name, match: null, why: found.length > 1 ? "several" : "no_match" };
}

/** The proposals for one fill: what the message named, matched against the park's people. */
export function proposeTeam(fill: Pick<BeoFill, "team" | "setupPlan">, candidates: TeamCandidates): TeamProposals {
  const hostPools: Array<[TeamCandidate[], TeamMatch["kind"]]> = [[candidates.employees, "employee"]];
  const host = (asked: string | undefined): TeamProposal | null => {
    const proposal = propose(asked, hostPools);
    if (proposal && candidates.hostSource === "user") return { asked: proposal.asked, match: null, why: "host_list_not_employees" };
    return proposal;
  };
  const partyHost = host(fill.team?.partyHost);
  let entertainmentHost = host(fill.team?.entertainmentHost);
  // The editor never offers the party host as the entertainment host.
  if (entertainmentHost?.match && partyHost?.match && entertainmentHost.match.id === partyHost.match.id) {
    entertainmentHost = { asked: entertainmentHost.asked, match: null, why: "same_as_party_host" };
  }
  const setupResponsible = propose(fill.setupPlan?.responsible, [
    [candidates.employees, "employee"],
    [candidates.departments, "department"],
  ]);
  return { partyHost, entertainmentHost, setupResponsible };
}

/** Counts for the activity row: how many names the message gave, and how many matched. */
export function proposalCounts(p: TeamProposals): { named: number; matched: number } {
  const all = [p.partyHost, p.entertainmentHost, p.setupResponsible].filter((x): x is TeamProposal => x !== null);
  return { named: all.length, matched: all.filter((x) => x.match !== null).length };
}

/**
 * The people a fill may propose for an event: the park group's active
 * employees at the event's park, and the departments assigned to it. Whether
 * the host fields list employees at all is read as `GET /api/beo/party-hosts`
 * reads it: any active employee in the park group.
 */
export async function loadTeamCandidates(
  db: typeof appDb,
  event: { tenantId: string; branchId: string | null },
): Promise<TeamCandidates> {
  if (!event.branchId) return { employees: [], departments: [], hostSource: "employee" };
  const anyEmployee = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.tenantId, event.tenantId), eq(employees.employmentState, "ACTIVE")))
    .limit(1);
  const atPark = await db
    .select({ id: employees.id, fullName: employees.fullName, nickname: employees.nickname, thaiName: employees.thaiName })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, event.tenantId),
        eq(employees.employmentState, "ACTIVE"),
        eq(employees.branchId, event.branchId),
      ),
    );
  const depts = await db
    .selectDistinct({ id: departments.id, name: departments.name })
    .from(departments)
    .innerJoin(departmentBranchAssignments, eq(departmentBranchAssignments.departmentId, departments.id))
    .where(
      and(
        eq(departments.tenantId, event.tenantId),
        eq(departments.isActive, true),
        eq(departmentBranchAssignments.branchId, event.branchId),
      ),
    );
  return {
    hostSource: anyEmployee.length > 0 ? "employee" : "user",
    employees: atPark.map((e) => ({
      id: e.id,
      names: [e.nickname, e.fullName, e.thaiName].filter((n): n is string => typeof n === "string" && n.trim() !== ""),
      label: e.nickname ? `${e.nickname} (${e.fullName})` : e.fullName,
    })),
    departments: depts.map((d) => ({ id: d.id, names: [d.name], label: `${d.name} (Dept)` })),
  };
}
