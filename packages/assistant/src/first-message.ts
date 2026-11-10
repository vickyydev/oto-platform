/**
 * SCRUM-830 — THE FIRST MESSAGE DECIDES THE INBOX QUEUE (owner, 11 Nov 2026).
 *
 * Until now a new conversation was routed before any AI ran, on the
 * simulator's hint or the channel account's default category, so "I want to
 * book a Birthday Party" on a general number went to Reception, and only the
 * assistant's turn seconds later moved it to Birthdays & Events (the pill's
 * "1 more"); a thread the assistant did not answer was never corrected.
 *
 * This reader classifies the FIRST customer message at ingest, before any
 * model runs, from its words in Thai, English and Russian:
 *
 *   birthdays   a birthday, a party, a package, a cake, a celebration, an
 *               event; a camp; a school or other GROUP visit — the Birthday &
 *               events team's matters (the playbook's destination table,
 *               `intents.ts`). A birthday QUESTION about prices or hours
 *               alone is still a birthday. Not the park's own child care (a
 *               nanny, day care, a drop-off: Central reception's), and not a
 *               child who merely IS at school or kindergarten: a school word
 *               counts only as a group coming.
 *   gm          a refund or a complaint — rude staff, an injury, money back,
 *               a bad experience, plain dissatisfaction ("not happy with the
 *               party", "poor service", "a waste of money") — the GM's. A
 *               complaint cue WINS over a birthday cue: "the party was
 *               terrible, I want a refund" and "we were not happy with the
 *               party" are the GM's.
 *   null        anything else: a greeting, a plain question, a line with no
 *               cue. The channel account's default category then stands, as
 *               before.
 *
 * The simulator's hint still wins when given (the tester's instrument); the
 * ingest applies this reader only without one. The assistant stays the
 * second opinion: its own re-route after its turn is unchanged.
 *
 * Deterministic and pure: no clock, no database, no model. NFC-normalised;
 * word-boundary-aware for Latin and Cyrillic (JavaScript's `\b` is ASCII
 * only), substring for Thai, which writes no word spaces. The answer carries
 * the CUE'S KEY, never the text: it goes on the routing pill, the audit row
 * and the corpus measure (`scripts/first-message-measure.ts`). Its LANGUAGE
 * is the customer's — the line's script when it carries Thai or Cyrillic
 * letters, else the cue's — so a Thai opener with a Latin loanword ("มี
 * package วันเกิดไหมคะ") is Thai, and the ingest seats the Thai rule's
 * people (test night D2). A Thai or Cyrillic line's own cues are read first.
 */

export type FirstMessageCategory = 'birthdays' | 'gm';

export type FirstMessageLanguage = 'en' | 'th' | 'ru';

export interface FirstMessageReading {
  category: FirstMessageCategory;
  /** The cue's key (`FIRST_MESSAGE_CUE_KEYS`), never the words matched. */
  cue: FirstMessageCueKey;
  /**
   * The language the customer wrote in: `th` when the line carries Thai
   * letters, else `ru` when Cyrillic, else the language of the cue that
   * matched (Latin script: English).
   */
  language: FirstMessageLanguage;
}

/** The cue keys, as the routing pill, the audit row and the measure name them. */
export const FIRST_MESSAGE_CUE_KEYS = [
  // Birthdays & events.
  'birthday',
  'party',
  'package',
  'cake',
  'celebration',
  'event',
  'camp',
  'school_group',
  // The GM.
  'refund',
  'complaint',
  'rude',
  'injury',
  'bad_experience',
  'cheated',
  'compensation',
] as const;
export type FirstMessageCueKey = (typeof FIRST_MESSAGE_CUE_KEYS)[number];

/** A word boundary for Latin and Cyrillic alike (JavaScript's `\b` is ASCII only). */
const W = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const words = (alternatives: readonly string[]) => new RegExp(`${W}(?:${alternatives.join('|')})${E}`, 'iu');
/** Thai, read without word spaces: a substring. */
const thai = (alternatives: readonly string[]) => new RegExp(`(?:${alternatives.join('|')})`, 'u');

interface Cue {
  key: FirstMessageCueKey;
  language: FirstMessageLanguage;
  re: RegExp;
  /**
   * The cue counts only in a line that ALSO says this, anywhere in it: a
   * school or a kindergarten is a group visit only beside the bringing of
   * children, a trip, a group — not a child who merely goes there.
   */
  beside?: RegExp;
}

const cue = (key: FirstMessageCueKey, language: FirstMessageLanguage, re: RegExp, beside?: RegExp): Cue => ({ key, language, re, ...(beside ? { beside } : {}) });

/**
 * What is taken out of a line before the cues read it — phrases whose word
 * is not the cue's sense:
 *
 *   "a party of four", "party of 2"   a headcount, not a party (the slot
 *                                     reader's `HEADCOUNT_CUE` reads it);
 *   "third party"                     not a party;
 *   "грубо говоря"                    "roughly speaking", not rudeness;
 *   "и др."                           "and others", not "день рождения";
 *   "в праздники", "праздничные дни"  the public holidays (are you open on
 *                                     them?), not a celebration;
 *   "пакет для обуви / вещей"         a plastic bag, not a package;
 *   "плохо говорю / знаю / слышно"    "I speak … badly", "hard to hear", not
 *                                     a bad experience.
 */
const NOT_THE_SENSE: readonly RegExp[] = [
  new RegExp(`${W}part(?:y|ies)\\s+of\\s+(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)${E}`, 'giu'),
  new RegExp(`${W}third[\\s-]+part(?:y|ies)${E}`, 'giu'),
  new RegExp(`${W}грубо\\s+говоря${E}`, 'giu'),
  new RegExp(`${W}и\\s+др\\.`, 'giu'),
  new RegExp(`${W}(?:в|на|по)\\s+праздник\\p{L}*${E}`, 'giu'),
  new RegExp(`${W}праздничн\\p{L}*${E}`, 'giu'),
  new RegExp(`${W}пакет\\p{L}*\\s+(?:для|под)\\s+(?:обуви|вещей|одежды|мокр\\p{L}*|сменк\\p{L}*)${E}`, 'giu'),
  new RegExp(`${W}(?:полиэтиленов|пластиков|целлофанов)\\p{L}*\\s+пакет\\p{L}*${E}`, 'giu'),
  new RegExp(`${W}плохо\\s+(?:говор\\p{L}*|зна\\p{L}*|понима\\p{L}*|слышно|видно|ориентиру\\p{L}*)${E}`, 'giu'),
];
const withoutOtherSenses = (text: string) => NOT_THE_SENSE.reduce((t, re) => t.replace(re, ' '), text);

/**
 * THE GM'S CUES — read first, so a complaint outranks a birthday word in the
 * same line. A refund, a complaint, rude staff, an injury, a bad experience,
 * being cheated or overcharged, compensation. The everyday complaint
 * phrasings are here too — "not happy with the party", "poor service",
 * "the party was a disaster / a waste of money", "ห่วย", "ไม่โอเค", "плохо",
 * "не понравилось" — so a complaint ABOUT a party is the GM's, not the
 * events team's (the owner's rule: refunds and complaints go to the GM).
 */
const GM_CUES: readonly Cue[] = [
  // English.
  cue('refund', 'en', words([String.raw`refund\p{L}*`, String.raw`money\s+back`, String.raw`charge\s*back`, String.raw`charged\s+twice`, String.raw`double[\s-]+charged?`])),
  cue(
    'complaint',
    'en',
    words([
      String.raw`complain\p{L}*`,
      'unacceptable',
      String.raw`disappoint\p{L}*`,
      String.raw`lawyer\p{L}*`,
      String.raw`legal\s+action`,
      String.raw`not\s+happy`,
      'unhappy',
      String.raw`(?:not\s+|un|dis)satisf\p{L}*`,
    ]),
  ),
  cue('rude', 'en', words([String.raw`rude(?:ly|ness)?`, 'impolite', 'disrespectful', 'shouted', 'yelled'])),
  cue('injury', 'en', words([String.raw`injur\p{L}*`, 'hurt', 'accident', 'unsafe', 'bleeding', 'bruise', 'bruised'])),
  cue(
    'bad_experience',
    'en',
    words([
      'terrible',
      'awful',
      'horrible',
      'disgusting',
      'worst',
      'filthy',
      'ruined',
      String.raw`never\s+again`,
      String.raw`(?:bad|poor|terrible|awful|horrible)\s+(?:service|experience|party|host|staff)`,
      String.raw`disast(?:er|ers|rous)`,
      'dirty',
      'unprofessional',
      String.raw`waste\s+of\s+(?:money|time)`,
      String.raw`nobody\s+(?:came|showed|helped|answered)`,
    ]),
  ),
  cue('cheated', 'en', words([String.raw`scam\p{L}*`, String.raw`cheat\p{L}*`, String.raw`overcharg\p{L}*`, String.raw`rip(?:ped)?[\s-]+off`])),
  cue('compensation', 'en', words([String.raw`compensat\p{L}*`])),
  // Russian.
  cue('refund', 'ru', words([String.raw`возврат\p{L}*`, 'верните', String.raw`вернуть\s+(?:деньги|средства|оплату)`, String.raw`деньги\s+(?:обратно|назад)`])),
  cue('complaint', 'ru', words([String.raw`жалоб\p{L}*`, String.raw`пожалова\p{L}*`, String.raw`претензи\p{L}*`, String.raw`недоволь\p{L}*`, String.raw`возмущ\p{L}*`, String.raw`разочарова\p{L}*`])),
  cue('rude', 'ru', words([String.raw`хам\p{L}*`, String.raw`(?:на)?груб\p{L}*`, String.raw`накричал\p{L}*`, String.raw`орал\p{L}*`])),
  cue('injury', 'ru', words([String.raw`травм\p{L}*`, String.raw`ушиб\p{L}*`, String.raw`пострада\p{L}*`, String.raw`поранил\p{L}*`])),
  cue(
    'bad_experience',
    'ru',
    words([
      String.raw`ужас\p{L}*`,
      String.raw`отвратительн\p{L}*`,
      String.raw`безобраз\p{L}*`,
      String.raw`кошмар\p{L}*`,
      String.raw`испортил\p{L}*`,
      'плохо',
      String.raw`не\s+понравил\p{L}*`,
      String.raw`никогда\s+больше`,
    ]),
  ),
  cue('cheated', 'ru', words([String.raw`обман\p{L}*`, String.raw`развод\p{L}*`, String.raw`переплат\p{L}*`])),
  cue('compensation', 'ru', words([String.raw`компенсац\p{L}*`])),
  // Thai.
  cue('refund', 'th', thai(['คืนเงิน', 'เงินคืน', 'รีฟัน'])),
  cue('complaint', 'th', thai(['ร้องเรียน', 'คอมเพลน', 'ไม่พอใจ', 'ผิดหวัง', 'เสียความรู้สึก', 'แจ้งความ', 'ฟ้อง'])),
  cue('rude', 'th', thai(['หยาบคาย', 'ไม่สุภาพ', 'พูดจาไม่ดี', 'พูดไม่ดี', 'ตะคอก'])),
  cue('injury', 'th', thai(['บาดเจ็บ', 'เจ็บตัว', 'อุบัติเหตุ', 'เลือดออก', 'ไม่ปลอดภัย'])),
  cue('bad_experience', 'th', thai(['แย่มาก', 'แย่ที่สุด', 'แย่เลย', 'บริการแย่', 'พนักงานแย่', 'ไม่ประทับใจ', 'สกปรกมาก', 'ห่วย', 'ไม่โอเค', 'ไม่ดีเลย', 'ไม่คุ้ม'])),
  cue('cheated', 'th', thai(['โกง', 'หลอกลวง', 'คิดเงินเกิน', 'เก็บเงินเกิน'])),
  cue('compensation', 'th', thai(['ชดเชย', 'ค่าเสียหาย'])),
];

/**
 * THE BIRTHDAY & EVENTS CUES: a birthday, a party, a package, a cake, a
 * celebration, an event; a camp; a school or other group VISIT.
 *
 * A school, a kindergarten or a nursery is a cue only as a group coming —
 * "school trip", "from our kindergarten", "โรงเรียนจะพาเด็กมา", "группа из
 * детского сада": a child who IS at kindergarten ("my daughter is in
 * kindergarten, is the park ok for her age?", "ลูกอยู่อนุบาล 2") asks
 * reception's question. Day care and a nursery are the park's OWN child
 * care (`nanny_booking`, Central reception's): never a cue.
 *
 * Not the Thai "ฉลอง" (to celebrate): it is also Chalong, the park's own
 * district ("สาขาฉลอง", the slot reader's `PARK_WORDS`), and a Thai birthday
 * line says "วันเกิด" anyway. Not the Russian "в праздники" / "праздничные
 * дни" (the public holidays) nor "группа в телеграме" (a chat group):
 * `NOT_THE_SENSE` and the narrowed group forms.
 */
const BIRTHDAY_CUES: readonly Cue[] = [
  // English.
  cue('birthday', 'en', words(['birthdays?', String.raw`b[\s-]?day`, 'bdays?'])),
  cue('party', 'en', words(['party', 'parties'])),
  cue('package', 'en', words(['packages?'])),
  cue('cake', 'en', words(['cakes?'])),
  cue('celebration', 'en', words([String.raw`celebrat\p{L}*`, 'anniversary'])),
  cue('event', 'en', words(['events?', String.raw`team[\s-]?building`, 'corporate', String.raw`private\s+(?:hire|room|area|zone)`])),
  cue('camp', 'en', words(['camps?', String.raw`summer\s+camp\p{L}*`, String.raw`day\s+camp\p{L}*`])),
  cue(
    'school_group',
    'en',
    words([
      String.raw`(?:school|kindergarten|pre[\s-]?school|nursery)\s+(?:group|trip|visit|outing|excursion|class|classes)`,
      String.raw`from\s+(?:our|a)\s+(?:school|kindergarten|pre[\s-]?school|nursery)`,
      String.raw`field\s+trip\p{L}*`,
      String.raw`excursion\p{L}*`,
      String.raw`\d+\s+(?:students|pupils)`,
      String.raw`group\s+(?:booking|visit|rate|discount)`,
    ]),
  ),
  // Russian.
  cue('birthday', 'ru', words([String.raw`(?:день|дня|дню|днём|днем)\s+рожд\p{L}*`, 'др', String.raw`днюх\p{L}*`, String.raw`именин\p{L}*`])),
  cue('party', 'ru', words([String.raw`вечеринк\p{L}*`])),
  cue('package', 'ru', words([String.raw`пакет\p{L}*`])),
  cue('cake', 'ru', words([String.raw`торт\p{L}*`])),
  cue('celebration', 'ru', words([String.raw`праздник\p{L}*`, String.raw`праздн(?:у|ова)\p{L}*`, String.raw`отпраздн\p{L}*`, String.raw`отмет(?:ить|им|ите)`, String.raw`отмеча\p{L}*`])),
  cue('event', 'ru', words([String.raw`мероприяти\p{L}*`, String.raw`корпоратив\p{L}*`])),
  cue('camp', 'ru', words([String.raw`лагер\p{L}*`, String.raw`кемп\p{L}*`])),
  cue(
    'school_group',
    'ru',
    words([
      String.raw`экскурси\p{L}*`,
      String.raw`школьн\p{L}*\s+(?:групп|экскурси|класс|поездк)\p{L}*`,
      String.raw`групп(?:а|у|ой|ы)\s+(?:из|детей|школьников|\d)`,
      String.raw`группов\p{L}*`,
    ]),
  ),
  // A kindergarten only beside the bringing of its children, a group, a trip.
  cue('school_group', 'ru', words([String.raw`детск\p{L}*\s+сад\p{L}*`, String.raw`садик\p{L}*`]), words([String.raw`групп\p{L}*`, String.raw`привед\p{L}*`, String.raw`привез\p{L}*`, String.raw`привест\p{L}*`, String.raw`экскурси\p{L}*`])),
  // Thai.
  cue('birthday', 'th', thai(['วันเกิด', 'เบิร์ดเดย์', 'เบิร์ธเดย์'])),
  cue('party', 'th', thai(['ปาร์ตี้', 'ปาร์ตี', 'ปาตี้', 'งานเลี้ยง', 'จัดเลี้ยง'])),
  cue('package', 'th', thai(['แพ็กเกจ', 'แพคเกจ', 'แพ็คเกจ', 'แพกเกจ', 'แพ็กเก็จ'])),
  cue('cake', 'th', thai(['เค้ก', 'เค๊ก'])),
  cue('celebration', 'th', thai(['จัดงาน'])),
  cue('event', 'th', thai(['อีเว้นท์', 'อีเวนต์', 'อีเว้น', 'อีเวนท์'])),
  cue('camp', 'th', thai(['แคมป์', 'แค้มป์', 'ค่ายเด็ก', 'เข้าค่าย', 'ค่ายปิดเทอม', 'ค่ายซัมเมอร์'])),
  cue('school_group', 'th', thai(['ทัศนศึกษา', 'หมู่คณะ', 'กรุ๊ป', 'เป็นกลุ่ม', String.raw`นักเรียน\s*\d+\s*คน`, 'คณะครู', 'คณะนักเรียน', 'กลุ่มนักเรียน'])),
  // A school or a kindergarten only beside the bringing of children, a trip, a group.
  cue('school_group', 'th', thai(['โรงเรียน', 'อนุบาล']), thai(['พาเด็ก', 'พานักเรียน', 'พาน้อง', 'ทัศนศึกษา', 'หมู่คณะ', 'กรุ๊ป', 'กลุ่ม', 'คณะ'])),
];

/** The script the customer wrote in, where the line carries one: Thai or Cyrillic letters. */
const scriptOf = (text: string): FirstMessageLanguage | null =>
  /\p{Script=Thai}/u.test(text) ? 'th' : /\p{Script=Cyrillic}/u.test(text) ? 'ru' : null;

/** The cues of the line's own script first, so a Thai line's Thai cue names the reading. */
const inScriptOrder = (cues: readonly Cue[], script: FirstMessageLanguage | null): readonly Cue[] =>
  script ? [...cues.filter((c) => c.language === script), ...cues.filter((c) => c.language !== script)] : cues;

const firstOf = (cues: readonly Cue[], text: string, script: FirstMessageLanguage | null): Cue | null =>
  inScriptOrder(cues, script).find((c) => c.re.test(text) && (!c.beside || c.beside.test(text))) ?? null;

/**
 * Where a first customer message belongs, from its words alone, or null when
 * nothing in it says: `gm` for a refund or a complaint (which wins over any
 * birthday word in the same line), `birthdays` for a birthday, a party, a
 * package, a cake, a celebration, an event, a camp or a school group. The
 * answer names the cue's key and the customer's language (the line's script,
 * else the cue's), never the words.
 */
export function firstMessageCategory(raw: string | null | undefined): FirstMessageReading | null {
  if (!raw) return null;
  const text = withoutOtherSenses(raw.normalize('NFC'));
  const script = scriptOf(text);
  const gm = firstOf(GM_CUES, text, script);
  if (gm) return { category: 'gm', cue: gm.key, language: script ?? gm.language };
  const birthday = firstOf(BIRTHDAY_CUES, text, script);
  if (birthday) return { category: 'birthdays', cue: birthday.key, language: script ?? birthday.language };
  return null;
}
