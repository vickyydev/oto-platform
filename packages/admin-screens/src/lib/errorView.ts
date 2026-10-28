export interface ErrorField {
  label: string;
  id?: string;
}
export interface ErrorFieldIssue extends ErrorField {
  path: string;
  message: string;
}
export interface ErrorView {
  message: string;
  fieldIssues: ErrorFieldIssue[];
  supportReference?: string;
  retryAfterSeconds?: number;
  requiresFreshRead: boolean;
  uncertain: boolean;
}
type Options = { operation?: 'read' | 'write'; fields?: Readonly<Record<string, ErrorField>> };
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only the public correlation grammar is copyable; no alternate header is a reference. */
export const supportReference = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : undefined;

/** Seconds must be an integer representable by a millisecond UI clock. */
export function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d{1,13}$/.test(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds : undefined;
}

const diagnostic = /\b(?:SQLSTATE|postgres(?:ql)?|SELECT\s.+\sFROM|password|secret|authorization|bearer|cookie|stack trace)\b|https?:\/\/|private[-_]canary|<!doctype|<html|\bat .+\(.+:\d+:\d+\)/i;
function publicReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 600 || diagnostic.test(value)) return undefined;
  return value.trim();
}
function constraint(issue: Record<string, unknown>): string | undefined {
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : undefined;
  const text = issue.origin === 'string' || issue.type === 'string';
  if (issue.code === 'too_small') {
    const minimum = number(issue.minimum);
    if (minimum === undefined) return undefined;
    return text ? `Enter at least ${minimum} character${minimum === 1 ? '' : 's'}.` : issue.inclusive === false ? `Use more than ${minimum}.` : `Use ${minimum} or more.`;
  }
  if (issue.code === 'too_big') {
    const maximum = number(issue.maximum);
    if (maximum === undefined) return undefined;
    return text ? `Use no more than ${maximum} characters.` : issue.inclusive === false ? `Use less than ${maximum}.` : `Use ${maximum} or less.`;
  }
  if (issue.code === 'invalid_type') return issue.expected === 'number' ? 'Enter a number.'
    : issue.expected === 'string' ? 'Enter text.' : issue.expected === 'boolean' ? 'Choose yes or no.' : undefined;
  if (issue.code === 'invalid_value' || issue.code === 'invalid_enum_value') return 'Choose one of the offered options.';
  if ((issue.code === 'invalid_format' || issue.code === 'invalid_string') && (issue.format === 'email' || issue.validation === 'email')) return 'Enter a valid email address.';
  return undefined;
}

/** Known field paths and issue kinds only. Submitted values and free-form issue text stay private. */
function fieldIssues(details: unknown, fields: Options['fields']): ErrorFieldIssue[] {
  if (!fields || !Array.isArray(details)) return [];
  const result: ErrorFieldIssue[] = [];
  for (const value of details) {
    const detail = record(value), path = detail?.instancePath;
    if (typeof path !== 'string' || !Object.hasOwn(fields, path) || result.some(row => row.path === path)) continue;
    const field = fields[path], issue = record(record(detail?.params)?.issue);
    const message = issue ? constraint(issue) : undefined;
    if (field && message) result.push({ ...field, path, message });
    if (result.length === 8) break;
  }
  return result;
}

/** A host-independent, allowlisted public view. It never serializes arbitrary diagnostics. */
export function errorView(error: unknown, options: Options = {}): ErrorView {
  const source = record(error);
  const status = typeof source?.status === 'number' ? source.status : undefined;
  const code = typeof source?.code === 'string' ? source.code : undefined;
  const raw = typeof error === 'string' ? error : source?.message;
  const reason = publicReason(raw);
  const write = options.operation === 'write';
  const fields = status === 400 ? fieldIssues(source?.details, options.fields) : [];
  const reference = supportReference(source?.requestId), wait = retryAfterSeconds(source?.retryAfterSeconds);
  const refusal = status !== undefined && status >= 400 && status < 500;
  const passwordRequired = status === 403 && code === 'MUST_CHANGE_PASSWORD'
    || status === undefined && typeof raw === 'string' && /^Password change required before continuing\.?$/.test(raw);
  const network = !refusal && ((error instanceof Error && error.name === 'NetworkError')
    || typeof raw === 'string' && /^(?:Failed to fetch|Load failed|fetch failed|Network request failed)$/i.test(raw));
  const unexpected = status !== undefined && status >= 500
    || !refusal && !passwordRequired && typeof raw === 'string' && (/^(?:Internal server error|An unexpected error occurred\.?|Unexpected error\.?|Unknown error)$/i.test(raw)
    || diagnostic.test(raw));
  const view: ErrorView = { message: '', fieldIssues: fields, supportReference: reference,
    retryAfterSeconds: wait, requiresFreshRead: status === 409, uncertain: false };
  if (passwordRequired) view.message = 'Password change required before continuing. Change your password, then try again.';
  else if (network || unexpected) {
    view.uncertain = write;
    view.requiresFreshRead = write;
    view.message = write
      ? 'No confirmation came back. The change may have been saved. Read the current settings before trying again.'
      : network ? 'No answer came back. Check your connection and try reading this again.'
        : 'This could not be loaded because the service had a problem. Try reading it again; share the reference if it keeps failing.';
  } else if (status === 401) view.message = 'Your session has ended. Sign in again before continuing.';
  else if (status === 423) view.message = 'This session is locked. Unlock it before continuing.';
  else if (status === 429) view.message = wait !== undefined ? `Too many requests. Wait ${wait} seconds before trying again.` : 'Too many requests. Wait before trying again.';
  else if (status === 400 && (code === 'VALIDATION' || fields.length > 0)) view.message = fields.length > 0
    ? 'Review the highlighted fields, correct the values and try again.' : 'This request was not accepted. Check the entered values and try again.';
  else if (status === 409) view.message = `${reason ?? 'The settings changed while this request was being handled.'} Read the current settings before trying again.`;
  else if (status === 403) view.message = `${reason && !/^(Forbidden|Access denied)$/i.test(reason) ? reason : 'This action is not available on your access.'} Ask someone authorised to manage access in People & access → Accounts or Roles & scopes.`;
  else if (status === 404) view.message = code === 'ROUTE_NOT_FOUND' || code === 'UNKNOWN'
    ? 'This API feature is not available on this deployment. Try again after the service is updated.'
    : `${reason ?? 'The selected record is no longer available here.'} Read the list again and select an available record.`;
  else if (reason && !/^(Bad Request|Request does not match the schema|Validation failed)$/i.test(reason)) view.message = reason;
  else view.message = 'This request was not accepted. Check the entered values and try again.';
  return view;
}
