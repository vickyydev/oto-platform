import { useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminNoticeBanner } from '../NotSavedNotice';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isMissingRoute } from '@/api/client';
import { menuApi, type MenuImportAction, type MenuImportPreview } from '@/api/menu';
import type { MenuCategoryDef, MenuItem, ModifierGroup } from '@/types';
import {
  applyStandIn,
  buildStandInPreview,
  type CurrentMenu,
  type StandInPlan,
  type StandInWriters,
} from './importStandIn';

interface ImportMenuDialogProps {
  open: boolean;
  onClose(): void;
  branchId: string | null;
  items: MenuItem[];
  categories: MenuCategoryDef[];
  modifierGroups: ModifierGroup[];
  codeFor(id: string): string | null;
  writers: StandInWriters;
  /** Re-read the menu after a real commit. */
  onApplied?(): void;
}

const ACTION_LABEL: Record<MenuImportAction, string> = {
  create: 'new',
  update: 'changed',
  archive: 'withdrawn',
  unchanged: 'unchanged',
};

const ACTION_TONE: Record<MenuImportAction, string> = {
  create: 'bg-emerald-400/10 text-emerald-300',
  update: 'bg-sky-400/10 text-sky-300',
  archive: 'bg-amber-400/10 text-amber-300',
  unchanged: 'bg-foreground/[0.06] text-foreground/45',
};

/**
 * Import a menu spreadsheet: choose a file, read what it would change, apply.
 *
 * Nothing is written before Apply. The preview is computed by the platform,
 * which hands back a token; the commit spends that token, so the numbers on
 * screen are the numbers that get applied or the commit is refused. Until those
 * routes are deployed the reading is done here in the browser — the banner says
 * so, and in that mode Apply reaches the same in-memory catalogue every other
 * edit on this screen reaches.
 */
export function ImportMenuDialog({
  open,
  onClose,
  branchId,
  items,
  categories,
  modifierGroups,
  codeFor,
  writers,
  onApplied,
}: ImportMenuDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [plan, setPlan] = useState<StandInPlan | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const menu: CurrentMenu = { items, categories, modifierGroups, codeFor };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setPlan(null);
    setFailure(null);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const close = () => {
    reset();
    onClose();
  };

  const read = async (chosen: File) => {
    setBusy(true);
    setFailure(null);
    setPreview(null);
    setPlan(null);
    setFile(chosen);
    try {
      if (branchId) {
        try {
          const bytes = new Uint8Array(await chosen.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const result = await menuApi.importPreview(branchId, {
            filename: chosen.name,
            contentBase64: btoa(binary),
          });
          setPreview(result);
          return;
        } catch (err) {
          // Any answer but "that route is not on this deployment" is a real
          // answer and belongs on screen — a rejected file must not quietly
          // fall through to a second opinion computed here.
          if (!isMissingRoute(err)) throw err;
        }
      }
      const standIn = await buildStandInPreview(chosen, menu);
      setPreview(standIn.preview);
      setPlan(standIn);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setFailure(null);
    try {
      if (plan) {
        applyStandIn(plan, menu, writers);
      } else if (branchId) {
        await menuApi.importCommit(branchId, { previewToken: preview.previewToken });
        onApplied?.();
      }
      close();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Those changes could not be applied.');
      setBusy(false);
    }
  };

  const blocked = !!preview && preview.errors.length > 0;
  const nothingToDo =
    !!preview &&
    !blocked &&
    preview.counts.create === 0 &&
    preview.counts.update === 0 &&
    preview.counts.archive === 0 &&
    preview.categories.create === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import menu</DialogTitle>
          <DialogDescription>
            An Excel file with a “Menu items” sheet and a “Categories” sheet — the one
            Export gives you. Nothing is saved until you press Apply.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {plan && (
            <AdminNoticeBanner>
              <strong className="font-semibold">Read in this browser — SCRUM-232.</strong>{' '}
              The import routes are not on this deployment, so this file was checked here
              instead of by the platform. Applying it reaches the same in-memory
              catalogue every other edit on this screen reaches: the till sees it, the
              database never does, and a page reload discards it.
            </AdminNoticeBanner>
          )}

          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) void read(chosen);
              }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <FileSpreadsheet className="h-4 w-4" />
              Choose file
            </Button>
            <span className="min-w-0 truncate text-sm text-foreground/50">
              {file ? file.name : 'No file chosen'}
            </span>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-foreground/40" />}
          </div>

          {failure && (
            <p className="rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">
              {failure}
            </p>
          )}

          {preview && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {(['create', 'update', 'archive', 'unchanged'] as const).map((action) => (
                  <span
                    key={action}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${ACTION_TONE[action]}`}
                  >
                    {preview.counts[action]} {ACTION_LABEL[action]}
                  </span>
                ))}
                {preview.categories.create > 0 && (
                  <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-medium tabular-nums text-emerald-300">
                    {preview.categories.create} new{' '}
                    {preview.categories.create === 1 ? 'category' : 'categories'}
                  </span>
                )}
                {preview.errors.length > 0 && (
                  <span className="rounded-full bg-destructive/15 px-2.5 py-1 text-xs font-medium tabular-nums text-destructive">
                    {preview.errors.length}{' '}
                    {preview.errors.length === 1 ? 'problem' : 'problems'}
                  </span>
                )}
              </div>

              {/* Stated here rather than buried in the help sheet: it is the one
                  rule that surprises people, and the moment to say it is while
                  somebody is looking at the counts and deciding. */}
              <p className="text-xs text-foreground/45">
                Anything already on the menu that is not in this file is left exactly as
                it is. An import never removes something you forgot to include — to take
                an item off, put <span className="font-medium text-foreground/70">archive</span>{' '}
                in its action column.
              </p>

              {blocked ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-destructive">
                    Nothing will be applied while the file has problems in it. Every one
                    is listed — fix them and choose the file again.
                  </p>
                  <div className="max-h-72 overflow-y-auto rounded-2xl border border-foreground/10">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background/95 text-xs uppercase tracking-wider text-foreground/40">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold">Row</th>
                          <th className="px-3 py-2 text-left font-semibold">Column</th>
                          <th className="px-3 py-2 text-left font-semibold">What is wrong</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.map((error, i) => (
                          <tr key={i} className="border-t border-foreground/[0.06]">
                            <td className="px-3 py-2 tabular-nums text-foreground/60">
                              {error.row > 0 ? error.row : '—'}
                              <span className="ml-1.5 text-foreground/30">{error.sheet}</span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-foreground/60">
                              {error.column ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-foreground/80">{error.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-2xl border border-foreground/10">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background/95 text-xs uppercase tracking-wider text-foreground/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Item</th>
                        <th className="px-3 py-2 text-left font-semibold">Code</th>
                        <th className="px-3 py-2 text-left font-semibold">What changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows
                        .filter((row) => row.action !== 'unchanged')
                        .map((row) => (
                          <tr key={`${row.row}-${row.code}`} className="border-t border-foreground/[0.06]">
                            <td className="px-3 py-2">
                              <span className="font-medium">{row.name}</span>
                              <span
                                className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${ACTION_TONE[row.action]}`}
                              >
                                {ACTION_LABEL[row.action]}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-foreground/50">
                              {row.code ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-foreground/70">
                              {row.action === 'create' && 'Added to the menu.'}
                              {row.action === 'archive' && 'Withdrawn from the menu.'}
                              {row.action === 'update' &&
                                row.changes.map((c) => (
                                  <span key={c.field} className="mr-3 inline-block">
                                    <span className="text-foreground/40">{c.field}</span>{' '}
                                    <span className="line-through text-foreground/35">
                                      {c.from ?? '—'}
                                    </span>{' '}
                                    → <span className="text-foreground/90">{c.to ?? '—'}</span>
                                  </span>
                                ))}
                            </td>
                          </tr>
                        ))}
                      {nothingToDo && (
                        <tr>
                          <td colSpan={3} className="px-3 py-6 text-center text-sm text-foreground/40">
                            Every row in this file already matches the menu. Nothing to apply.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={!preview || blocked || nothingToDo || busy}>
            <Upload className="h-4 w-4" />
            Apply changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
