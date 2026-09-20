import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { formatWhen } from '@/lib/time';
import { useSession } from '@/auth/SessionContext';

/**
 * A claim code or a pairing code, shown the only time it can be shown.
 *
 * Only the hash of these is stored, so there is no route that could fetch one
 * back and the page must not imply there is: it says so, plainly, next to the
 * code. The block is deliberately loud — somebody is going to read this out
 * over a phone or type it into an iPad across the counter, and a small grey
 * monospace run of characters is how a `0` becomes an `O`.
 */
export function OneTimeCode({
  label,
  code,
  expiresAt,
  detail,
}: {
  label: string;
  code: string;
  expiresAt?: string | null;
  detail?: string;
}) {
  const { me } = useSession();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused in plenty of ordinary places — an insecure
      // origin, a locked-down browser. The code is on screen either way, which
      // is what it is for.
    }
  };

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        borderColor: 'hsl(var(--status-warn) / 0.35)',
        backgroundColor: 'hsl(var(--status-warn) / 0.08)',
      }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <code className="font-mono text-2xl font-black tracking-[0.2em] break-all">{code}</code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 h-8 text-xs font-semibold text-foreground/70 hover:text-foreground"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {expiresAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          Expires {formatWhen(expiresAt, me?.branch?.timezone)}. After that it has to be issued again.
        </p>
      )}
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
