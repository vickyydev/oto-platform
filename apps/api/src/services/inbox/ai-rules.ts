import { and, desc, eq, ne, type SQL } from 'drizzle-orm';
import { AI_INTENTS, ruleSafetyFailure } from '@oto/assistant';
import { aiRule, type AiRuleAskFirst } from '@oto/db';
import { newId, type InboxAiRule, type InboxAiRuleCreate, type InboxAiRulePatch } from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import { claimClientId, markReplay } from '../client-id';
import type { Exec, Tx } from '../tx';
import { assertBranchInOperator, KB_MANAGE, reaches, requireReach, type Reach, type SettingsCtx } from './ai-settings';

/**
 * THE ASSISTANT'S BEHAVIOUR RULES (SCRUM-696): an operator's plain
 * instruction for one of the customer assistant's intents (or `any`), and
 * optionally a question it asks first. Written from the Rules screen or saved
 * as a draft by the teach chat; only an APPROVED rule reaches the assistant.
 *
 * WHO. `inbox:kb:manage`, checked at the rule's park as a KB entry is (a
 * branch's rule at that branch, a both-parks rule operator-wide).
 *
 * WHAT A RULE MAY SAY. Only a question or an instruction that ADDS to the
 * playbook: `ruleSafetyFailure` refuses one carrying a number, a link, a date
 * or a grant (a price, a discount, free entry, a refund, compensation, a
 * booking) before anything is written — 400 RULE_UNSAFE with a sentence.
 *
 * WHAT IS RECORDED. Every write is one transaction with its audit row
 * (`inbox.ai_rule.*`), holding ids, the intent, statuses and LENGTHS — never
 * the instruction, the question or what the person typed.
 */

type RuleRow = typeof aiRule.$inferSelect;

const len = (v: string | null | undefined): number | null => (v == null ? null : [...v].length);

export const RULE_MESSAGES = {
  archived: 'This rule is archived. Write a new one instead.',
  intentNotKnown: 'That is not one of the assistant’s intents (or "any").',
  unsafe: {
    digits:
      'A rule cannot carry numbers: prices, times and dates come from the knowledge base and the live facts. Write it without digits.',
    link: 'A rule cannot carry a link. Put the link in a knowledge-base entry instead.',
    date: 'A rule cannot name a date. The team confirms dates.',
    promise:
      'A rule can only add a question or an instruction. It cannot grant or confirm a discount, free entry, a refund or compensation: the team decides those.',
    commitment:
      'A rule can only add a question or an instruction. It cannot grant or confirm a price, a discount, free entry, a refund, compensation, a date or a booking: the team decides those.',
    question:
      'The ask-first question would not pass the assistant’s own checks: one short question, no list, no numbers, links, promises or automation words. Rewrite it.',
  },
} as const;

const RULE_INTENTS: ReadonlySet<string> = new Set<string>([...AI_INTENTS, 'any']);

function ruleView(r: RuleRow, reach: Reach): InboxAiRule {
  return {
    id: r.id,
    intent: r.intent,
    branchId: r.branchId,
    instruction: r.instruction,
    askFirst: r.askFirst ?? null,
    status: r.status,
    taughtFrom: r.taughtFrom,
    source: r.source,
    approvedByAccountId: r.approvedByAccountId,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    updatedByAccountId: r.updatedByAccountId,
    canManage: reaches(reach, r.branchId),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What an audit row may say about a rule: never its words. */
function ruleAudit(r: RuleRow) {
  const q = r.askFirst?.question;
  return {
    intent: r.intent,
    branchId: r.branchId,
    status: r.status,
    source: r.source,
    askFirstCondition: r.askFirst?.condition ?? null,
    instructionLength: len(r.instruction),
    questionLengths: q ? { en: len(q.en), th: len(q.th), ru: len(q.ru) } : null,
    taughtFromLength: len(r.taughtFrom),
  };
}

function checkRuleIntent(intent: string): void {
  if (!RULE_INTENTS.has(intent)) {
    throw errors.conflict('INTENT_UNKNOWN', RULE_MESSAGES.intentNotKnown, { intents: [...AI_INTENTS, 'any'] });
  }
}

function checkRuleSafe(instruction: string, askFirst: AiRuleAskFirst | null): void {
  const f = ruleSafetyFailure({ instruction, askFirst });
  if (f) throw new AppError(400, 'RULE_UNSAFE', RULE_MESSAGES.unsafe[f.kind], { rule: f.kind });
}

/** The ask-first object as stored: only the languages it holds. */
function storedAskFirst(a: InboxAiRuleCreate['askFirst']): AiRuleAskFirst | null {
  if (!a) return null;
  return {
    condition: a.condition,
    question: {
      en: a.question.en,
      ...(a.question.th !== undefined ? { th: a.question.th } : {}),
      ...(a.question.ru !== undefined ? { ru: a.question.ru } : {}),
    },
  };
}

/** The sentence the person typed, as the CHECK holds it: trimmed, at most 2000 characters, never empty. */
function taughtFromOf(text: string | null): string | null {
  if (text === null) return null;
  const cut = [...text.trim()].slice(0, 2000).join('');
  return cut === '' ? null : cut;
}

const sameAskFirst = (a: AiRuleAskFirst | null, b: AiRuleAskFirst | null) => JSON.stringify(a) === JSON.stringify(b);

export async function listRules(
  db: Exec,
  operatorId: string,
  reach: Reach,
  query: { status?: string },
): Promise<{ rules: InboxAiRule[] }> {
  const where: SQL[] = [eq(aiRule.operatorId, operatorId)];
  if (query.status) where.push(eq(aiRule.status, query.status as RuleRow['status']));
  else where.push(ne(aiRule.status, 'archived'));
  const rows = await db
    .select()
    .from(aiRule)
    .where(and(...where))
    .orderBy(desc(aiRule.createdAt), desc(aiRule.id));
  return { rules: rows.map((r) => ruleView(r, reach)) };
}

/** A rule of this operator by id; 404 for anyone else's. */
export async function loadRule(db: Exec, operatorId: string, id: string, lock = false): Promise<RuleRow> {
  const q = db
    .select()
    .from(aiRule)
    .where(and(eq(aiRule.operatorId, operatorId), eq(aiRule.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw errors.notFound('Rule not found');
  return row;
}

/** A new rule, always a draft. `origin` says whether the teach chat saved it, and what the person typed. */
export async function createRule(
  tx: Tx,
  ctx: SettingsCtx,
  reach: Reach,
  input: InboxAiRuleCreate,
  origin: { source: 'teach' | 'manual'; taughtFrom: string | null } = { source: 'manual', taughtFrom: null },
): Promise<InboxAiRule> {
  const branchId = input.branchId ?? null;
  const claim = await claimClientId(
    input.id,
    async (id) => (await tx.select().from(aiRule).where(eq(aiRule.id, id)).limit(1))[0],
    (row) => row.operatorId === ctx.operatorId && row.intent === input.intent,
  );
  if (claim.replay) return markReplay(ruleView(claim.row, reach));
  requireReach(reach, branchId, KB_MANAGE);
  await assertBranchInOperator(tx, ctx.operatorId, branchId);
  checkRuleIntent(input.intent);
  const askFirst = storedAskFirst(input.askFirst);
  checkRuleSafe(input.instruction, askFirst);
  const [made] = await tx
    .insert(aiRule)
    .values({
      id: claim.id,
      operatorId: ctx.operatorId,
      branchId,
      intent: input.intent,
      instruction: input.instruction,
      askFirst,
      status: 'draft',
      taughtFrom: taughtFromOf(origin.taughtFrom),
      source: origin.source,
      updatedByAccountId: ctx.accountId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.create',
    entityType: 'inbox.ai_rule',
    entityId: made!.id,
    operatorId: ctx.operatorId,
    branchId,
    requestId: ctx.requestId,
    after: ruleAudit(made!),
  });
  return ruleView(made!, reach);
}

/**
 * Edit a rule, as `updateKb` edits an entry: a DRAFT is changed in place; an
 * APPROVED rule is revised (the old row archived with its words kept, a new
 * row inserted already approved by the editor, under a new id that the
 * answer carries). An archived rule is not edited: 409 RULE_ARCHIVED.
 */
export async function updateRule(
  tx: Tx,
  ctx: SettingsCtx,
  reach: Reach,
  id: string,
  patch: InboxAiRulePatch,
): Promise<InboxAiRule> {
  const before = await loadRule(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status === 'archived') throw errors.conflict('RULE_ARCHIVED', RULE_MESSAGES.archived);
  const next = {
    branchId: patch.branchId === undefined ? before.branchId : patch.branchId,
    intent: patch.intent ?? before.intent,
    instruction: patch.instruction ?? before.instruction,
    askFirst: patch.askFirst === undefined ? (before.askFirst ?? null) : storedAskFirst(patch.askFirst),
  };
  requireReach(reach, next.branchId, KB_MANAGE);
  await assertBranchInOperator(tx, ctx.operatorId, next.branchId);
  checkRuleIntent(next.intent);
  checkRuleSafe(next.instruction, next.askFirst);
  const changed = {
    instructionChanged: next.instruction !== before.instruction,
    askFirstChanged: !sameAskFirst(next.askFirst, before.askFirst ?? null),
  };
  if (before.status === 'approved') return reviseApprovedRule(tx, ctx, reach, before, next, changed);
  const [after] = await tx
    .update(aiRule)
    .set({ ...next, updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(aiRule.operatorId, ctx.operatorId), eq(aiRule.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.update',
    entityType: 'inbox.ai_rule',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: after!.branchId,
    requestId: ctx.requestId,
    before: ruleAudit(before),
    after: { ...ruleAudit(after!), ...changed },
  });
  return ruleView(after!, reach);
}

/**
 * The approved half of `updateRule` (as `reviseApprovedKb`): the old row
 * archived, its words kept; the new row inserted approved by the editor,
 * carrying the old row's source and taught-from line. Two audit rows, neither
 * holding the words: `inbox.ai_rule.archive` on the old row naming its
 * replacement, `inbox.ai_rule.revise` on the new row naming what it replaced.
 */
async function reviseApprovedRule(
  tx: Tx,
  ctx: SettingsCtx,
  reach: Reach,
  before: RuleRow,
  next: { branchId: string | null; intent: string; instruction: string; askFirst: AiRuleAskFirst | null },
  changed: { instructionChanged: boolean; askFirstChanged: boolean },
): Promise<InboxAiRule> {
  const replacementId = newId();
  const [retired] = await tx
    .update(aiRule)
    .set({ status: 'archived', updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(aiRule.operatorId, ctx.operatorId), eq(aiRule.id, before.id)))
    .returning();
  const [made] = await tx
    .insert(aiRule)
    .values({
      id: replacementId,
      operatorId: ctx.operatorId,
      branchId: next.branchId,
      intent: next.intent,
      instruction: next.instruction,
      askFirst: next.askFirst,
      status: 'approved',
      taughtFrom: before.taughtFrom,
      source: before.source,
      updatedByAccountId: ctx.accountId,
      approvedByAccountId: ctx.accountId,
      approvedAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.archive',
    entityType: 'inbox.ai_rule',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { status: before.status },
    after: { ...ruleAudit(retired!), replacedById: replacementId },
  });
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.revise',
    entityType: 'inbox.ai_rule',
    entityId: replacementId,
    operatorId: ctx.operatorId,
    branchId: made!.branchId,
    requestId: ctx.requestId,
    before: { ...ruleAudit(before), id: before.id },
    after: { ...ruleAudit(made!), approvedByAccountId: ctx.accountId, replacesId: before.id, ...changed },
  });
  return ruleView(made!, reach);
}

/** Draft → approved: the approver and the time recorded (`ai_rule_approved_check`). Approving twice is the same act. */
export async function approveRule(tx: Tx, ctx: SettingsCtx, reach: Reach, id: string): Promise<InboxAiRule> {
  const before = await loadRule(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status === 'archived') throw errors.conflict('RULE_ARCHIVED', RULE_MESSAGES.archived);
  if (before.status === 'approved') return ruleView(before, reach);
  const [after] = await tx
    .update(aiRule)
    .set({ status: 'approved', approvedByAccountId: ctx.accountId, approvedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(aiRule.operatorId, ctx.operatorId), eq(aiRule.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.approve',
    entityType: 'inbox.ai_rule',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { status: before.status },
    after: { ...ruleAudit(after!), approvedByAccountId: ctx.accountId },
  });
  return ruleView(after!, reach);
}

/** Retire a rule: it leaves the assistant. Never deleted. Archiving twice is the same act. */
export async function archiveRule(tx: Tx, ctx: SettingsCtx, reach: Reach, id: string): Promise<InboxAiRule> {
  const before = await loadRule(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status === 'archived') return ruleView(before, reach);
  const [after] = await tx
    .update(aiRule)
    .set({ status: 'archived', updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(aiRule.operatorId, ctx.operatorId), eq(aiRule.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_rule.archive',
    entityType: 'inbox.ai_rule',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { status: before.status },
    after: ruleAudit(after!),
  });
  return ruleView(after!, reach);
}
