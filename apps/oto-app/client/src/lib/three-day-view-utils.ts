import { startOfDay, addDays, startOfWeek, startOfMonth } from "date-fns";

export type TimelineMode = "day" | "3day" | "week" | "month";

export type ThreeDayAction = 
  | "ENTER_3_DAY_VIEW"
  | "PRESS_TODAY"
  | "NAV_NEXT"
  | "NAV_PREV"
  | "SELECT_DATE";

export interface DateRangeResult {
  startDate: Date;
  endDate: Date;
}

export function getToday(): Date {
  return startOfDay(new Date());
}

export function getThreeDayRangeAnchor(params: {
  action: ThreeDayAction;
  currentStartDate?: Date;
  selectedDate?: Date;
}): DateRangeResult {
  const { action, currentStartDate, selectedDate } = params;
  
  let startDate: Date;
  
  switch (action) {
    case "ENTER_3_DAY_VIEW":
    case "PRESS_TODAY":
      startDate = getToday();
      break;
    case "NAV_NEXT":
      startDate = addDays(currentStartDate || getToday(), 3);
      break;
    case "NAV_PREV":
      startDate = addDays(currentStartDate || getToday(), -3);
      break;
    case "SELECT_DATE":
      startDate = startOfDay(selectedDate || getToday());
      break;
    default:
      startDate = getToday();
  }
  
  return {
    startDate,
    endDate: addDays(startDate, 2),
  };
}

export function getDateRangeForMode(mode: TimelineMode, currentDate: Date): DateRangeResult {
  const date = startOfDay(currentDate);
  
  switch (mode) {
    case "day":
      return { startDate: date, endDate: date };
    case "3day":
      return { startDate: date, endDate: addDays(date, 2) };
    case "week":
      return { startDate: date, endDate: addDays(date, 6) };
    case "month":
      return { 
        startDate: startOfMonth(date), 
        endDate: addDays(startOfMonth(addDays(date, 32)), -1) 
      };
    default:
      return { startDate: date, endDate: date };
  }
}

export function getAnchorDateForModeChange(
  newMode: TimelineMode,
  currentMode: TimelineMode,
  currentDate: Date
): Date {
  const today = getToday();
  
  switch (newMode) {
    case "3day":
      return today;
    case "day":
      return today;
    case "week":
      return startOfWeek(today, { weekStartsOn: 1 });
    case "month":
      return startOfMonth(today);
    default:
      return currentDate;
  }
}

export function navigateDate(
  mode: TimelineMode,
  currentDate: Date,
  direction: "prev" | "next"
): Date {
  const offset = direction === "prev" ? -1 : 1;
  
  switch (mode) {
    case "day":
      return addDays(currentDate, offset);
    case "3day":
      return addDays(currentDate, offset * 3);
    case "week":
      return addDays(currentDate, offset * 7);
    case "month":
      return new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1);
    default:
      return currentDate;
  }
}

export function goToTodayForMode(mode: TimelineMode): Date {
  const today = getToday();
  
  switch (mode) {
    case "day":
    case "3day":
      return today;
    case "week":
      return startOfWeek(today, { weekStartsOn: 1 });
    case "month":
      return startOfMonth(today);
    default:
      return today;
  }
}
