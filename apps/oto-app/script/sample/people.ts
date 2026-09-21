/**
 * The invented staff list behind `script/sample/main.ts`.
 *
 * Every person here is made up. None of these names, nicknames, phone numbers
 * or dates came from the park's export — they were written to match its
 * SHAPES (a Thai legal name plus a short nickname staff are actually called, a
 * handful of foreign hires with visa and work-permit dates, a spread of start
 * dates, a few people part way out the door) and its PROPORTIONS, and nothing
 * else. The export holds real children and real staff and never leaves a
 * laptop.
 *
 * Two things mark the rows as sample data without making the screens look
 * broken: every address is on `sample.oto.test` — `.test` is reserved by
 * RFC 2606 and can never be a real domain, so nothing here can mail a real
 * person — and every phone number is in the `+6695500xxxx` block this file
 * owns. Search either and you have found the seed.
 */

/** Which of the seeded departments a person sits in. */
export type DeptKey = 'reception' | 'restaurant' | 'floor' | 'nanny' | 'events' | 'management';

export interface SamplePerson {
  /** Stable within the seed, and what re-runs match on. Never shown. */
  key: string;
  fullName: string;
  thaiName: string | null;
  nickname: string;
  dept: DeptKey;
  /** Names from ROLES below. The first is the primary one. */
  roles: string[];
  status: 'pending' | 'active' | 'resigned' | 'terminated';
  employmentState: 'ACTIVE' | 'LEAVING' | 'LEFT';
  /** Months before today the person started. */
  startedMonthsAgo: number;
  employmentBasis: 'FULL_TIME' | 'PART_TIME';
  /** THB per day, part-timers only — the column is for them alone. */
  dailyRate?: number;
  nationality: string;
  isForeignStaff: boolean;
  /** 0 = Sunday … 6 = Saturday, as `employees.weekly_off_days` counts. */
  weeklyOffDays: number[];
  phoneSuffix: string;
}

export const DEPARTMENTS: { key: DeptKey; name: string; description: string; order: number }[] = [
  { key: 'reception', name: 'Reception', description: 'The front desk, admissions and the membership check.', order: 1 },
  { key: 'restaurant', name: 'Restaurant', description: 'Kitchen, counter and the coffee bar.', order: 2 },
  { key: 'floor', name: 'Floor', description: 'The play floor — supervision, safety and the slides.', order: 3 },
  { key: 'nanny', name: 'Nanny', description: 'Supervised care, drop-off and one-to-one nannies.', order: 4 },
  { key: 'events', name: 'Events', description: 'Birthday parties, camps and school groups.', order: 5 },
  { key: 'management', name: 'Management', description: 'Duty managers and the branch office.', order: 6 },
];

export const ROLES: { name: string; description: string }[] = [
  { name: 'Receptionist', description: 'Takes admissions at the desk and answers the phone.' },
  { name: 'Cashier', description: 'Runs the till and closes the drawer.' },
  { name: 'Floor Supervisor', description: 'Runs a floor shift and is responsible for safety.' },
  { name: 'Play Leader', description: 'Runs games and watches a zone of the floor.' },
  { name: 'Nanny', description: 'Supervises a named child, drop-off or one-to-one.' },
  { name: 'Party Host', description: 'Runs a birthday party from welcome to cake.' },
  { name: 'Head Chef', description: 'Owns the menu, the orders and the kitchen.' },
  { name: 'Cook', description: 'Cooks the line during service.' },
  { name: 'Server', description: 'Takes orders and runs food to tables.' },
  { name: 'Barista', description: 'Coffee bar and the drinks side of the counter.' },
  { name: 'Duty Manager', description: 'Holds the branch for a shift and signs things off.' },
  { name: 'Maintenance', description: 'Keeps the equipment, the soft play and the building going.' },
];

export const PEOPLE: SamplePerson[] = [
  { key: 'ploy', fullName: 'Siriporn Thongchai', thaiName: 'ศิริพร ทองชัย', nickname: 'Ploy', dept: 'reception', roles: ['Receptionist', 'Cashier'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 29, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1], phoneSuffix: '0101' },
  { key: 'bank', fullName: 'Nattapong Wichaikul', thaiName: 'ณัฐพงศ์ วิชัยกุล', nickname: 'Bank', dept: 'floor', roles: ['Floor Supervisor', 'Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 34, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2], phoneSuffix: '0102' },
  { key: 'mint', fullName: 'Kanyarat Srisuwan', thaiName: 'กัญญารัตน์ ศรีสุวรรณ', nickname: 'Mint', dept: 'reception', roles: ['Cashier', 'Receptionist'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 17, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [3], phoneSuffix: '0103' },
  { key: 'golf', fullName: 'Thanakorn Phuwanat', thaiName: 'ธนกร ภูวนาถ', nickname: 'Golf', dept: 'floor', roles: ['Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 11, employmentBasis: 'PART_TIME', dailyRate: 620, nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1, 2], phoneSuffix: '0104' },
  { key: 'fern', fullName: 'Pimchanok Ruangsri', thaiName: 'พิมพ์ชนก เรืองศรี', nickname: 'Fern', dept: 'nanny', roles: ['Nanny'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 22, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [4], phoneSuffix: '0105' },
  { key: 'tar', fullName: 'Apichat Boonmee', thaiName: 'อภิชาติ บุญมี', nickname: 'Tar', dept: 'restaurant', roles: ['Head Chef', 'Cook'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 41, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1], phoneSuffix: '0106' },
  { key: 'nan', fullName: 'Wanida Chaimongkol', thaiName: 'วนิดา ชัยมงคล', nickname: 'Nan', dept: 'restaurant', roles: ['Server'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 14, employmentBasis: 'PART_TIME', dailyRate: 580, nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2, 3], phoneSuffix: '0107' },
  { key: 'jack', fullName: 'Sarawut Intharat', thaiName: 'สราวุธ อินทรัตน์', nickname: 'Jack', dept: 'floor', roles: ['Maintenance', 'Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 26, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [0], phoneSuffix: '0108' },
  { key: 'bow', fullName: 'Chayada Petchmanee', thaiName: 'ชญาดา เพชรมณี', nickname: 'Bow', dept: 'nanny', roles: ['Nanny'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 8, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [5], phoneSuffix: '0109' },
  { key: 'aum', fullName: 'Ekkachai Sangthong', thaiName: 'เอกชัย แสงทอง', nickname: 'Aum', dept: 'restaurant', roles: ['Cook'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 19, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [3], phoneSuffix: '0110' },
  { key: 'gift', fullName: 'Supaporn Klinmalai', thaiName: 'สุภาพร กลิ่นมาลัย', nickname: 'Gift', dept: 'reception', roles: ['Receptionist'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 6, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [4], phoneSuffix: '0111' },
  { key: 'ton', fullName: 'Teerapat Chanthawong', thaiName: 'ธีรภัทร จันทวงศ์', nickname: 'Ton', dept: 'floor', roles: ['Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 13, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2], phoneSuffix: '0112' },
  { key: 'mook', fullName: 'Jiraporn Meesuk', thaiName: 'จิราพร มีสุข', nickname: 'Mook', dept: 'events', roles: ['Party Host', 'Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 24, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1], phoneSuffix: '0113' },
  { key: 'beer', fullName: 'Panupong Saetang', thaiName: 'ภาณุพงศ์ แซ่ตั้ง', nickname: 'Beer', dept: 'restaurant', roles: ['Barista', 'Server'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 9, employmentBasis: 'PART_TIME', dailyRate: 600, nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [0, 1], phoneSuffix: '0114' },
  { key: 'ice', fullName: 'Nichakarn Duangjai', thaiName: 'ณิชกานต์ ดวงใจ', nickname: 'Ice', dept: 'reception', roles: ['Cashier'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 4, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [5], phoneSuffix: '0115' },
  { key: 'off', fullName: 'Worawut Kittichai', thaiName: 'วรวุฒิ กิตติชัย', nickname: 'Off', dept: 'floor', roles: ['Play Leader'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 16, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [3], phoneSuffix: '0116' },
  { key: 'pui', fullName: 'Ratchanee Pongsak', thaiName: 'รัชนี พงษ์ศักดิ์', nickname: 'Pui', dept: 'nanny', roles: ['Nanny'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 31, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2], phoneSuffix: '0117' },
  { key: 'boss', fullName: 'Kittisak Larpwong', thaiName: 'กิตติศักดิ์ ลาภวงศ์', nickname: 'Boss', dept: 'management', roles: ['Duty Manager'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 38, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1], phoneSuffix: '0118' },
  { key: 'emma', fullName: 'Emma Lindqvist', thaiName: null, nickname: 'Emma', dept: 'events', roles: ['Party Host'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 12, employmentBasis: 'FULL_TIME', nationality: 'Swedish', isForeignStaff: true, weeklyOffDays: [0], phoneSuffix: '0119' },
  { key: 'dan', fullName: 'Daniel Whitfield', thaiName: null, nickname: 'Dan', dept: 'management', roles: ['Duty Manager'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 20, employmentBasis: 'FULL_TIME', nationality: 'British', isForeignStaff: true, weeklyOffDays: [4], phoneSuffix: '0120' },
  { key: 'praew', fullName: 'Phatcharin Yodkaew', thaiName: 'พัชรินทร์ ยอดแก้ว', nickname: 'Praew', dept: 'restaurant', roles: ['Server'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 3, employmentBasis: 'PART_TIME', dailyRate: 560, nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2, 4], phoneSuffix: '0121' },
  { key: 'chai', fullName: 'Somchai Tanaphon', thaiName: 'สมชาย ธนาพร', nickname: 'Chai', dept: 'floor', roles: ['Floor Supervisor'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 45, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [5], phoneSuffix: '0122' },
  { key: 'pang', fullName: 'Kulthida Namwong', thaiName: 'กุลธิดา น้ำวงศ์', nickname: 'Pang', dept: 'reception', roles: ['Receptionist'], status: 'active', employmentState: 'LEAVING', startedMonthsAgo: 27, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [3], phoneSuffix: '0123' },
  { key: 'win', fullName: 'Anuwat Rungruang', thaiName: 'อนุวัฒน์ รุ่งเรือง', nickname: 'Win', dept: 'floor', roles: ['Play Leader'], status: 'resigned', employmentState: 'LEFT', startedMonthsAgo: 33, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [1], phoneSuffix: '0124' },
  { key: 'may', fullName: 'Suwanan Pitakkul', thaiName: 'สุวนันท์ พิทักษ์กุล', nickname: 'May', dept: 'nanny', roles: ['Nanny'], status: 'pending', employmentState: 'ACTIVE', startedMonthsAgo: 0, employmentBasis: 'FULL_TIME', nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [2], phoneSuffix: '0125' },
  { key: 'nok', fullName: 'Benjawan Sukhothai', thaiName: 'เบญจวรรณ สุโขทัย', nickname: 'Nok', dept: 'events', roles: ['Party Host', 'Server'], status: 'active', employmentState: 'ACTIVE', startedMonthsAgo: 7, employmentBasis: 'PART_TIME', dailyRate: 640, nationality: 'Thai', isForeignStaff: false, weeklyOffDays: [0, 3], phoneSuffix: '0126' },
];

/** The domain is reserved by RFC 2606: nothing here can reach a real inbox. */
export const SAMPLE_EMAIL_DOMAIN = 'sample.oto.test';
/**
 * `+66` then five fixed digits, leaving the four in `phoneSuffix` — twelve
 * characters in all, which is what an E.164 Thai mobile is. One grep for the
 * prefix finds every number this seed wrote and nothing else.
 */
export const SAMPLE_PHONE_PREFIX = '+6695500';

export const emailFor = (p: SamplePerson): string => {
  const surname = p.fullName.trim().split(/\s+/).slice(-1)[0]!.toLowerCase();
  return `${p.nickname.toLowerCase()}.${surname}@${SAMPLE_EMAIL_DOMAIN}`;
};
export const phoneFor = (p: SamplePerson): string => `${SAMPLE_PHONE_PREFIX}${p.phoneSuffix}`;
