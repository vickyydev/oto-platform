import { and, eq } from 'drizzle-orm';
import { branch, gateMessageSetting, gateMessageText } from '@oto/db';
import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_DEFAULT_LANGUAGES,
  GATE_MESSAGE_LABEL_MAX,
  GATE_MESSAGE_LABELS,
  GATE_MESSAGE_LANGS,
  GATE_MESSAGE_TEXT_MAX,
  cleanGateText,
  defaultGateMessages,
  newId,
  type GateMessageCase,
  type GateMessageLabel,
  type GateMessageLang,
  type GateMessageTexts,
  type GateMessagesRead,
  type GateMessagesWrite,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-1078 — what the gate readers say at one park, per case and language.
 *
 * Only what differs from the built-in wording (`@oto/shared/gate-messages.ts`)
 * is stored, so a park nobody has edited reads back the defaults and its gate
 * box is sent nothing new (`gateMessagesForBox`). Wording only: nothing here is
 * read by the gate's decision.
 */

type Kind = 'case' | 'label';

interface Stored {
  texts: GateMessageTexts;
  /** Rows plus the language setting, when it is stored. */
  changed: number;
  updatedAt: Date | null;
  /** What is stored, as `kind:key:lang` → text, plus `languages`; for the audit row. */
  overrides: Record<string, string>;
}

const isLang = (value: string): value is GateMessageLang =>
  (GATE_MESSAGE_LANGS as readonly string[]).includes(value);
const isCase = (value: string): value is GateMessageCase =>
  (GATE_MESSAGE_CASES as readonly string[]).includes(value);
const isLabel = (value: string): value is GateMessageLabel =>
  (GATE_MESSAGE_LABELS as readonly string[]).includes(value);

async function readStored(db: Exec, branchId: string): Promise<Stored> {
  const texts = defaultGateMessages();
  const overrides: Record<string, string> = {};
  let changed = 0;
  let updatedAt: Date | null = null;
  const later = (at: Date) => {
    if (!updatedAt || at > updatedAt) updatedAt = at;
  };
  const rows = await db.select().from(gateMessageText).where(eq(gateMessageText.branchId, branchId));
  for (const row of rows) {
    // A key or language this release does not know (a later release wrote it)
    // is kept in the table and left out of the answer.
    if (!isLang(row.lang)) continue;
    if (row.kind === 'case' && isCase(row.key)) texts.cases[row.key][row.lang] = row.text;
    else if (row.kind === 'label' && isLabel(row.key)) texts.labels[row.key][row.lang] = row.text;
    else continue;
    overrides[`${row.kind}:${row.key}:${row.lang}`] = row.text;
    changed += 1;
    later(row.updatedAt);
  }
  const [setting] = await db
    .select()
    .from(gateMessageSetting)
    .where(eq(gateMessageSetting.branchId, branchId))
    .limit(1);
  if (setting) {
    const languages = setting.languages.filter(isLang);
    if (languages.length) {
      texts.languages = languages;
      overrides.languages = languages.join(',');
      changed += 1;
      later(setting.updatedAt);
    }
  }
  return { texts, changed, updatedAt, overrides };
}

function answer(branchId: string, stored: Stored): GateMessagesRead {
  return {
    branchId,
    texts: stored.texts,
    defaults: defaultGateMessages(),
    changed: stored.changed,
    updatedAt: stored.updatedAt ? (stored.updatedAt as Date).toISOString() : null,
  };
}

export async function readGateMessages(db: Exec, branchId: string): Promise<GateMessagesRead> {
  return answer(branchId, await readStored(db, branchId));
}

/**
 * What a gate box at this park is sent, or null when the park has changed
 * nothing: the box then keeps its built-in wording, exactly as before.
 */
export async function gateMessagesForBox(db: Exec, branchId: string): Promise<GateMessageTexts | null> {
  const stored = await readStored(db, branchId);
  return stored.changed > 0 ? stored.texts : null;
}

function tooLong(kind: Kind, key: string, lang: string, max: number): AppError {
  return new AppError(
    400,
    'GATE_MESSAGE_TOO_LONG',
    `The ${lang} ${kind === 'case' ? 'text' : 'label'} for ${key} is longer than ${max} characters`,
    { kind, key, lang, max },
  );
}

/**
 * Make the park's wording what `body` says. Every entry is cleaned
 * (`cleanGateText`); an entry equal to the built-in wording is not stored, so
 * sending a default back is "Reset to default". One audit row carries what was
 * stored before and after.
 */
export async function saveGateMessages(
  tx: Tx,
  input: {
    operatorId: string;
    branchId: string;
    accountId: string;
    requestId: string;
    body: GateMessagesWrite;
  },
): Promise<GateMessagesRead> {
  const { operatorId, branchId, accountId, body } = input;
  const defaults = defaultGateMessages();
  const before = await readStored(tx, branchId);

  const wanted = new Map<string, { kind: Kind; key: string; lang: GateMessageLang; text: string }>();
  const take = (kind: Kind, key: string, lang: GateMessageLang, raw: string) => {
    const max = kind === 'case' ? GATE_MESSAGE_TEXT_MAX : GATE_MESSAGE_LABEL_MAX;
    const text = cleanGateText(raw, kind === 'label');
    if (text.length > max) throw tooLong(kind, key, lang, max);
    const builtIn = kind === 'case' ? defaults.cases[key as GateMessageCase][lang] : defaults.labels[key as GateMessageLabel][lang];
    if (text !== builtIn) wanted.set(`${kind}:${key}:${lang}`, { kind, key, lang, text });
  };
  for (const [key, byLang] of Object.entries(body.cases ?? {})) {
    if (!isCase(key) || !byLang) continue;
    for (const [lang, raw] of Object.entries(byLang)) if (isLang(lang) && typeof raw === 'string') take('case', key, lang, raw);
  }
  for (const [key, byLang] of Object.entries(body.labels ?? {})) {
    if (!isLabel(key) || !byLang) continue;
    for (const [lang, raw] of Object.entries(byLang)) if (isLang(lang) && typeof raw === 'string') take('label', key, lang, raw);
  }

  // What is stored and no longer wanted goes, what is wanted and differs is written.
  const existing = await tx.select().from(gateMessageText).where(eq(gateMessageText.branchId, branchId));
  const now = new Date();
  for (const row of existing) {
    const id = `${row.kind}:${row.key}:${row.lang}`;
    // Rows a later release wrote, for a key this one does not know, are left alone.
    const known = isLang(row.lang) && ((row.kind === 'case' && isCase(row.key)) || (row.kind === 'label' && isLabel(row.key)));
    if (!known) continue;
    const next = wanted.get(id);
    if (!next) {
      await tx.delete(gateMessageText).where(eq(gateMessageText.id, row.id));
    } else {
      if (next.text !== row.text) {
        await tx
          .update(gateMessageText)
          .set({ text: next.text, updatedByAccountId: accountId, updatedAt: now })
          .where(eq(gateMessageText.id, row.id));
      }
      wanted.delete(id);
    }
  }
  for (const row of wanted.values()) {
    await tx.insert(gateMessageText).values({
      id: newId(),
      operatorId,
      branchId,
      kind: row.kind,
      key: row.key,
      lang: row.lang,
      text: row.text,
      updatedByAccountId: accountId,
    });
  }

  const languages = body.languages;
  const isDefault =
    languages.length === GATE_MESSAGE_DEFAULT_LANGUAGES.length &&
    languages.every((lang, i) => lang === GATE_MESSAGE_DEFAULT_LANGUAGES[i]);
  if (isDefault) {
    await tx.delete(gateMessageSetting).where(eq(gateMessageSetting.branchId, branchId));
  } else {
    const [held] = await tx
      .select()
      .from(gateMessageSetting)
      .where(and(eq(gateMessageSetting.branchId, branchId), eq(gateMessageSetting.operatorId, operatorId)))
      .limit(1);
    if (held) {
      if (held.languages.join(',') !== languages.join(',')) {
        await tx
          .update(gateMessageSetting)
          .set({ languages: [...languages], updatedByAccountId: accountId, updatedAt: now })
          .where(eq(gateMessageSetting.id, held.id));
      }
    } else {
      await tx.insert(gateMessageSetting).values({
        id: newId(),
        operatorId,
        branchId,
        languages: [...languages],
        updatedByAccountId: accountId,
      });
    }
  }

  const after = await readStored(tx, branchId);
  await audit.record(tx, {
    actorAccountId: accountId,
    operatorId,
    branchId,
    action: 'gate_message.update',
    entityType: 'gate_messages',
    entityId: branchId,
    before: { changed: before.changed, stored: before.overrides },
    after: { changed: after.changed, stored: after.overrides },
    requestId: input.requestId,
  });
  return answer(branchId, after);
}

/** The branch, inside the caller's operator; another operator's id reads as not found. */
export async function assertBranchInOperator(db: Exec, operatorId: string, branchId: string): Promise<void> {
  const [row] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'BRANCH_NOT_FOUND', 'No such branch');
}
