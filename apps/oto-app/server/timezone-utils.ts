export interface TimezoneInfo {
  timezone: string;
  offsetHours: number;
  offsetMinutes: number;
  offsetString: string;
}

/**
 * Get the current timezone offset for a specific date using Intl.DateTimeFormat
 * This properly handles DST transitions
 */
export function getTimezoneOffsetForDate(timezone: string, date: Date = new Date()): { hours: number; minutes: number } {
  try {
    // Use Intl.DateTimeFormat to get the correct offset for this date (handles DST)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    
    const parts = formatter.formatToParts(date);
    const timeZonePart = parts.find(p => p.type === 'timeZoneName');
    
    if (timeZonePart) {
      // Extract offset from format like "GMT+07:00" or "GMT-05:00" or "GMT+5:30"
      const match = timeZonePart.value.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
      if (match) {
        const sign = match[1] === '+' ? 1 : -1;
        const hours = parseInt(match[2], 10);
        const minutes = parseInt(match[3] || '0', 10);
        return { hours: sign * hours, minutes: sign >= 0 ? minutes : -minutes };
      }
    }
    
    // Fallback: calculate offset by comparing UTC time with timezone-adjusted time
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    const diffMs = tzDate.getTime() - utcDate.getTime();
    const diffMins = Math.round(diffMs / (60 * 1000));
    const hours = Math.floor(diffMins / 60);
    const minutes = diffMins % 60;
    return { hours, minutes: Math.abs(minutes) };
  } catch {
    // Default to Asia/Bangkok if timezone is invalid
    return { hours: 7, minutes: 0 };
  }
}

export function getTimezoneInfo(timezone: string, date: Date = new Date()): TimezoneInfo {
  const offset = getTimezoneOffsetForDate(timezone, date);
  const totalMinutes = offset.hours * 60 + offset.minutes;
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absHours = Math.abs(Math.floor(totalMinutes / 60));
  const absMinutes = Math.abs(totalMinutes % 60);
  const offsetString = `${sign}${String(absHours).padStart(2, '0')}:${String(absMinutes).padStart(2, '0')}`;
  
  return {
    timezone,
    offsetHours: offset.hours,
    offsetMinutes: offset.minutes,
    offsetString,
  };
}

/**
 * Get the local date string (YYYY-MM-DD) for a given UTC date in the specified timezone
 * Uses Intl.DateTimeFormat for proper DST handling
 */
export function getLocalDateString(utcDate: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(utcDate);
    
    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    
    return `${year}-${month}-${day}`;
  } catch {
    // Fallback for invalid timezone
    return utcDate.toISOString().split('T')[0];
  }
}

export function formatParkSignedDate(date: Date): string {
  const [year, month, day] = getLocalDateString(date, 'Asia/Bangkok').split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Get the local time string (HH:MM:SS) for a given UTC date in the specified timezone
 */
export function getLocalTimeString(utcDate: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(utcDate);
    
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    const second = parts.find(p => p.type === 'second')?.value;
    
    return `${hour}:${minute}:${second}`;
  } catch {
    return utcDate.toISOString().split('T')[1].split('.')[0];
  }
}

/**
 * Create a Date object from a date string and time string in a specific timezone
 * Properly handles DST by using the actual offset for that date/time combination
 */
export function createDateTimeInTimezone(dateStr: string, timeStr: string, timezone: string): Date {
  // Create a temporary date to determine the offset for this date
  const tempDate = new Date(`${dateStr}T${timeStr}Z`);
  const tzInfo = getTimezoneInfo(timezone, tempDate);
  
  // Parse with the correct offset for this date
  return new Date(`${dateStr}T${timeStr}${tzInfo.offsetString}`);
}

/**
 * Get midnight (00:00:00) in a specific timezone for a given date
 */
export function getMidnightInTimezone(dateStr: string, timezone: string): Date {
  return createDateTimeInTimezone(dateStr, '00:00:00', timezone);
}

/**
 * Format a date for display in a specific timezone
 */
export function formatDateTimeInTimezone(utcDate: Date, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      ...options,
    }).format(utcDate);
  } catch {
    return utcDate.toISOString();
  }
}

export const SUPPORTED_TIMEZONES = [
  { value: 'Asia/Bangkok', label: 'Bangkok' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Asia/Jakarta', label: 'Jakarta' },
  { value: 'Asia/Manila', label: 'Manila' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh' },
  { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur' },
  { value: 'Asia/Kolkata', label: 'Mumbai/Kolkata' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
  { value: 'UTC', label: 'UTC' },
];
