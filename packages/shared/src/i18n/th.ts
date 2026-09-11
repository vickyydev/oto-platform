import type { MessageKey } from './en';

/**
 * Thai message file. Values carried over from the prototype dictionary where
 * it already had approved Thai copy; anything new is marked TODO(translate)
 * per CLAUDE.md §7.5 (placeholders allowed, English is the source).
 */
export const th: Record<MessageKey, string> = {
  'till.identify.membersSave': 'สมาชิกประหยัดกว่า',
  'till.identify.title': 'คุณเป็นสมาชิกหรือไม่?',
  'till.identify.subtitle': 'กรอกเบอร์โทรเพื่อรับราคาสมาชิก ลูกค้าใหม่ข้ามขั้นตอนนี้ได้',
  'till.identify.phoneLabel': 'เบอร์โทรศัพท์',
  'till.identify.find': 'ค้นหาสมาชิกของฉัน',
  'till.identify.skip': 'ฉันไม่ใช่สมาชิก — ข้าม',
  'common.language': 'ภาษา',
};
