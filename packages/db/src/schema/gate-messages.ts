import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- What the gate readers say (schema `core`) -------------------------------
//
// SCRUM-1078. A park's own wording for the gate readers' screen, per case and
// language (`@oto/shared/gate-messages.ts` holds the cases, the labels and the
// built-in wording). Beside the fleet in `core`: it is configuration of the
// gates, read by the Console and sent to a gate box in its config bundle.
//
// **Only what differs from the built-in wording is stored.** A park with no
// rows shows exactly what the gate showed before this table, and its gate box
// is sent nothing new. Putting a text back to its default removes its row;
// what it said before is in the audit log (`gate_message.update`), which is
// where this table's history lives. Wording, not a business record: nothing
// here decides whether a gate opens.

/** One changed text: a case's text or a label, in one language, at one park. */
export const gateMessageText = core.table(
  'gate_message_text',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** `case`: a case's text (`GATE_MESSAGE_CASES`); `label`: a small word (`GATE_MESSAGE_LABELS`). */
    kind: text('kind').$type<'case' | 'label'>().notNull(),
    /** The case or label key. Checked against the lists at the API boundary, so a new case needs no migration. */
    key: text('key').notNull(),
    /** One of `GATE_MESSAGE_LANGS`. */
    lang: text('lang').notNull(),
    /** As cleaned by `cleanGateText`; may be empty, which hides that language for the case. */
    text: text('text').notNull(),
    updatedByAccountId: uuid('updated_by_account_id').references(() => account.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('gate_message_text_operator_idx').on(t.operatorId),
    index('gate_message_text_updated_by_idx').on(t.updatedByAccountId),
    /** One text per (park, case or label, language): the park's set is read by its leading column. */
    uniqueIndex('gate_message_text_unique').on(t.branchId, t.kind, t.key, t.lang),
    check('gate_message_text_kind_check', sql`${t.kind} in ('case','label')`),
    check('gate_message_text_lang_check', sql`${t.lang} in ('en','zh','th','ru','fr')`),
    check('gate_message_text_length_check', sql`char_length(${t.text}) <= 200`),
  ],
);

/**
 * A park's "Languages shown on the gate", in order. No row: English, then
 * Thai (`GATE_MESSAGE_DEFAULT_LANGUAGES`).
 */
export const gateMessageSetting = core.table(
  'gate_message_setting',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    languages: text('languages').array().notNull(),
    updatedByAccountId: uuid('updated_by_account_id').references(() => account.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('gate_message_setting_operator_idx').on(t.operatorId),
    index('gate_message_setting_updated_by_idx').on(t.updatedByAccountId),
    uniqueIndex('gate_message_setting_branch_unique').on(t.branchId),
    check(
      'gate_message_setting_languages_check',
      sql`cardinality(${t.languages}) between 1 and 5 and ${t.languages} <@ array['en','zh','th','ru','fr']::text[]`,
    ),
  ],
);
