import assert from "node:assert/strict";
import {
  BIRTHDAY_BRANCH_NAMED_COLORS,
  CAMP_CALENDAR_COLOR,
  OTHER_EVENT_COLOR_OPTIONS,
  RESERVED_CALENDAR_COLORS,
  WORKSHOP_CALENDAR_COLOR,
  getBirthdayBranchFallbackColor,
  getNextBirthdayBranchColor,
  isBirthdayBranchColor,
  isOtherEventColor,
} from "../shared/event-colors";
import { getEventCalendarColor } from "../client/src/lib/event-types";

assert.equal(
  getNextBirthdayBranchColor("BD Chalong", []),
  BIRTHDAY_BRANCH_NAMED_COLORS.chalong,
  "Chalong birthday branches must always be red",
);
assert.equal(
  getNextBirthdayBranchColor("BD Robinson", []),
  BIRTHDAY_BRANCH_NAMED_COLORS.robinson,
  "Robinson birthday branches must always be purple",
);

const firstGenericColor = getNextBirthdayBranchColor("Bangkok", []);
const secondGenericColor = getNextBirthdayBranchColor("Phuket", [firstGenericColor]);
assert.notEqual(firstGenericColor, secondGenericColor, "new branches must receive distinct colors");
assert.notEqual(firstGenericColor, CAMP_CALENDAR_COLOR, "branch colors cannot use Camp emerald");
assert.notEqual(firstGenericColor, WORKSHOP_CALENDAR_COLOR, "branch colors cannot use Workshop orange");
const fallbackColor = getNextBirthdayBranchColor("Generic fallback", [
  "#3b82f6",
  "#ec4899",
  "#06b6d4",
  "#eab308",
]);
assert(!RESERVED_CALENDAR_COLORS.has(fallbackColor), "fallback branch colors cannot be reserved");
assert(!isOtherEventColor(fallbackColor), "fallback branch colors cannot use an Other Event color");
const collidingNamedBranchColor = getNextBirthdayBranchColor(
  "BD Chalong",
  [BIRTHDAY_BRANCH_NAMED_COLORS.chalong],
);
assert.notEqual(
  collidingNamedBranchColor,
  BIRTHDAY_BRANCH_NAMED_COLORS.chalong,
  "a repeated named branch must not collide with an existing tenant assignment",
);
assert(
  isBirthdayBranchColor(collidingNamedBranchColor, "BD Chalong"),
  "a named branch collision fallback must remain a valid persisted birthday color",
);
assert(isBirthdayBranchColor(firstGenericColor, "Bangkok"), "allocated branch colors must be valid");
assert(!isBirthdayBranchColor(CAMP_CALENDAR_COLOR, "Bangkok"), "reserved legacy colors must be repaired");
assert.equal(
  getBirthdayBranchFallbackColor("branch-a"),
  getBirthdayBranchFallbackColor("branch-a"),
  "legacy safety fallback must be stable",
);
assert.notEqual(
  getBirthdayBranchFallbackColor("branch-a"),
  getBirthdayBranchFallbackColor("branch-b"),
  "legacy safety fallback must vary by branch",
);

assert(
  OTHER_EVENT_COLOR_OPTIONS.every(({ value }) => !RESERVED_CALENDAR_COLORS.has(value)),
  "Other Event choices cannot include semantic calendar colors",
);
assert(isOtherEventColor(OTHER_EVENT_COLOR_OPTIONS[0].value), "picker colors must be accepted by the API");
assert(!isOtherEventColor(CAMP_CALENDAR_COLOR), "Camp emerald must be rejected for Other Events");
assert(!isOtherEventColor(WORKSHOP_CALENDAR_COLOR), "Workshop orange must be rejected for Other Events");

assert.equal(
  getEventCalendarColor({
    eventType: "birthday",
    color: "#ffffff",
    branchCalendarColor: BIRTHDAY_BRANCH_NAMED_COLORS.robinson,
    branchId: "robinson",
    branchName: "BD Robinson",
  }),
  BIRTHDAY_BRANCH_NAMED_COLORS.robinson,
  "birthday branch color must win over a stored event color",
);
assert.equal(
  getEventCalendarColor({
    eventType: "birthday",
    branchCalendarColor: null,
    branchId: "legacy-branch",
  }),
  getBirthdayBranchFallbackColor("legacy-branch"),
  "birthday events and legends must share the deterministic legacy fallback",
);
assert.equal(
  getEventCalendarColor({ eventType: "camp", color: "#ffffff" }),
  CAMP_CALENDAR_COLOR,
  "Camp must always use emerald",
);
assert.equal(
  getEventCalendarColor({ eventType: "workshop", color: "#ffffff" }),
  WORKSHOP_CALENDAR_COLOR,
  "Workshop must always use orange",
);
assert.equal(
  getEventCalendarColor({ eventType: "studio_event", color: "#ef4444" }),
  "#ef4444",
  "legacy saved Other Event colors must continue to render",
);

console.log("Calendar event color checks passed.");