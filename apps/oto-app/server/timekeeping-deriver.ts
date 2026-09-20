import { TimeEvent } from "@shared/schema";
import { getLocalDateString } from "./timezone-utils";

export type AnomalyType = "OPEN_SESSION" | "MISSING_IN" | "MULTIPLE_IN" | "MULTIPLE_OUT" | "LONG_SHIFT" | "LATE_ARRIVAL" | "SCHEDULED_NO_SHOW";

export interface TimekeepingSession {
  id: string;
  employeeId: string;
  inEvent: TimeEvent;
  outEvent: TimeEvent | null;
  durationMinutes: number | null;
  date: string;
}

export interface TimekeepingAnomaly {
  id: string;
  employeeId: string;
  type: AnomalyType;
  description: string;
  relatedEventIds: string[];
  date: string;
  severity: "low" | "medium" | "high";
}

export interface DailyTotal {
  date: string;
  totalMinutes: number;
  totalHours: number;
  sessionCount: number;
  hasLongShift: boolean;
}

export interface EmployeeDaySummary {
  employeeId: string;
  employeeName: string;
  branchId: string | null;
  branchName: string | null;
  date: string;
  firstInTime: Date | null;
  lastOutTime: Date | null;
  totalMinutes: number;
  totalHours: number;
  sessionCount: number;
  anomalies: AnomalyType[];
  hasPinUsed: boolean;
  pinEventsCount: number;
  pinPhotoUrls: string[];
  faceEventsCount: number;
  isOpenSession: boolean;
  isMissingIn: boolean;
  isLongShift: boolean;
  isLateArrival: boolean;
  lateMinutes: number | null;
  scheduledStartTime: string | null;
  isScheduledNoShow: boolean;
}

export interface EmployeeTimekeepingDetail {
  employeeId: string;
  sessions: TimekeepingSession[];
  rawEvents: TimeEvent[];
  dailyTotals: DailyTotal[];
  anomalies: TimekeepingAnomaly[];
  totalHours: number;
  totalSessions: number;
  totalAnomalies: number;
  pinUsageCount: number;
  faceUsageCount: number;
}

const LONG_SHIFT_THRESHOLD_HOURS = 9;
const DEFAULT_TIMEZONE = 'Asia/Bangkok';

function getLocalDate(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return getLocalDateString(date, timezone);
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function deriveSessionsAndAnomalies(events: TimeEvent[]): {
  sessions: TimekeepingSession[];
  anomalies: TimekeepingAnomaly[];
} {
  const sessions: TimekeepingSession[] = [];
  const anomalies: TimekeepingAnomaly[] = [];

  if (events.length === 0) {
    return { sessions, anomalies };
  }

  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime()
  );

  let openIn: TimeEvent | null = null;
  let lastOut: TimeEvent | null = null;

  for (const event of sortedEvents) {
    const eventDate = getLocalDate(new Date(event.eventTime));

    if (event.eventType === "IN") {
      if (openIn !== null) {
        anomalies.push({
          id: generateId(),
          employeeId: event.employeeId,
          type: "MULTIPLE_IN",
          description: `Multiple IN events without OUT between them`,
          relatedEventIds: [openIn.id, event.id],
          date: eventDate,
          severity: "medium",
        });
        // Keep the first open IN, don't replace with later IN (per spec)
      } else {
        openIn = event;
      }
      lastOut = null;
    } else if (event.eventType === "OUT") {
      if (openIn !== null) {
        const durationMs = new Date(event.eventTime).getTime() - new Date(openIn.eventTime).getTime();
        const durationMinutes = Math.round(durationMs / 60000);

        sessions.push({
          id: generateId(),
          employeeId: event.employeeId,
          inEvent: openIn,
          outEvent: event,
          durationMinutes,
          date: getLocalDate(new Date(openIn.eventTime)),
        });

        openIn = null;
        lastOut = event;
      } else {
        anomalies.push({
          id: generateId(),
          employeeId: event.employeeId,
          type: "MISSING_IN",
          description: `OUT event without preceding IN`,
          relatedEventIds: [event.id],
          date: eventDate,
          severity: "high",
        });

        if (lastOut !== null) {
          anomalies.push({
            id: generateId(),
            employeeId: event.employeeId,
            type: "MULTIPLE_OUT",
            description: `Multiple OUT events without IN between them`,
            relatedEventIds: [lastOut.id, event.id],
            date: eventDate,
            severity: "medium",
          });
        }
        lastOut = event;
      }
    }
  }

  if (openIn !== null) {
    const eventDate = getLocalDate(new Date(openIn.eventTime));
    anomalies.push({
      id: generateId(),
      employeeId: openIn.employeeId,
      type: "OPEN_SESSION",
      description: `Clocked IN but not OUT`,
      relatedEventIds: [openIn.id],
      date: eventDate,
      severity: "high",
    });

    sessions.push({
      id: generateId(),
      employeeId: openIn.employeeId,
      inEvent: openIn,
      outEvent: null,
      durationMinutes: null,
      date: eventDate,
    });
  }

  return { sessions, anomalies };
}

export function computeDailyTotals(sessions: TimekeepingSession[]): DailyTotal[] {
  const dailyMap = new Map<string, { totalMinutes: number; sessionCount: number }>();

  for (const session of sessions) {
    if (session.durationMinutes !== null) {
      const existing = dailyMap.get(session.date) || { totalMinutes: 0, sessionCount: 0 };
      existing.totalMinutes += session.durationMinutes;
      existing.sessionCount += 1;
      dailyMap.set(session.date, existing);
    }
  }

  const dailyTotals: DailyTotal[] = [];
  const entries = Array.from(dailyMap.entries());
  for (const [date, data] of entries) {
    const totalHours = Math.round((data.totalMinutes / 60) * 100) / 100;
    dailyTotals.push({
      date,
      totalMinutes: data.totalMinutes,
      totalHours,
      sessionCount: data.sessionCount,
      hasLongShift: totalHours > LONG_SHIFT_THRESHOLD_HOURS,
    });
  }

  return dailyTotals.sort((a, b) => a.date.localeCompare(b.date));
}

export function deriveEmployeeTimekeeping(events: TimeEvent[]): EmployeeTimekeepingDetail {
  const { sessions, anomalies } = deriveSessionsAndAnomalies(events);
  const dailyTotals = computeDailyTotals(sessions);

  for (const daily of dailyTotals) {
    if (daily.hasLongShift) {
      const employeeId = sessions.find(s => s.date === daily.date)?.employeeId;
      if (employeeId && !anomalies.some(a => a.date === daily.date && a.type === "LONG_SHIFT")) {
        anomalies.push({
          id: generateId(),
          employeeId,
          type: "LONG_SHIFT",
          description: `Worked ${daily.totalHours.toFixed(1)} hours (exceeds ${LONG_SHIFT_THRESHOLD_HOURS}h threshold)`,
          relatedEventIds: [],
          date: daily.date,
          severity: "low",
        });
      }
    }
  }

  const pinUsageCount = events.filter(e => e.authMethod === "PIN").length;
  const faceUsageCount = events.filter(e => e.authMethod === "FACE").length;
  const totalHours = dailyTotals.reduce((sum, d) => sum + d.totalHours, 0);

  return {
    employeeId: events[0]?.employeeId || "",
    sessions,
    rawEvents: events,
    dailyTotals,
    anomalies,
    totalHours: Math.round(totalHours * 100) / 100,
    totalSessions: sessions.filter(s => s.outEvent !== null).length,
    totalAnomalies: anomalies.length,
    pinUsageCount,
    faceUsageCount,
  };
}

export function computeEmployeeDaySummary(
  employeeId: string,
  employeeName: string,
  branchId: string | null,
  branchName: string | null,
  date: string,
  events: TimeEvent[]
): EmployeeDaySummary {
  const dayEvents = events.filter(e => getLocalDate(new Date(e.eventTime)) === date);

  if (dayEvents.length === 0) {
    return {
      employeeId,
      employeeName,
      branchId,
      branchName,
      date,
      firstInTime: null,
      lastOutTime: null,
      totalMinutes: 0,
      totalHours: 0,
      sessionCount: 0,
      anomalies: [],
      hasPinUsed: false,
      pinEventsCount: 0,
      pinPhotoUrls: [],
      faceEventsCount: 0,
      isOpenSession: false,
      isMissingIn: false,
      isLongShift: false,
      isLateArrival: false,
      lateMinutes: null,
      scheduledStartTime: null,
      isScheduledNoShow: false,
    };
  }

  const { sessions, anomalies } = deriveSessionsAndAnomalies(dayEvents);
  const dailyTotals = computeDailyTotals(sessions);
  const dayTotal = dailyTotals.find(d => d.date === date);

  const inEvents = dayEvents.filter(e => e.eventType === "IN").sort((a, b) => 
    new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime()
  );
  const outEvents = dayEvents.filter(e => e.eventType === "OUT").sort((a, b) => 
    new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime()
  );

  const firstInTime = inEvents.length > 0 ? new Date(inEvents[0].eventTime) : null;
  const lastOutTime = outEvents.length > 0 ? new Date(outEvents[outEvents.length - 1].eventTime) : null;

  const anomalyTypes = anomalies.map(a => a.type);
  const isOpenSession = anomalyTypes.includes("OPEN_SESSION");
  const isMissingIn = anomalyTypes.includes("MISSING_IN");
  const isLongShift = dayTotal?.hasLongShift || false;

  if (isLongShift && !anomalyTypes.includes("LONG_SHIFT")) {
    anomalyTypes.push("LONG_SHIFT");
  }

  const pinEvents = dayEvents.filter(e => e.authMethod === "PIN");
  const pinEventsCount = pinEvents.length;
  const pinPhotoUrls = pinEvents
    .filter(e => e.photoEvidenceUrl)
    .map(e => e.photoEvidenceUrl as string);
  const faceEventsCount = dayEvents.filter(e => e.authMethod === "FACE").length;

  return {
    employeeId,
    employeeName,
    branchId,
    branchName,
    date,
    firstInTime,
    lastOutTime,
    totalMinutes: dayTotal?.totalMinutes || 0,
    totalHours: dayTotal?.totalHours || 0,
    sessionCount: dayTotal?.sessionCount || 0,
    anomalies: anomalyTypes,
    hasPinUsed: pinEventsCount > 0,
    pinEventsCount,
    pinPhotoUrls,
    faceEventsCount,
    isOpenSession,
    isMissingIn,
    isLongShift,
    isLateArrival: false,  // Set by caller with schedule info
    lateMinutes: null,
    scheduledStartTime: null,
    isScheduledNoShow: false,  // Set by caller with schedule info
  };
}
