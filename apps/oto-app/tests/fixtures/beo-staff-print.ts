// SCRUM-1028 — ZZ TEST parties for the Staff BEO print (server/pdf.ts beoPdfHtml): no real
// family, no real number; the dish and drink names are menu words only. Read by
// tests/beo-staff-print.check.ts, and by a local render to a PDF and pictures.
import { buildBeoTimeline, type BeoTimelineSource } from "../../shared/beoTimeline";
import { beoPdfTimelineOf, type BeoPdfData } from "../../server/pdf";

/** The print's own type of the menus wants a count on every line; a stored line may have none (it prints as 1). */
type Menus = NonNullable<NonNullable<BeoPdfData["kitchenPlan"]>["menus"]>;
/** A line as the BEO stores it. */
type Line = { id: string; itemName: string; quantity?: number; notes?: string; price?: number; included?: boolean; source?: string; productCode?: string; groupId?: string };
let n = 0;
const id = () => `zz-1028-${++n}`;
export const set = (itemName: string, group: string, quantity?: number): Line => ({ id: id(), itemName, notes: `(${group})`, source: "set_menu", included: true, price: 0, groupId: `g-${group}`, ...(quantity === undefined ? {} : { quantity }) });
export const dish = (itemName: string, quantity?: number, over: Partial<Line> = {}): Line => ({ id: id(), itemName, source: "additional", included: false, ...(quantity === undefined ? {} : { quantity }), ...over });

/** The stored BEO's parts a timeline is built from, as the route reads them. */
function timelineOf(src: BeoTimelineSource) {
  return beoPdfTimelineOf(buildBeoTimeline(src));
}

const kidsSet = [
  set("Hawaiian", "Pizza 1"),
  set("Margherita", "Pizza 2"),
  set("Pepperoni", "Pizza 3"),
  set("Fried rice", "Rice"),
  set("Fish fingers", "Fish"),
  set("French fries", "Sides", 3),
];
const kidsExtra = [
  dish("Fruit skewers", 2, { price: 120 }),
  dish("Vegetable sticks", 2, { price: 90, notes: "no dip" }),
  dish("Mini waffles"),
];
const adults = [
  dish("Smoked Salmon Pizza", 2, { price: 450 }),
  dish("Caesar salad", 3, { price: 220 }),
  dish("Chicken wings", undefined, { price: 180 }),
];
const acts = [
  { id: "act-1", customName: "ZZ TEST Bubble show", startTime: "12:00", person: "ZZ TEST Host Noi" },
  { id: "act-2", customName: "ZZ TEST Treasure hunt", startTime: "13:00", person: "ZZ TEST Floor team" },
  { id: "act-3", customName: "ZZ TEST Magic", startTime: null, person: null },
];
const bar = { serviceTime: "11:30", items: [
  { id: id(), itemName: "Mors", quantity: 2, source: "set_menu" },
  { id: id(), itemName: "Lemonade", quantity: 2, price: 90 },
  { id: id(), itemName: "Water" },
] };
const menus = { kids: [...kidsSet, ...kidsExtra], adults, adultsDiffer: true, kidsFoodTime: "11:30", adultsFoodTime: "12:15" };
const typedRow = { id: "row-1", label: "ZZ TEST Pinata", offsetFromStartMinutes: 150, isSystemGenerated: false, sourceKey: null, isCompleted: false, sortOrder: 1, assignedToType: "PARTY_HOST" };

/** A normal party: every part of the page filled once. */
export const normalParty: BeoPdfData = {
  eventTitle: "ZZ TEST Birthday Party",
  eventDate: "2099-12-05",
  startTime: "11:00",
  endTime: "14:00",
  status: "confirmed",
  childName: "ZZ TEST Child",
  kidTurningAge: 6,
  bookingName: "ZZ TEST Booking",
  parentName: "ZZ TEST Parent",
  whatsappPhone: "ZZ TEST WhatsApp",
  numChildren: 11,
  numAdults: 10,
  programName: "ZZ TEST Basic program",
  activities: "ZZ TEST games and dancing",
  decoration: "ZZ TEST unicorn balloons",
  locationText: "ZZ TEST Party Room A",
  allergiesNotes: "ZZ TEST: one child has a nut allergy",
  specialRequests: "ZZ TEST: Preordered food (฿7,290) agreed with the family",
  partyHost: { assignedName: "ZZ TEST Host Noi", backupName: "ZZ TEST Host Ben" },
  setupPlan: {
    readyBy: "10:00",
    responsible: "ZZ TEST Setup team",
    tasks: [{ itemLabel: "ZZ TEST Balloon arch", notes: "pink and gold" }, { itemLabel: "ZZ TEST Table cloths" }],
    notes: "ZZ TEST one long table for the kids",
  },
  kitchenPlan: {
    required: true,
    menus: menus as unknown as Menus,
    setMenuEnabled: true,
    setMenuTemplateName: "ZZ TEST Set Central",
    setMenuSelectionStatus: { isSubmitted: true, submittedAt: "2099-11-30T05:00:00.000Z" },
    cakeMode: "INTERNAL",
    cakeQuantity: 1,
    cakeTime: "13:30",
    cakeNotes: "Mix flavour",
    cakeIncluded: true,
    notes: "ZZ TEST kitchen note: pizzas cut in eight",
  },
  barPlan: bar,
  partyDetails: {
    packageName: "ZZ TEST Weekend Birthday",
    items: [
      { label: "ZZ TEST Kids' table", type: "included", price: 0 },
      { label: "ZZ TEST Photo zone", type: "extra", price: 500, notes: "PRO" },
    ],
    depositDate: "2099-11-20",
    notes: "ZZ TEST POS note",
  },
  till: { status: "not_reachable", message: "ZZ TEST no till here" },
  packageSnapshot: { packageName: "ZZ TEST Weekend Birthday", kidsIncluded: 10, adultsIncluded: 4, includedSummary: "play, basic program, cake (ice cream)" },
  entertainmentActs: acts,
  branchName: "ZZ TEST Park",
  branchAddress: "ZZ TEST address",
  parkTimeZone: "Asia/Bangkok",
  ...timelineOf({
    startTime: "11:00",
    endTime: "14:00",
    setupPlan: { setupRequired: true, setupTasks: { readyBy: "10:00", simplifiedTasks: [{ itemLabel: "ZZ TEST Balloon arch" }, { itemLabel: "ZZ TEST Table cloths" }] } },
    kitchenPlan: { foodRequired: true, menus, cakeMode: "INTERNAL", cakeTime: "13:30", cakeNotes: "Mix flavour", cakeQuantity: 1, serviceSchedule: [] },
    barPlan: bar,
    activities: acts,
    rows: [typedRow],
  }),
};

/** A long order: enough dishes, drinks, acts and notes for more than one page. */
export function longParty(): BeoPdfData {
  const many = (prefix: string, count: number, over: (i: number) => Partial<Line> = () => ({})) =>
    Array.from({ length: count }, (_, i) => dish(`${prefix} ${String(i + 1).padStart(2, "0")}`, (i % 4) + 1, over(i)));
  const longKids = [...kidsSet, ...many("ZZ TEST kids dish", 34, (i) => (i % 3 === 0 ? { price: 100 + i, notes: "cut small, no chilli, served warm on the side" } : {}))];
  const longAdults = many("ZZ TEST adults dish with a long name that has to wrap inside its column", 22, (i) => ({ price: 300 + i * 5 }));
  const longBar = { serviceTime: "11:30", items: many("ZZ TEST drink", 28, (i) => ({ price: 60 + i })) };
  const longActs = Array.from({ length: 9 }, (_, i) => ({ id: `long-act-${i}`, customName: `ZZ TEST activity ${i + 1}`, startTime: `${String(11 + Math.floor(i / 3)).padStart(2, "0")}:${["00", "20", "40"][i % 3]}`, person: i % 2 ? "ZZ TEST Host Noi" : null }));
  const longMenus = { kids: longKids, adults: longAdults, adultsDiffer: true, kidsFoodTime: "11:30", adultsFoodTime: "12:00" };
  return {
    ...normalParty,
    eventTitle: "ZZ TEST Long Order Party",
    kitchenPlan: { ...normalParty.kitchenPlan!, menus: longMenus as unknown as Menus },
    barPlan: longBar,
    entertainmentActs: longActs,
    specialRequests: Array.from({ length: 6 }, (_, i) => `ZZ TEST request ${i + 1}: a long note written by the team that runs over more than one line of the column.`).join("\n"),
    ...timelineOf({
      startTime: "11:00",
      endTime: "14:00",
      setupPlan: { setupRequired: true, setupTasks: { readyBy: "10:00", simplifiedTasks: [] } },
      kitchenPlan: { foodRequired: true, menus: longMenus, cakeMode: "INTERNAL", cakeTime: "13:30", cakeNotes: "Mix flavour", cakeQuantity: 1, serviceSchedule: [] },
      barPlan: longBar,
      activities: longActs,
      rows: [typedRow],
    }),
  };
}

/** Thai and English side by side: names, dishes, an activity and notes. */
const thaiMenus = { kids: [dish("ข้าวผัดไก่", 4, { notes: "ไม่เผ็ด" }), dish("French fries", 2)], adults: [], adultsDiffer: false, kidsFoodTime: "11:30" };
const thaiActs = [{ id: "act-th", customName: "ZZ TEST มายากล magic show", startTime: "12:30", person: "ZZ TEST พี่โฮสต์" }];
export const thaiParty: BeoPdfData = {
  ...normalParty,
  eventTitle: "ZZ TEST งานวันเกิด น้องทดสอบ",
  childName: "ZZ TEST น้องทดสอบ",
  kitchenPlan: { ...normalParty.kitchenPlan!, setMenuEnabled: false, menus: thaiMenus as unknown as Menus },
  entertainmentActs: thaiActs,
  specialRequests: "ZZ TEST ขอเค้กช็อกโกแลต และ a quiet corner",
  ...timelineOf({
    startTime: "11:00",
    endTime: "14:00",
    kitchenPlan: { foodRequired: true, menus: thaiMenus, cakeMode: "INTERNAL", cakeTime: "13:30", cakeNotes: "Mix flavour", cakeQuantity: 1, serviceSchedule: [] },
    barPlan: bar,
    activities: thaiActs,
  }),
};
