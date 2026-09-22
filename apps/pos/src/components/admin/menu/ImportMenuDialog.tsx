import { useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

interface ImportMenuDialogProps {
  open: boolean;
  onClose(): void;
  /** Null when this branch has no row on the platform; the dialog then refuses. */
  branchId: string | null;
  /** Re-read the menu after a commit, so the screens show what was written. */
  onApplied(): void;
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
 * Nothing is written before Apply. The platform parses and validates the file
 * and answers with a token; the commit sends that token **and the same file**,
 * and the token carries a digest of both the file and the menu it was read
 * against — so the numbers on screen are the numbers that get applied, or the
 * commit is refused and says which of the two moved.
 *
 * The file therefore has to survive the wait between the two presses, which is
 * what `content` below is: the base64 the preview was computed from, held until
 * the dialog closes. Nothing is read from the store here — the diff on screen is
 * the platform's, computed against the rows it is about to write.
 */
export function ImportMenuDialog({ open, onClose, branchId, onApplied }: ImportMenuDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  /** The bytes the preview was computed from, as the commit has to send them. */
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setContent(null);
    setPreview(null);
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
    setContent(null);
    setFile(chosen);
    try {
      if (!branchId) {
        setFailure(
          'This branch has no record on the platform yet, so there is nothing to import into.',
        );
        return;
      }
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const contentBase64 = btoa(binary);
      const result = await menuApi.importPreview(branchId, {
        filename: chosen.name,
        contentBase64,
      });
      setContent(contentBase64);
      setPreview(result);
    } catch (err) {
      setFailure(
        isMissingRoute(err)
          ? 'The menu import is not on this deployment yet.'
          : err instanceof Error
            ? err.message
            : 'That file could not be read.',
      );
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || !content || !file || !branchId) return;
    setBusy(true);
    setFailure(null);
    try {
      await menuApi.importCommit(branchId, {
        previewToken: preview.previewToken,
        filename: file.name,
        contentBase64: content,
      });
      onApplied();
      close();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Those changes could not be applied.');
      setBusy(false);
    }
  };

  const blocked = !!preview && preview.errors.length > 0;
  // Both sheets, and all three effects: an export re-imported unchanged has to
  // reach this and leave Apply switched off, rather than offer to write nothing.
  const nothingToDo =
    !!preview &&
    !blocked &&
    preview.counts.create === 0 &&
    preview.counts.update === 0 &&
    preview.counts.archive === 0 &&
    preview.categories.create === 0 &&
    preview.categories.update === 0 &&
    preview.categories.archive === 0;

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
                {preview.categories.update > 0 && (
                  <span className="rounded-full bg-sky-400/10 px-2.5 py-1 text-xs font-medium tabular-nums text-sky-300">
                    {preview.categories.update} changed{' '}
                    {preview.categories.update === 1 ? 'category' : 'categories'}
                  </span>
                )}
                {/* The template ships filled-in example rows. Saying they were
                    skipped is the difference between a person trusting the
                    counts and wondering where three items went. */}
                {preview.counts.ignored > 0 && (
                  <span className="rounded-full bg-foreground/[0.06] px-2.5 py-1 text-xs font-medium tabular-nums text-foreground/45">
                    {preview.counts.ignored} example{' '}
                    {preview.counts.ignored === 1 ? 'row' : 'rows'} ignored
                  </span>
                )}
                {preview.errors.length > 0 && (
                  <span className="rounded-full bg-destructive/15 px-2.5 py-1 text-xs font-medium tabular-nums text-destructive">
                    {preview.errors.length}{' '}
                    {preview.errors.length === 1 ? 'problem' : 'problems'}
                  </span>
                )}
              </div>

              {/* The platform's own sentence, not a second copy of it: this is
                  the one rule that surprises people, and the moment to say it is
                  while somebody is looking at the counts and deciding. */}
              <p className="text-xs text-foreground/45">{preview.notice}</p>

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
                          <tr
                            key={`${row.sheet}-${row.row}`}
                            className="border-t border-foreground/[0.06]"
                          >
                            <td className="px-3 py-2">
                              <span className="font-medium">{row.name}</span>
                              <span
                                className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${ACTION_TONE[row.action]}`}
                              >
                                {ACTION_LABEL[row.action]}
                              </span>
                              <span className="ml-2 text-[11px] text-foreground/30">
                                {row.sheet}
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
