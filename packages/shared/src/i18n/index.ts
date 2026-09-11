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
  'till.identify.membersSave': {
    en: 'Members save',
    zh: '会员享优惠',
    th: 'สมาชิกประหยัดกว่า',
    ru: 'Участники экономят',
    fr: 'Les membres économisent',
  },
  'till.identify.title': {
    en: 'Are you a member?',
    zh: '您是会员吗？',
    th: 'คุณเป็นสมาชิกหรือไม่?',
    ru: 'Вы участник?',
    fr: 'Êtes-vous membre ?',
  },
  'till.identify.subtitle': {
    en: 'Enter your phone to get your member rate. New here? You can skip this.',
    zh: '输入您的手机号码以获取会员价格。第一次来？您可以跳过此步骤。',
    th: 'กรอกเบอร์โทรศัพท์เพื่อรับราคาสมาชิก มาครั้งแรกใช่ไหม? คุณสามารถข้ามได้',
    ru: 'Введите номер телефона, чтобы получить цену для участников. Впервые у нас? Можно пропустить.',
    fr: "Entrez votre numéro pour obtenir le tarif membre. Nouveau ici ? Vous pouvez ignorer cette étape.",
  },
  'till.identify.findMembership': {
    en: 'Find my membership',
    zh: '查找我的会员',
    th: 'ค้นหาสมาชิกของฉัน',
    ru: 'Найти мою карту участника',
    fr: 'Trouver mon adhésion',
  },
  'till.identify.skip': {
    en: "I'm not a member — skip",
    zh: '我不是会员——跳过',
    th: 'ฉันไม่ใช่สมาชิก — ข้าม',
    ru: 'Я не участник — пропустить',
    fr: 'Je ne suis pas membre — ignorer',
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
