/**
 * A former employee invited to one shift (SCRUM-1038): the words and the
 * rules the server's answers and the scheduling screen share, so the two never
 * say it differently. No imports: the client bundle and the server both read it.
 *
 * The owner's answer (19 November 2026): the shift is paid on the old
 * contract, "with an option to switch and work on casual day rate as well".
 */

/** How the shift is paid: on the person's last contract (the default), or on a casual day rate. */
export const SINGLE_SHIFT_PAY_BASES = ["old_contract", "casual_day_rate"] as const;
export type SingleShiftPayWay = (typeof SINGLE_SHIFT_PAY_BASES)[number];

/** The mark the shift carries in Scheduling. */
export const SINGLE_SHIFT_MARK = "Single shift · former employee";

export const OLD_CONTRACT_LABEL = "On the old contract";
export const CASUAL_DAY_RATE_LABEL = "Casual day rate";

/** A casual day rate as a casual worker's is entered: whole baht a day, more than zero. */
export function validCasualDayRate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Whole baht with thousands separators, the way the casual workers page shows a day rate. */
export function bahtText(amount: number): string {
  const fixed = Math.round(amount * 100) / 100;
  const [whole, cents] = fixed.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents === "00" ? `฿${grouped}` : `฿${grouped}.${cents}`;
}

/** The way a shift is paid, in words: "On the old contract" or "Casual day rate ฿1,200 a day". */
export function singleShiftPayLabel(way: SingleShiftPayWay, casualDayRate: number | null | undefined): string {
  if (way === "casual_day_rate") {
    return validCasualDayRate(casualDayRate) ? `${CASUAL_DAY_RATE_LABEL} ${bahtText(casualDayRate)} a day` : CASUAL_DAY_RATE_LABEL;
  }
  return OLD_CONTRACT_LABEL;
}

/**
 * The way a shift is paid, with no figure: what the activity log says
 * ("on the old contract", "on a casual day rate"). The log is read by more
 * people than the pay is; the rate stays on the invitation only.
 */
export function singleShiftWayWords(way: SingleShiftPayWay): string {
  return way === "casual_day_rate" ? "on a casual day rate" : "on the old contract";
}

/**
 * Why an invitation is refused, in the words the screen shows as they are.
 * The past-date rules are the schedule's own ("Cannot assign shifts on past
 * dates", "Cannot modify schedules for past dates", routes.ts); the rate is a
 * casual worker's rate as the casual workers page takes it.
 */
export const SINGLE_SHIFT_REFUSALS = {
  notFormer: "Only a former employee can be invited to a single shift. A current employee is scheduled as usual.",
  pastDate: "A single shift cannot be added on a past date.",
  rate: "Enter the casual day rate in whole baht, more than zero.",
  pastChange: "The pay of a shift on a past date cannot be changed.",
} as const;

/**
 * What the kiosk shows a former employee about their single shift
 * (SCRUM-1055, the owner's answer R7: they "also see their schedule for that
 * day"): on the tablet at that branch, on that day, when they clock in or
 * out. The shift's own times, its name in the schedule, the department and
 * role it is in, the branch, and the break the schedule gives them. Never how
 * it is paid, never anybody else's shift, never another day.
 */
export interface SingleShiftKioskView {
  shiftDate: string;
  /** "HH:MM", the schedule's own times. */
  startTime: string;
  endTime: string;
  /** The shift's name in the schedule ("Morning"), when it has one. */
  label: string | null;
  department: string | null;
  role: string | null;
  branchName: string;
  /** The breaks the schedule gives this person on this shift ("HH:MM"); none when it gives none. */
  breaks: Array<{ startTime: string; endTime: string }>;
}

/** "09:00 – 15:00", the kiosk's words for a shift's or a break's times. */
export function kioskShiftTimes(start: string, end: string): string {
  return `${start.slice(0, 5)} – ${end.slice(0, 5)}`;
}
