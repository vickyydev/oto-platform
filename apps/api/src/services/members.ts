import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { account, child, employee, member, memberTierVerification, type Db } from '@oto/db';

/**
 * The member register — browsing the list, which is not the same act as
 * identifying the visitor standing at the counter (SCRUM-246).
 *
 * It lives in its own service, and not beside the single-member view in
 * `routes/members.ts`, for one reason: the leak it closes came from the list
 * reusing that view. `GET /members` called `memberWithChildren` per row, so
 * one request with no search term answered with every member the park has and
 * every child's allergies and medical notes — on `pos:member:read`, which
 * every till session holds all day.
 *
 * The queries below select columns by name and never name a medical one, so a
 * register row cannot carry child health data even if somebody later widens
 * the row shape by habit. What a child's allergies are stays on the
 * single-member read, which reception reaches by phone, one visitor at a time.
 */

/** Matches the page size the register list answered with before paging. */
export const REGISTER_PAGE_DEFAULT = 50;
export const REGISTER_PAGE_MAX = 200;

/** The document stays valid through the whole expiry DAY it names. */
export function isEvidenceExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() + 24 * 60 * 60 * 1000;
}

/**
 * A child on a register row: who they are, not how they are.
 *
 * Enough to see that a member has three children aged 4, 6 and 9 — which is
 * what a register is for — and nothing a first-aider would need, which is what
 * the single-member read is for.
 */
export interface RegisterChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
}

export interface RegisterRow {
  id: string;
  phone: string;
  nickname: string;
  name: string | null;
  email: string | null;
  tierCode: string;
  preferredChannel: string | null;
  notes: string | null;
  tierVerification: {
    tier: string;
    proofType: string;
    verifiedAt: string;
    verifiedBy: string | null;
    expiresAt: string | null;
  } | null;
  childCount: number;
  children: RegisterChild[];
}

export interface RegisterPage {
  members: RegisterRow[];
  /** Rows matching the filter, not rows on this page. */
  total: number;
  limit: number;
  offset: number;
}

/**
 * `%` and `_` are ILIKE wildcards, so an unescaped search term is a way to
 * ask for everything while looking like a search: `q=%` matched every member.
 * Backslash is Postgres's default ILIKE escape character.
 */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listRegister(
  db: Db,
  input: { operatorId: string; q?: string | undefined; limit: number; offset: number },
): Promise<RegisterPage> {
  const clauses: SQL[] = [eq(member.operatorId, input.operatorId), isNull(member.archivedAt)];
  const term = input.q?.trim();
  if (term) {
    const pattern = likeTerm(term);
    const match = or(
      ilike(member.nickname, pattern),
      ilike(member.phone, pattern),
      ilike(member.name, pattern),
    );
    if (match) clauses.push(match);
  }
  const where = and(...clauses);

  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(where);
  const total = counted?.n ?? 0;

  const rows = await db
    .select({
      id: member.id,
      phone: member.phone,
      nickname: member.nickname,
      name: member.name,
      email: member.email,
      tierCode: member.tierCode,
      preferredChannel: member.preferredChannel,
      notes: member.notes,
    })
    .from(member)
    .where(where)
    // Ordered by something stable, because a page is only meaningful against a
    // fixed order: nickname to read by, id to break the ties nicknames leave.
    .orderBy(asc(member.nickname), asc(member.id))
    .limit(input.limit)
    .offset(input.offset);

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    return { members: [], total, limit: input.limit, offset: input.offset };
  }

  // Identity only. The medical columns are not in this select and must not be:
  // see the note at the top of the file.
  const children = await db
    .select({
      id: child.id,
      memberId: child.memberId,
      name: child.name,
      dateOfBirth: child.dateOfBirth,
      ageYears: child.ageYears,
    })
    .from(child)
    .where(and(inArray(child.memberId, ids), isNull(child.archivedAt)))
    .orderBy(asc(child.name));

  const verifications = await db
    .select({
      memberId: memberTierVerification.memberId,
      toTier: memberTierVerification.toTier,
      evidenceType: memberTierVerification.evidenceType,
      evidenceExpiresAt: memberTierVerification.evidenceExpiresAt,
      createdAt: memberTierVerification.createdAt,
      staffPhone: account.phone,
      staffName: employee.name,
    })
    .from(memberTierVerification)
    .leftJoin(account, eq(memberTierVerification.verifiedByAccountId, account.id))
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(inArray(memberTierVerification.memberId, ids))
    .orderBy(desc(memberTierVerification.createdAt));

  const childrenByMember = new Map<string, RegisterChild[]>();
  for (const c of children) {
    const list = childrenByMember.get(c.memberId) ?? [];
    list.push({ id: c.id, name: c.name, dateOfBirth: c.dateOfBirth, ageYears: c.ageYears });
    childrenByMember.set(c.memberId, list);
  }

  // Newest first, so the first row seen for a member is its current document.
  const latest = new Map<string, (typeof verifications)[number]>();
  for (const v of verifications) if (!latest.has(v.memberId)) latest.set(v.memberId, v);

  return {
    members: rows.map((r) => {
      const kids = childrenByMember.get(r.id) ?? [];
      const v = latest.get(r.id);
      // An expired document no longer entitles the discounted rate, and the
      // register hides it exactly as the single-member read does.
      const active = v && !isEvidenceExpired(v.evidenceExpiresAt) ? v : null;
      return {
        ...r,
        tierVerification: active
          ? {
              tier: active.toTier,
              proofType: active.evidenceType,
              verifiedAt: active.createdAt.toISOString(),
              verifiedBy: active.staffName ?? active.staffPhone ?? null,
              expiresAt: active.evidenceExpiresAt?.toISOString().slice(0, 10) ?? null,
            }
          : null,
        childCount: kids.length,
        children: kids,
      };
    }),
    total,
    limit: input.limit,
    offset: input.offset,
  };
}
