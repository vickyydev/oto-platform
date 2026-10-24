/**
 * THE INBOX'S CONFIGURATION, laid by platform-sync (S2-19 I1, SCRUM-578).
 *
 * Plan: docs/progress/plans/inbox-build/PLAN.md §1 "Roles" and "Seed". What
 * an operator needs before the Inbox can route a single message:
 *
 *   - the three inbox roles (`inbox_agent`, `inbox_manager`, `inbox_admin`),
 *     as the operator's own roles;
 *   - the two operator-wide departments the Birthdays & Events and Marketing
 *     teams map onto, and a `reception` department at any live branch that
 *     has none (the seeded parks already have theirs, and reuse it);
 *   - the teams: Birthdays & Events, Marketing, and Reception per branch;
 *   - the routing rules for the IT Brief's defaults, every person BLANK
 *     (`primary_kind = 'team'`, owner Q20), plus one catch-all per team so
 *     routing can never leave a conversation unowned;
 *   - the ten template keys (`handover_general` joined with SCRUM-590,
 *     `follow_up` with the SCRUM-220 test night) in English, Thai and
 *     Russian, each language in its own words — and the one UPDATE this file
 *     makes: a TH or RU row that still carries the English source marked
 *     `needs_translation` (as every operator synced before the test night
 *     has) takes its translation, see `backfillTranslations`;
 *   - one `console` channel account per notice channel (WhatsApp, LINE,
 *     Telegram) — the sender the check-in confirmation already goes through,
 *     which can never reply.
 *
 * THE RULE, as for the tenders beside it (`./tenders.ts`): the platform writes
 * the starting point, and the operator owns what it did next. Every write
 * here is insert-if-absent, keyed so that an edited, renamed, deactivated or
 * archived row still counts as present:
 *   - a role exists by (operator, name) — its permissions are laid only when
 *     the row is created, never re-synced, because it is the operator's role;
 *     the one exception is `INBOX_ROLE_LATE_GRANTS` below: a permission that
 *     joined a bundle AFTER deployed operators already had the role is added
 *     to that role, insert-if-absent, and nothing is ever taken away;
 *   - a team exists by (operator, key, branch);
 *   - a team that has ANY routing rule, live or archived, is left alone — a
 *     person named on a rule, or a rule archived, is never undone;
 *   - a template exists by (operator, key, language) with no channel or
 *     branch, archived included; its body is rewritten only when it is still
 *     flagged `needs_translation` AND still equals the English source — an
 *     admin's own words, flagged or not, are never overwritten;
 *   - a console account exists by (operator, provider, external id),
 *     archived included.
 *
 * Migrations own structure and this owns data: `0078_inbox_schema` writes no
 * row. Nor does `0080_inbox_ai`, and nothing here sets a channel account's
 * `ai_mode`: every account, laid here or by a person, keeps the column's
 * default `off` until a person with `inbox:ai:manage` switches it. Nothing here touches a conversation, a contact or a message — the demo
 * conversations are `./inbox-demo.ts`, and never laid by a deploy.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  INBOX_ROLE_BUNDLES,
  INBOX_ROLE_DESCRIPTIONS,
  INBOX_ROLES,
  newId,
  type InboxRole,
  type Permission,
} from '@oto/shared';
import type { Db } from '../index';
import * as s from '../schema/index';
import type { InboxCategory, InboxChannel, InboxTeamKey, InboxTemplateKey } from '../schema/inbox';

/** The two operator-wide departments the Inbox adds. Reception reuses each branch's own. */
export const INBOX_DEPARTMENTS = {
  birthdays: 'birthdays & events',
  marketing: 'marketing',
} as const;

/** The department every branch rosters its counter staff in (`seed/index.ts` `departmentsFor`). */
export const RECEPTION_DEPARTMENT = 'reception';

/** How each team looks: the prototype's category colours (`inbox.md` "Colour code"). */
const TEAM_LOOK: Record<InboxTeamKey, { colour: string; sortOrder: number }> = {
  birthdays: { colour: 'violet', sortOrder: 0 },
  reception: { colour: 'sky', sortOrder: 10 },
  marketing: { colour: 'pink', sortOrder: 100 },
};

/** The notice channels a registration can name (`crm.member` CONTACT_CHANNELS less Instagram). */
export const CONSOLE_NOTICE_CHANNELS = ['whatsapp', 'line', 'telegram'] as const satisfies readonly InboxChannel[];

const CHANNEL_LABEL: Record<(typeof CONSOLE_NOTICE_CHANNELS)[number], string> = {
  whatsapp: 'WhatsApp',
  line: 'LINE',
  telegram: 'Telegram',
};

/** The console account's external id: one per operator and channel. */
export const consoleExternalId = (channel: InboxChannel): string => `console:${channel}`;

/** The languages a template is laid in: English is the source; Thai and Russian carry their own words. */
export const INBOX_TEMPLATE_LANGUAGES = ['en', 'ru', 'th'] as const;
export type InboxTemplateLanguage = (typeof INBOX_TEMPLATE_LANGUAGES)[number];
type TranslatedLanguage = Exclude<InboxTemplateLanguage, 'en'>;

/**
 * The welcome, handover, out-of-hours and follow-up lines, in English.
 *
 * Worded from the IT Brief's "Standard handover lines" and its out-of-hours
 * rule, with every person's name taken out: who the birthday manager or the
 * marketing owner is, is a routing rule (owner Q20), and a template that named
 * them would have to be edited every time the rule was. The welcome line
 * follows the IT Brief, not the demo data: it never asks the customer to pick
 * a language. The out-of-hours hours are the reception phones' 10:00–20:00.
 *
 * A placeholder is `{{name}}` (`@oto/shared` `templateVariables`): the
 * composer asks for a value before sending. Only `follow_up` carries one.
 */
export const INBOX_TEMPLATE_BODIES: Record<InboxTemplateKey, string> = {
  welcome: 'Hi! 👋 Welcome to OTO Play Park. How can we help you today?',
  handover_birthday:
    'Here are our birthday packages 🎂. One moment please — our birthday manager will be with you shortly to confirm the date and details.',
  handover_events:
    'Thank you for the inquiry. One of our team will get back to you shortly with a tailored proposal.',
  // SCRUM-220 test night, W1: an upset parent read the old "Thank you for
  // letting us know. Please hold on — … right away." as cold. One line of
  // empathy first, and "shortly" rather than "right away" (nobody is there
  // right away on a phone). The old lines are `INBOX_TEMPLATE_FORMER_BODIES`.
  handover_complaint_online:
    "I'm really sorry to hear that. Thank you for telling us — a member of our team will be with you shortly to look into this.",
  handover_complaint_onsite:
    "I'm really sorry to hear that. Thank you for telling us — a member of our reception team will be with you shortly.",
  handover_lost_found:
    'Thanks for reaching out. One of our reception team will check and reply to you very shortly.',
  handover_marketing: 'Thanks for the message! Our marketing team will get back to you shortly.',
  out_of_hours:
    "Thanks for your message! Our team is here every day from 10:00 to 20:00, and we'll get back to you as soon as we open.",
  // SCRUM-590 (`0080_inbox_ai`, plan X6/R1): the assistant's holding line for
  // the handover categories with no key of their own — discounts, custom
  // requests, nanny booking, unclear or emotional messages, a request for a
  // person. Laid like the others, insert-if-absent, so an operator synced
  // before it gets the three rows on the next platform-sync and an edited
  // one is never undone.
  handover_general: 'Thank you for your message. One moment please — a colleague will be with you shortly.',
  // SCRUM-220 test night (`0083_inbox_test_night`, rails plan "Test night"
  // R2): the one template that is not a holding line. Outside WhatsApp's
  // 24-hour window only a template may be sent, and until this key every
  // template asked the customer to hold for somebody — a person could not
  // follow a thread up after a day. `{{name}}` is the customer's name.
  follow_up:
    "Hello {{name}}, following up on your message to OTO Play Park — reply here whenever you're ready and we'll pick it up.",
};

/**
 * The same lines in Thai and Russian (SCRUM-220 test night, rails plan "Test
 * night" R1). Until the test night every TH and RU row carried the English
 * body marked `needs_translation`, and nobody translated them: a Russian
 * customer outside the 24-hour window received English.
 *
 * Thai is written as a receptionist writes it, with the polite particles
 * (ค่ะ / คะ / นะคะ); Russian is natural and polite (вы). Each carries exactly
 * the placeholders its English source does, and no number the English source
 * does not: the out-of-hours line's 10:00–20:00 is the source's own.
 */
export const INBOX_TEMPLATE_TRANSLATIONS: Record<TranslatedLanguage, Record<InboxTemplateKey, string>> = {
  th: {
    welcome: 'สวัสดีค่ะ 👋 ยินดีต้อนรับสู่ OTO Play Park ค่ะ วันนี้ให้เราช่วยอะไรดีคะ',
    handover_birthday:
      'นี่คือแพ็กเกจวันเกิดของเราค่ะ 🎂 รอสักครู่นะคะ ผู้จัดการฝ่ายงานวันเกิดจะมาช่วยยืนยันวันที่และรายละเอียดให้ในอีกไม่นานค่ะ',
    handover_events: 'ขอบคุณที่สอบถามเข้ามานะคะ ทีมงานของเราจะติดต่อกลับพร้อมข้อเสนอที่เหมาะกับคุณในอีกไม่นานค่ะ',
    handover_complaint_online:
      'ต้องขออภัยอย่างยิ่งที่เกิดเรื่องแบบนี้ขึ้นนะคะ ขอบคุณที่แจ้งให้เราทราบค่ะ ทีมงานของเราจะติดต่อกลับเพื่อดูแลเรื่องนี้ในอีกไม่นานค่ะ',
    handover_complaint_onsite:
      'ต้องขออภัยอย่างยิ่งที่เกิดเรื่องแบบนี้ขึ้นนะคะ ขอบคุณที่แจ้งให้เราทราบค่ะ ทีมต้อนรับของเราจะมาดูแลคุณในอีกไม่นานค่ะ',
    handover_lost_found: 'ขอบคุณที่ติดต่อเข้ามานะคะ ทีมต้อนรับของเราจะตรวจสอบและตอบกลับให้โดยเร็วที่สุดค่ะ',
    handover_marketing: 'ขอบคุณสำหรับข้อความนะคะ ทีมการตลาดของเราจะติดต่อกลับในอีกไม่นานค่ะ',
    out_of_hours:
      'ขอบคุณสำหรับข้อความนะคะ ทีมงานของเราพร้อมให้บริการทุกวันตั้งแต่ 10:00 ถึง 20:00 น. และจะตอบกลับทันทีที่เปิดทำการค่ะ',
    handover_general: 'ขอบคุณสำหรับข้อความนะคะ รอสักครู่นะคะ เจ้าหน้าที่ของเราจะมาดูแลคุณในอีกไม่นานค่ะ',
    follow_up:
      'สวัสดีค่ะ คุณ{{name}} ขอติดตามเรื่องข้อความที่ส่งถึง OTO Play Park นะคะ สะดวกเมื่อไหร่ตอบกลับมาได้เลยค่ะ เราพร้อมดูแลต่อให้ค่ะ',
  },
  ru: {
    welcome: 'Здравствуйте! 👋 Добро пожаловать в OTO Play Park. Чем мы можем вам помочь?',
    handover_birthday:
      'Вот наши пакеты для дня рождения 🎂. Одну минуту, пожалуйста — наш менеджер по праздникам скоро свяжется с вами, чтобы подтвердить дату и детали.',
    handover_events: 'Спасибо за ваш запрос. Кто-то из нашей команды скоро свяжется с вами с индивидуальным предложением.',
    handover_complaint_online:
      'Нам очень жаль, что так произошло. Спасибо, что рассказали нам — сотрудник нашей команды скоро свяжется с вами, чтобы разобраться в ситуации.',
    handover_complaint_onsite:
      'Нам очень жаль, что так произошло. Спасибо, что рассказали нам — сотрудник ресепшена скоро свяжется с вами.',
    handover_lost_found: 'Спасибо, что написали нам. Сотрудник ресепшена проверит и очень скоро вам ответит.',
    handover_marketing: 'Спасибо за сообщение! Наша команда маркетинга скоро свяжется с вами.',
    out_of_hours:
      'Спасибо за ваше сообщение! Наша команда на связи ежедневно с 10:00 до 20:00, и мы ответим вам, как только откроемся.',
    handover_general: 'Спасибо за ваше сообщение. Одну минуту, пожалуйста — коллега скоро подключится к разговору.',
    follow_up:
      'Здравствуйте, {{name}}! Пишем по поводу вашего сообщения в OTO Play Park — ответьте здесь, когда вам будет удобно, и мы продолжим.',
  },
};

/** The words a template row is laid with: the English source, or that language's own line. */
export const templateBodyFor = (key: InboxTemplateKey, language: InboxTemplateLanguage): string =>
  language === 'en' ? INBOX_TEMPLATE_BODIES[key] : INBOX_TEMPLATE_TRANSLATIONS[language][key];

/**
 * English wordings this file laid BEFORE the current ones (SCRUM-220 test
 * night, W1): a deployed operator's TH or RU row that still carries one of
 * these, flagged `needs_translation`, is as untranslated as one carrying the
 * current source, and `backfillTranslations` treats it so. The English row
 * itself is never rewritten — a wording change on a live operator's English
 * line is an admin's to make.
 */
export const INBOX_TEMPLATE_FORMER_BODIES: Readonly<Partial<Record<InboxTemplateKey, readonly string[]>>> = {
  handover_complaint_online: [
    'Thank you for letting us know. Please hold on — a member of our team will be with you right away to look into this.',
  ],
  handover_complaint_onsite: ['Thank you for letting us know. Please hold on — our reception team will be with you right away.'],
};

/**
 * The routing rules a team starts with. People are blank: every primary is
 * the team itself until somebody names a person on the rule (owner Q20), and
 * no backup is named. The language-specific rows sit above the catch-all.
 *
 *   Birthdays & Events  EN, RU, TH (the IT Brief's pairs), then a catch-all
 *   Marketing           the marketing owner's rule, then a catch-all
 *   Reception · <park>  general enquiries at that park — a team primary,
 *                       which is itself the team's catch-all
 */
export const NAMED_RULE_PRIORITY = 10;
export const CATCH_ALL_PRIORITY = 0;

function rulesFor(
  key: InboxTeamKey,
  branchId: string | null,
): Array<{ category: InboxCategory; language: string | null; branchId: string | null; priority: number }> {
  switch (key) {
    case 'birthdays':
      return [
        { category: 'birthdays', language: 'en', branchId: null, priority: NAMED_RULE_PRIORITY },
        { category: 'birthdays', language: 'ru', branchId: null, priority: NAMED_RULE_PRIORITY },
        { category: 'birthdays', language: 'th', branchId: null, priority: NAMED_RULE_PRIORITY },
        { category: 'birthdays', language: null, branchId: null, priority: CATCH_ALL_PRIORITY },
      ];
    case 'marketing':
      return [
        { category: 'marketing', language: null, branchId: null, priority: NAMED_RULE_PRIORITY },
        { category: 'marketing', language: null, branchId: null, priority: CATCH_ALL_PRIORITY },
      ];
    case 'reception':
      return [{ category: 'general', language: null, branchId, priority: CATCH_ALL_PRIORITY }];
  }
}

/** "Oto Play Park, Central Floresta" → "Central Floresta": the part a person says. */
export function shortBranchName(name: string): string {
  const tail = name.split(',').at(-1)?.trim();
  return tail && tail.length > 0 ? tail : name.trim();
}

/** What one run laid, for the deploy log. Zero everywhere on a converged database. */
export interface InboxSyncCounts {
  operators: number;
  roles: number;
  /** Permissions added to an existing inbox role by `INBOX_ROLE_LATE_GRANTS`. */
  grants: number;
  departments: number;
  teams: number;
  rules: number;
  templates: number;
  /** TH or RU template rows that still carried the English source and took their translation. */
  translations: number;
  channelAccounts: number;
}

const emptyCounts = (): InboxSyncCounts => ({
  operators: 0,
  roles: 0,
  grants: 0,
  departments: 0,
  teams: 0,
  rules: 0,
  templates: 0,
  translations: 0,
  channelAccounts: 0,
});

/**
 * THE ONE-TIME GRANT STEP (SCRUM-590, round A3). Role permissions are laid
 * when the role row is created, so an `inbox_admin` laid before the assistant
 * existed lacks the two permissions SCRUM-590 folded into its bundle (plan
 * R9) — and the Assistant settings page would be closed to every inbox
 * administrator on a deployed database.
 *
 * Only the permissions named here are granted, only to the inbox role of that
 * NAME that platform-sync itself lays (the operator's row, `is_system` false),
 * and only when absent. Nothing is removed, the rest of the bundle is not
 * re-laid (an operator who took a permission out of the role keeps that
 * edit), and no other role — a custom role, a system bundle — is touched. A
 * permission joins this list only together with its bundle above, so on a
 * freshly laid role every entry is already present and the step writes
 * nothing.
 *
 * SCRUM-591 (internal assistant, round I1): `assistant:ask:use` joined all
 * three bundles (plan §E.2, R5), so a department-only inbox agent can ask the
 * launcher's assistant too. The system bundles take it from `platformSync`,
 * which re-syncs them; these operator roles take it from here, once.
 */
export const INBOX_ROLE_LATE_GRANTS: Readonly<Partial<Record<InboxRole, readonly Permission[]>>> = {
  inbox_agent: ['assistant:ask:use'],
  inbox_manager: ['assistant:ask:use'],
  inbox_admin: ['inbox:kb:manage', 'inbox:ai:manage', 'assistant:ask:use'],
};

/** Find-or-create a department by (operator, branch, name). Returns its id and whether it was made. */
async function department(
  db: Db,
  operatorId: string,
  branchId: string | null,
  name: string,
  teamKey: InboxTeamKey,
): Promise<{ id: string; created: boolean }> {
  // A mirrored source may rename the existing department. Keep the canonical
  // team's owned projection rather than recreating its former seed name.
  const [linked] = await db.select({ id: s.department.id }).from(s.team)
    .innerJoin(s.department, and(eq(s.department.id, s.team.departmentId),
      eq(s.department.operatorId, operatorId), isNotNull(s.department.externalId),
      branchId === null ? isNull(s.department.branchId) : eq(s.department.branchId, branchId)))
    .where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, teamKey),
      branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId)))
    .limit(1);
  if (linked) return { id: linked.id, created: false };
  const [found] = await db
    .select({ id: s.department.id })
    .from(s.department)
    .where(
      and(
        eq(s.department.operatorId, operatorId),
        branchId === null ? isNull(s.department.branchId) : eq(s.department.branchId, branchId),
        eq(s.department.name, name),
      ),
    )
    .orderBy(s.department.createdAt)
    .limit(1);
  if (found) return { id: found.id, created: false };
  const id = newId();
  await db.insert(s.department).values({ id, operatorId, branchId, name });
  return { id, created: true };
}

/** The three inbox roles, as this operator's own; permissions laid only on creation. */
async function syncRoles(db: Db, operatorId: string, counts: InboxSyncCounts): Promise<Record<InboxRole, string>> {
  const ids = {} as Record<InboxRole, string>;
  for (const name of INBOX_ROLES) {
    const [created] = await db
      .insert(s.role)
      .values({ id: newId(), operatorId, name, description: INBOX_ROLE_DESCRIPTIONS[name], isSystem: false })
      .onConflictDoNothing({ target: [s.role.operatorId, s.role.name] })
      .returning({ id: s.role.id });
    if (created) {
      counts.roles += 1;
      await db
        .insert(s.rolePermission)
        .values(INBOX_ROLE_BUNDLES[name].map((permission) => ({ id: newId(), roleId: created.id, permission })));
      ids[name] = created.id;
    } else {
      const [row] = await db
        .select({ id: s.role.id })
        .from(s.role)
        .where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, name)))
        .limit(1);
      ids[name] = row!.id;
      const late = INBOX_ROLE_LATE_GRANTS[name] ?? [];
      if (late.length > 0) {
        const granted = await db
          .insert(s.rolePermission)
          .values(late.map((permission) => ({ id: newId(), roleId: row!.id, permission })))
          .onConflictDoNothing({ target: [s.rolePermission.roleId, s.rolePermission.permission] })
          .returning({ id: s.rolePermission.id });
        counts.grants += granted.length;
      }
    }
  }
  return ids;
}

/** Find-or-create a team by (operator, key, branch). */
async function syncTeam(
  db: Db,
  input: { operatorId: string; key: InboxTeamKey; branchId: string | null; departmentId: string; name: string; sortOrder: number },
  counts: InboxSyncCounts,
): Promise<{ id: string; key: InboxTeamKey; branchId: string | null }> {
  const [found] = await db
    .select({ id: s.team.id })
    .from(s.team)
    .where(
      and(
        eq(s.team.operatorId, input.operatorId),
        eq(s.team.key, input.key),
        input.branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, input.branchId),
      ),
    )
    .limit(1);
  if (found) return { id: found.id, key: input.key, branchId: input.branchId };
  const id = newId();
  await db.insert(s.team).values({
    id,
    operatorId: input.operatorId,
    key: input.key,
    branchId: input.branchId,
    departmentId: input.departmentId,
    name: input.name,
    colour: TEAM_LOOK[input.key].colour,
    sortOrder: input.sortOrder,
  });
  counts.teams += 1;
  return { id, key: input.key, branchId: input.branchId };
}

/** A team with no rule at all — live or archived — gets its defaults; any other is left alone. */
async function syncRules(
  db: Db,
  operatorId: string,
  team: { id: string; key: InboxTeamKey; branchId: string | null },
  counts: InboxSyncCounts,
): Promise<void> {
  const [any] = await db
    .select({ one: sql<number>`1` })
    .from(s.routingRule)
    .where(and(eq(s.routingRule.operatorId, operatorId), eq(s.routingRule.teamId, team.id)))
    .limit(1);
  if (any) return;
  const rows = rulesFor(team.key, team.branchId).map((r) => ({
    id: newId(),
    operatorId,
    teamId: team.id,
    category: r.category,
    language: r.language,
    branchId: r.branchId,
    primaryKind: 'team' as const,
    primaryAccountId: null,
    backupAccountId: null,
    autoAddBackup: true,
    priority: r.priority,
    active: true,
  }));
  await db.insert(s.routingRule).values(rows);
  counts.rules += rows.length;
}

async function syncTemplates(db: Db, operatorId: string, counts: InboxSyncCounts): Promise<void> {
  const present = await db
    .select({ key: s.template.key, language: s.template.language })
    .from(s.template)
    .where(and(eq(s.template.operatorId, operatorId), isNull(s.template.channel), isNull(s.template.branchId)));
  const have = new Set(present.map((r) => `${r.key}:${r.language}`));
  const rows = [];
  for (const key of Object.keys(INBOX_TEMPLATE_BODIES) as InboxTemplateKey[]) {
    for (const language of INBOX_TEMPLATE_LANGUAGES) {
      if (have.has(`${key}:${language}`)) continue;
      rows.push({
        id: newId(),
        operatorId,
        key,
        language,
        channel: null,
        branchId: null,
        body: templateBodyFor(key, language),
        approvalStatus: 'not_required' as const,
        // Every language is laid in its own words; nothing waits for a translator.
        needsTranslation: false,
        active: true,
      });
    }
  }
  if (rows.length > 0) {
    await db.insert(s.template).values(rows);
    counts.templates += rows.length;
  }
  await backfillTranslations(db, operatorId, counts);
}

/**
 * THE ONE UPDATE THIS FILE MAKES (SCRUM-220 test night, R1). An operator
 * synced before the translations existed holds TH and RU rows that carry the
 * English source marked `needs_translation`. Each takes its translation, and
 * the flag clears, ONLY while both still hold: the row is still flagged AND
 * its body is still the English source, word for word. A body anybody
 * changed — flagged or not, archived or not — is that person's, and is left
 * exactly as they wrote it. A flagged row that equals a FORMER wording this
 * file laid (`INBOX_TEMPLATE_FORMER_BODIES`) is as untranslated as one with
 * the current source, and takes its translation too; a flagged row equal to
 * nothing this file ever laid stays as it is, for an admin to word.
 */
async function backfillTranslations(db: Db, operatorId: string, counts: InboxSyncCounts): Promise<void> {
  for (const key of Object.keys(INBOX_TEMPLATE_BODIES) as InboxTemplateKey[]) {
    for (const language of INBOX_TEMPLATE_LANGUAGES) {
      if (language === 'en') continue;
      const translated = await db
        .update(s.template)
        .set({ body: INBOX_TEMPLATE_TRANSLATIONS[language][key], needsTranslation: false, updatedAt: new Date() })
        .where(
          and(
            eq(s.template.operatorId, operatorId),
            eq(s.template.key, key),
            eq(s.template.language, language),
            isNull(s.template.channel),
            isNull(s.template.branchId),
            eq(s.template.needsTranslation, true),
            inArray(s.template.body, [INBOX_TEMPLATE_BODIES[key], ...(INBOX_TEMPLATE_FORMER_BODIES[key] ?? [])]),
          ),
        )
        .returning({ id: s.template.id });
      counts.translations += translated.length;
    }
  }
}

async function syncConsoleAccounts(db: Db, operatorId: string, counts: InboxSyncCounts): Promise<void> {
  for (const channel of CONSOLE_NOTICE_CHANNELS) {
    const externalId = consoleExternalId(channel);
    const [found] = await db
      .select({ id: s.channelAccount.id })
      .from(s.channelAccount)
      .where(
        and(
          eq(s.channelAccount.operatorId, operatorId),
          eq(s.channelAccount.provider, 'console'),
          eq(s.channelAccount.externalId, externalId),
        ),
      )
      .limit(1);
    if (found) continue;
    await db.insert(s.channelAccount).values({
      id: newId(),
      operatorId,
      branchId: null,
      channel,
      provider: 'console',
      externalId,
      displayName: `Check-in notices (${CHANNEL_LABEL[channel]})`,
      defaultCategory: 'general',
      canReply: false,
      status: 'active',
    });
    counts.channelAccounts += 1;
  }
}

/**
 * Lay the Inbox's configuration for every operator that lacks it.
 *
 * Archived operators are included, as the tenders are: a park that trades
 * again one day should find an inbox that can route. Archived BRANCHES are
 * not — a reception team is a desk, and an archived park has none.
 */
export async function syncInboxSetup(db: Db): Promise<InboxSyncCounts> {
  const counts = emptyCounts();
  const operators = await db.select({ id: s.operator.id }).from(s.operator).orderBy(s.operator.createdAt);
  for (const { id: operatorId } of operators) {
    const before = JSON.stringify(counts);
    await syncRoles(db, operatorId, counts);

    const birthdaysDept = await department(db, operatorId, null, INBOX_DEPARTMENTS.birthdays, 'birthdays');
    const marketingDept = await department(db, operatorId, null, INBOX_DEPARTMENTS.marketing, 'marketing');
    counts.departments += Number(birthdaysDept.created) + Number(marketingDept.created);

    const teams = [
      await syncTeam(
        db,
        {
          operatorId,
          key: 'birthdays',
          branchId: null,
          departmentId: birthdaysDept.id,
          name: 'Birthdays & Events',
          sortOrder: TEAM_LOOK.birthdays.sortOrder,
        },
        counts,
      ),
    ];

    const branches = await db
      .select({ id: s.branch.id, name: s.branch.name })
      .from(s.branch)
      .where(and(eq(s.branch.operatorId, operatorId), isNull(s.branch.archivedAt)))
      .orderBy(s.branch.createdAt);
    for (const [i, br] of branches.entries()) {
      const reception = await department(db, operatorId, br.id, RECEPTION_DEPARTMENT, 'reception');
      counts.departments += Number(reception.created);
      teams.push(
        await syncTeam(
          db,
          {
            operatorId,
            key: 'reception',
            branchId: br.id,
            departmentId: reception.id,
            name: `Reception · ${shortBranchName(br.name)}`,
            sortOrder: TEAM_LOOK.reception.sortOrder + i,
          },
          counts,
        ),
      );
    }

    teams.push(
      await syncTeam(
        db,
        {
          operatorId,
          key: 'marketing',
          branchId: null,
          departmentId: marketingDept.id,
          name: 'Marketing',
          sortOrder: TEAM_LOOK.marketing.sortOrder,
        },
        counts,
      ),
    );

    for (const team of teams) await syncRules(db, operatorId, team, counts);
    await syncTemplates(db, operatorId, counts);
    await syncConsoleAccounts(db, operatorId, counts);
    if (JSON.stringify(counts) !== before) counts.operators += 1;
  }
  return counts;
}

/** One line for the deploy log, or null when nothing was laid. */
export function describeInboxSync(c: InboxSyncCounts): string | null {
  if (c.operators === 0) return null;
  return `Inbox: laid ${c.roles} role(s), ${c.grants} late permission grant(s), ${c.departments} department(s), ${c.teams} team(s), ${c.rules} routing rule(s), ${c.templates} template(s), ${c.translations} template translation(s) and ${c.channelAccounts} console channel account(s) at ${c.operators} operator(s) — the rules' people are blank until somebody names them.`;
}
