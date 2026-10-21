import type { AdminBranch } from '../accounts/LoginUsersPanel';
import { permissionWords, scopeWords } from './presentation';

interface PermissionAtScope { permission: string; words?: string; scopeType: string; scopeId: string | null }

/** Render the server's diff verbatim; overlapping roles are resolved by the API. */
export function PermissionDiffView({ added, removed, branches }: {
  added: readonly PermissionAtScope[];
  removed: readonly PermissionAtScope[];
  branches: readonly AdminBranch[];
}) {
  return <div className="flex min-w-0 flex-col gap-4 text-sm">
    {([['Added access', added], ['Removed access', removed]] as const).map(([heading, rows]) => <section key={heading}>
      <h3 className="font-bold">{heading} ({rows.length})</h3>
      {rows.length === 0 ? <p className="mt-1 text-foreground/50">None.</p> : <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row, index) => <li key={`${row.permission}-${row.scopeType}-${row.scopeId}-${index}`}
          className="min-w-0 rounded-lg border border-foreground/10 px-3 py-2">
          <p>{row.words ?? permissionWords(row.permission)}</p>
          <p className="mt-1 break-words text-xs text-foreground/50">{scopeWords(row.scopeType, row.scopeId, branches)}</p>
          <code className="mt-1 block break-all text-[11px] text-foreground/45">{row.permission}</code>
        </li>)}
      </ul>}
    </section>)}
  </div>;
}
