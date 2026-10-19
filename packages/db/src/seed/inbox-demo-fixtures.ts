/**
 * THE INBOX'S DEMO CONVERSATIONS — fixture data only (S2-19 I1b, SCRUM-579).
 *
 * Ten fictional conversations and six fictional staff, written fresh for this
 * story. Nothing here is copied from the park's export: every name, handle,
 * phone number and line of text is invented, the phones sit in a block no
 * real subscriber holds in the seed (+66 81 000 09xx), and every staff name
 * says "Demo" so nobody reading a staging screen mistakes one for a colleague.
 *
 * The spread is deliberate, so every screen and filter has something to show:
 *   channels    5 WhatsApp, 3 Instagram, 2 Facebook
 *   categories  4 birthdays, 4 general, 2 marketing
 *   languages   5 EN, 2 RU, 3 TH
 *   statuses    7 active (5 of them waiting on staff — AI lines do not count
 *               as an answer), 3 handled
 *
 * THE SHAPE IS THE SIMULATOR'S. Each conversation is what a simulator scenario
 * plays (plan §2.1, `POST /inbox/simulator/scenario`, Cut B): the customer's
 * inbound messages with their handle and timing, the classification hint the
 * simulator supplies (§3.1 — nothing live classifies yet), and the staff
 * side's replies. `./inbox-demo.ts` inserts it directly today; once I2's
 * ingest lands, the inbound half goes through the signed webhook instead and
 * this file does not change.
 */
import type { InboxCategory } from '../schema/inbox';

export type DemoLanguage = 'en' | 'ru' | 'th';
export type DemoBranch = 'central' | 'chalong';

/** The demo channel accounts: simulator twins of the park's numbers and pages. */
export const DEMO_CHANNEL_ACCOUNTS = {
  wa_central: {
    channel: 'whatsapp',
    externalId: 'demo-whatsapp-central',
    displayName: 'Demo WhatsApp · Central Floresta',
    branch: 'central',
  },
  wa_chalong: {
    channel: 'whatsapp',
    externalId: 'demo-whatsapp-chalong',
    displayName: 'Demo WhatsApp · Robinson Chalong',
    branch: 'chalong',
  },
  instagram: { channel: 'instagram', externalId: 'demo-instagram', displayName: 'Demo Instagram', branch: null },
  facebook: { channel: 'facebook', externalId: 'demo-facebook', displayName: 'Demo Facebook', branch: null },
} as const satisfies Record<
  string,
  { channel: 'whatsapp' | 'instagram' | 'facebook'; externalId: string; displayName: string; branch: DemoBranch | null }
>;
export type DemoChannelKey = keyof typeof DEMO_CHANNEL_ACCOUNTS;

/**
 * Six demo staff, each standing in one place of the IT Brief's structure.
 * `rule` is the routing slot the demo names them on (only while that slot is
 * still blank — see `./inbox-demo.ts`); `team` is the department-scoped
 * `inbox_agent` grant that puts them in a team; the GM is manual-only — no
 * team, `inbox_manager` operator-wide — and is never picked by routing.
 */
export const DEMO_STAFF = {
  bday_enru: {
    name: 'Demo Anya (Birthdays EN/RU)',
    phone: '+66810000901',
    team: 'birthdays',
    role: 'inbox_agent',
  },
  bday_enru_backup: {
    name: 'Demo Vera (Birthdays EN/RU backup)',
    phone: '+66810000902',
    team: 'birthdays',
    role: 'inbox_agent',
  },
  bday_th: {
    name: 'Demo Fon (Birthdays TH)',
    phone: '+66810000903',
    team: 'birthdays',
    role: 'inbox_agent',
  },
  bday_th_backup: {
    name: 'Demo Pim (Birthdays TH backup)',
    phone: '+66810000904',
    team: 'birthdays',
    role: 'inbox_agent',
  },
  marketing: {
    name: 'Demo Mila (Marketing)',
    phone: '+66810000905',
    team: 'marketing',
    role: 'inbox_agent',
  },
  gm: {
    name: 'Demo Hana (GM)',
    phone: '+66810000906',
    team: null,
    role: 'inbox_manager',
  },
} as const satisfies Record<
  string,
  {
    name: string;
    phone: string;
    team: 'birthdays' | 'marketing' | null;
    role: 'inbox_agent' | 'inbox_manager';
  }
>;
export type DemoStaffKey = keyof typeof DEMO_STAFF;

/** The known password of every demo staff account (local, CI and staging only). */
export const DEMO_STAFF_PASSWORD = 'inboxdemo1234';

/**
 * Which demo person the demo names on which blank routing rule:
 * (team, category, language) → primary and backup. The reception rules stay
 * team-primary: a reception desk is a phone, never a person (IT Brief).
 */
export const DEMO_RULE_PEOPLE: Array<{
  team: 'birthdays' | 'marketing';
  category: InboxCategory;
  language: DemoLanguage | null;
  primary: DemoStaffKey;
  backup: DemoStaffKey;
}> = [
  { team: 'birthdays', category: 'birthdays', language: 'en', primary: 'bday_enru', backup: 'bday_enru_backup' },
  { team: 'birthdays', category: 'birthdays', language: 'ru', primary: 'bday_enru', backup: 'bday_enru_backup' },
  { team: 'birthdays', category: 'birthdays', language: 'th', primary: 'bday_th', backup: 'bday_th_backup' },
  { team: 'marketing', category: 'marketing', language: null, primary: 'marketing', backup: 'gm' },
];

/** Who owns a demo thread: a person, or a reception desk (a team primary). */
export type DemoAssignee = { staff: DemoStaffKey } | { reception: DemoBranch };

export interface DemoMessage {
  from: 'customer' | 'staff' | 'ai';
  /** Required when `from` is `staff`. */
  staff?: DemoStaffKey;
  text: string;
  /** How long before the script runs this was sent, so "today" is always today. */
  minutesAgo: number;
}

export interface DemoConversation {
  /** Stable key: the thread's external ids and the contact handle derive from it. */
  key: string;
  account: DemoChannelKey;
  contact: {
    /** The channel's handle: an E.164 phone on WhatsApp, a scoped id elsewhere. */
    handle: string;
    displayName: string;
    phone: string | null;
  };
  /** What the simulator would say about it (plan §3.1 `ClassificationHint`). */
  hint: { category: InboxCategory; intent: string; language: DemoLanguage; branch: DemoBranch | null };
  primary: DemoAssignee;
  support: DemoStaffKey[];
  /** Handled threads say by whom; the rest are active. */
  handledBy?: DemoStaffKey;
  messages: DemoMessage[];
}

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    key: 'demo-01',
    account: 'wa_central',
    contact: { handle: '+66810000911', displayName: 'Sarah Demo', phone: '+66810000911' },
    hint: { category: 'birthdays', intent: 'birthday enquiry', language: 'en', branch: null },
    primary: { staff: 'bday_enru' },
    support: ['bday_enru_backup'],
    messages: [
      { from: 'customer', text: "Hi! My son turns 6 next month — do you do birthday parties?", minutesAgo: 95 },
      {
        from: 'ai',
        text: 'Here are our birthday packages 🎂. One moment please — our birthday manager will be with you shortly to confirm the date and details.',
        minutesAgo: 94,
      },
      { from: 'staff', staff: 'bday_enru', text: 'Hello Sarah! Happy to help. Which weekend were you thinking of, and roughly how many kids?', minutesAgo: 80 },
      { from: 'customer', text: 'Saturday the 14th, around 12 kids.', minutesAgo: 20 },
    ],
  },
  {
    key: 'demo-02',
    account: 'wa_central',
    contact: { handle: '+66810000912', displayName: 'Dmitri Demo', phone: '+66810000912' },
    hint: { category: 'birthdays', intent: 'birthday follow-up', language: 'ru', branch: 'central' },
    primary: { staff: 'bday_enru' },
    support: ['bday_enru_backup'],
    messages: [
      { from: 'customer', text: 'Здравствуйте! Хотим отметить день рождения дочки у вас. Есть свободные даты в декабре?', minutesAgo: 300 },
      { from: 'staff', staff: 'bday_enru', text: 'Здравствуйте, Дмитрий! Да, есть несколько дат. Сколько будет детей?', minutesAgo: 280 },
      { from: 'customer', text: 'Около 8 детей и 6 взрослых.', minutesAgo: 270 },
      { from: 'staff', staff: 'bday_enru_backup', text: 'Отлично, отправлю варианты пакетов сегодня.', minutesAgo: 260 },
    ],
  },
  {
    key: 'demo-03',
    account: 'instagram',
    contact: { handle: 'ig-demo-noon', displayName: 'Noon Demo', phone: null },
    hint: { category: 'birthdays', intent: 'birthday enquiry', language: 'th', branch: null },
    primary: { staff: 'bday_th' },
    support: ['bday_th_backup'],
    messages: [
      { from: 'customer', text: 'สวัสดีค่ะ อยากจัดงานวันเกิดให้ลูกที่สวนสนุก มีแพ็กเกจอะไรบ้างคะ', minutesAgo: 45 },
    ],
  },
  {
    key: 'demo-04',
    account: 'wa_chalong',
    contact: { handle: '+66810000914', displayName: 'Krit Demo', phone: '+66810000914' },
    hint: { category: 'birthdays', intent: 'event booking', language: 'th', branch: 'chalong' },
    primary: { staff: 'bday_th' },
    support: ['bday_th_backup'],
    handledBy: 'bday_th',
    messages: [
      { from: 'customer', text: 'สอบถามจัดงานโรงเรียนประมาณ 30 คนค่ะ', minutesAgo: 1500 },
      { from: 'staff', staff: 'bday_th', text: 'สวัสดีค่ะ ได้เลยค่ะ เดี๋ยวส่งรายละเอียดให้นะคะ', minutesAgo: 1480 },
      { from: 'customer', text: 'ขอบคุณค่ะ', minutesAgo: 1470 },
    ],
  },
  {
    key: 'demo-05',
    account: 'wa_central',
    contact: { handle: '+66810000915', displayName: 'Emma Demo', phone: '+66810000915' },
    hint: { category: 'general', intent: 'opening times', language: 'en', branch: 'central' },
    primary: { reception: 'central' },
    support: [],
    handledBy: 'gm',
    messages: [
      { from: 'customer', text: 'What time do you open on Sundays?', minutesAgo: 600 },
      { from: 'ai', text: 'We are open every day from 10:00 to 20:00. See you soon! 🎈', minutesAgo: 599 },
      { from: 'customer', text: 'Great, thanks!', minutesAgo: 590 },
    ],
  },
  {
    key: 'demo-06',
    account: 'wa_chalong',
    contact: { handle: '+66810000916', displayName: 'Ploy Demo', phone: '+66810000916' },
    hint: { category: 'general', intent: 'lost items', language: 'th', branch: 'chalong' },
    primary: { reception: 'chalong' },
    support: [],
    messages: [
      { from: 'customer', text: 'เมื่อวานลืมกระเป๋าน้ำสีฟ้าไว้ที่สวนค่ะ', minutesAgo: 30 },
      {
        from: 'ai',
        text: 'Thanks for reaching out. One of our reception team will check and reply to you very shortly.',
        minutesAgo: 29,
      },
    ],
  },
  {
    key: 'demo-07',
    account: 'facebook',
    contact: { handle: 'fb-demo-liam', displayName: 'Liam Demo', phone: null },
    hint: { category: 'general', intent: 'pricing', language: 'en', branch: 'central' },
    primary: { reception: 'central' },
    support: [],
    messages: [
      { from: 'customer', text: 'How much is entry for one child and two adults?', minutesAgo: 120 },
      { from: 'staff', staff: 'gm', text: "Hi Liam! I'll ask our Central team to send you today's prices.", minutesAgo: 100 },
      { from: 'customer', text: 'Thanks — and do adults need socks too?', minutesAgo: 10 },
    ],
  },
  {
    key: 'demo-08',
    account: 'facebook',
    contact: { handle: 'fb-demo-olga', displayName: 'Olga Demo', phone: null },
    hint: { category: 'general', intent: 'on-site complaints', language: 'ru', branch: 'central' },
    primary: { reception: 'central' },
    support: ['gm'],
    handledBy: 'gm',
    messages: [
      { from: 'customer', text: 'Сегодня в кафе долго ждали заказ, около 40 минут.', minutesAgo: 2000 },
      {
        from: 'ai',
        text: 'Thank you for letting us know. Please hold on — our reception team will be with you right away.',
        minutesAgo: 1999,
      },
      { from: 'staff', staff: 'gm', text: 'Ольга, приносим извинения. Мы разобрались с кухней, спасибо, что сообщили.', minutesAgo: 1900 },
    ],
  },
  {
    key: 'demo-09',
    account: 'instagram',
    contact: { handle: 'ig-demo-creator', displayName: 'Jess Demo', phone: null },
    hint: { category: 'marketing', intent: 'influencer requests', language: 'en', branch: null },
    primary: { staff: 'marketing' },
    support: ['gm'],
    messages: [
      { from: 'customer', text: "Hi! I make family travel videos and would love to feature the park. Can we talk collab?", minutesAgo: 200 },
      { from: 'ai', text: 'Thanks for the message! Our marketing team will get back to you shortly.', minutesAgo: 199 },
    ],
  },
  {
    key: 'demo-10',
    account: 'instagram',
    contact: { handle: 'ig-demo-mike', displayName: 'Mike Demo', phone: null },
    hint: { category: 'marketing', intent: 'online / brand complaints', language: 'en', branch: null },
    primary: { staff: 'marketing' },
    support: ['gm'],
    messages: [
      { from: 'customer', text: 'Your website said open till 21:00 but you closed at 20:00.', minutesAgo: 400 },
      {
        from: 'ai',
        text: 'Thank you for letting us know. Please hold on — a member of our team will be with you right away to look into this.',
        minutesAgo: 399,
      },
      { from: 'staff', staff: 'marketing', text: "Sorry about that, Mike — we've corrected the hours online. Thanks for flagging it.", minutesAgo: 350 },
    ],
  },
];
