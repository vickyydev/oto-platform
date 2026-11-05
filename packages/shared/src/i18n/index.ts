/**
 * i18n scaffold — ALL FIVE customer-facing languages (en zh th ru fr) with
 * the real approved strings carried over from the prototype dictionary
 * (`apps/pos/src/i18n/dictionary.ts`), not placeholders. English is the
 * source language; the POS consults this table first and falls back to its
 * full prototype dictionary for keys not yet migrated here.
 */
export const SUPPORTED_LANGS = ['en', 'zh', 'th', 'ru', 'fr'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

type Entry = Record<SupportedLang, string>;

export const messages: Record<string, Entry> = {
  'display.reconnecting': {
    en: 'Reconnecting',
    th: 'กำลังเชื่อมต่อใหม่',
    zh: '正在重新连接', ru: 'Переподключение', fr: 'Reconnexion',
  },
  'display.connectionPaused': {
    en: 'Connection paused, your order is safe',
    th: 'การเชื่อมต่อหยุดชั่วคราว คำสั่งซื้อของคุณปลอดภัย',
    zh: '连接已暂停，您的订单是安全的', ru: 'Соединение приостановлено, ваш заказ в безопасности', fr: 'Connexion interrompue, votre commande est en sécurité',
  },
  'till.identify.membersSave': {
    en: 'Members save',
    zh: '会员享优惠',
    th: 'สมาชิกประหยัดกว่า',
    ru: 'Участники экономят',
    fr: 'Les membres économisent',
  },
  // SCRUM-762 — the number is asked once, at the start, and it is required:
  // no skip, and a line saying why it is needed.
  'till.identify.title': {
    en: "What's your phone number?",
    zh: '您的电话号码是多少？',
    th: 'เบอร์โทรศัพท์ของคุณคืออะไร?',
    ru: 'Ваш номер телефона?',
    fr: 'Quel est votre numéro de téléphone ?',
  },
  'till.identify.subtitle': {
    en: 'Members are recognised automatically and get their member rate.',
    zh: '会员会被自动识别，并享受会员价格。',
    th: 'ระบบจะจำสมาชิกได้โดยอัตโนมัติและใช้ราคาสมาชิกให้',
    ru: 'Участников мы узнаём автоматически и применяем цену для участников.',
    fr: 'Les membres sont reconnus automatiquement et obtiennent leur tarif membre.',
  },
  'till.identify.safety': {
    en: "We need a phone number for every visit, so we can reach you about your child's safety.",
    zh: '为了孩子的安全，每次来访我们都需要一个电话号码，以便随时联系您。',
    th: 'เราขอเบอร์โทรศัพท์ทุกครั้งที่มา เพื่อให้ติดต่อคุณได้เรื่องความปลอดภัยของลูก',
    ru: 'Номер телефона нужен при каждом визите, чтобы мы могли связаться с вами по поводу безопасности ребёнка.',
    fr: 'Nous demandons un numéro de téléphone à chaque visite, pour pouvoir vous joindre au sujet de la sécurité de votre enfant.',
  },
  'common.language': {
    en: 'Language',
    zh: '语言',
    th: 'ภาษา',
    ru: 'Язык',
    fr: 'Langue',
  },
};

/** Scaffold lookup: undefined when the key/language is not yet migrated. */
export function lookupMessage(lang: string, key: string): string | undefined {
  return messages[key]?.[lang as SupportedLang];
}
