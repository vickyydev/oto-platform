import { EyeOff } from 'lucide-react';

type Json = Record<string, unknown> | null | undefined;

/**
 * Does this value look like something the API masked on the way out?
 *
 * The console does not decide what is personal — the API does, and it sends a
 * marker in place of the value. Several markers are recognised because the
 * masking lands route by route: a bullet-run, a bracketed word, or an object
 * saying so. Anything unrecognised is shown as it arrived, which is the safe
 * direction: it can only ever under-claim that something is hidden.
 */
export function isMaskedValue(value: unknown): boolean {
  if (value && typeof value === 'object' && 'masked' in (value as Record<string, unknown>)) {
    return Boolean((value as { masked?: unknown }).masked);
  }
  if (typeof value !== 'string') return false;
  // `[redacted]` is what apps/api/src/routes/audit.ts writes in place of a
  // personal value; the rest are the other markers masking has worn.
  return /•{2,}|^[[<]?(masked|redacted)[\]>]?$|^\*{3,}$/i.test(value);
}

/** The stand-in for a value a reader is not being shown. */
function Masked() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <EyeOff className="w-3 h-3" />
      hidden
    </span>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (isMaskedValue(value)) return <Masked />;
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean')
    return <span className="font-mono text-xs">{value ? 'true' : 'false'}</span>;
  if (typeof value === 'number') return <span className="font-mono text-xs tabular-nums">{value}</span>;
  if (typeof value === 'string')
    return <span className="break-words">{value === '' ? <em className="text-muted-foreground">empty</em> : value}</span>;
  return (
    <code className="block whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
      {JSON.stringify(value)}
    </code>
  );
}

function label(key: string): string {
  // camelCase and snake_case both appear in audit payloads; neither reads well
  // in a column someone is scanning.
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * What changed, field by field. Only the fields that differ, because a record
 * with forty unchanged columns hides the one that moved.
 */
export function RecordDiff({ before, after }: { before: Json; after: Json }) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).sort();

  /**
   * A masked field is the same stand-in on both sides, so it can never look
   * changed — which would quietly tell a reader that a child's allergy note
   * stayed the same when nobody here can know that. Masked fields are pulled
   * out of the comparison and named underneath instead.
   */
  const hidden = keys.filter((k) => isMaskedValue((before ?? {})[k]) || isMaskedValue((after ?? {})[k]));
  const changed = keys.filter(
    (k) => !hidden.includes(k) && JSON.stringify((before ?? {})[k]) !== JSON.stringify((after ?? {})[k]),
  );

  if (!before && !after) {
    return <p className="text-sm text-muted-foreground">This action recorded no before or after state.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {changed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing changed in the fields you can see.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {changed.map((key) => (
            <li key={key} className="py-2.5 first:pt-0 last:pb-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
                {label(key)}
              </p>
              <div className="mt-1 grid gap-1 sm:grid-cols-2 text-sm">
                {before && (
                  <div className="min-w-0">
                    <span className="text-xs text-muted-foreground">was </span>
                    <Scalar value={before[key]} />
                  </div>
                )}
                {after && (
                  <div className="min-w-0">
                    <span className="text-xs text-muted-foreground">now </span>
                    <Scalar value={after[key]} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Also in this record, hidden:{' '}
            <span className="font-medium text-foreground/70">
              {hidden.map((key) => label(key)).join(', ')}
            </span>{' '}
            — whether they changed cannot be told from a masked read.
          </span>
        </p>
      )}
    </div>
  );
}

/** Every field of the record as it arrived — masking included, never undone here. */
export function RecordFields({ record }: { record: Json }) {
  const keys = Object.keys(record ?? {});
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">No record was stored with this entry.</p>;
  }
  return (
    <ul className="flex flex-col divide-y">
      {keys.sort().map((key) => (
        <li key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45 sm:w-40 shrink-0">
            {label(key)}
          </span>
          <span className="text-sm min-w-0 flex-1">
            <Scalar value={(record ?? {})[key]} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The record as JSON, wrapped rather than scrolled sideways. */
export function RawRecord({ record }: { record: unknown }) {
  return (
    <pre className="rounded-xl border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
      {JSON.stringify(record ?? null, null, 2)}
    </pre>
  );
}
