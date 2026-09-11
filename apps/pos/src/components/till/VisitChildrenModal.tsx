import { useEffect, useState } from 'react';
import { Baby, Loader2, ShieldAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import type { Member, SavedChild } from '@/types';
import { membersApi, visitsApi } from '@/api/platform';
import { apiChildToSavedChild } from '@/api/mappers';

interface VisitChildrenModalProps {
  open: boolean;
  member: Member | null;
  onClose: () => void;
  /** Called with the refreshed children after the visit is confirmed. */
  onConfirmed: (children: SavedChild[], visitId: string) => void;
}

/**
 * SCRUM-32 — after a membership lookup, staff pick which saved children are
 * visiting today and re-confirm each one's details (allergies editable in
 * place, following the prototype's "offer, never silently apply" rule from
 * SavedChildrenReview). Confirming creates a draft visit via the API.
 */
export function VisitChildrenModal({ open, member, onClose, onConfirmed }: VisitChildrenModalProps) {
  const children = member?.savedChildren ?? [];
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [allergyDrafts, setAllergyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(Object.fromEntries(children.map((c) => [c.id, true])));
      setAllergyDrafts(Object.fromEntries(children.map((c) => [c.id, c.allergiesMedical ?? ''])));
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member?.id]);

  if (!member) return null;

  const selectedIds = children.filter((c) => selected[c.id]).map((c) => c.id);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Persist allergy edits first (each edit is audited server-side).
      const updated: SavedChild[] = [];
      for (const c of children) {
        const draft = (allergyDrafts[c.id] ?? '').trim();
        const original = (c.allergiesMedical ?? '').trim();
        if (draft !== original) {
          const res = await membersApi.updateChild(c.id, { allergies: draft || null });
          updated.push(apiChildToSavedChild(res.child));
        } else {
          updated.push(c);
        }
      }
      const visit = await visitsApi.create({ memberId: member.id, childIds: selectedIds });
      toast({
        title: 'Visit confirmed',
        description:
          selectedIds.length > 0
            ? `${selectedIds.length} child${selectedIds.length > 1 ? 'ren' : ''} confirmed for today.`
            : 'Visit recorded with no children.',
      });
      onConfirmed(updated, visit.id);
      onClose();
    } catch (err) {
      toast({
        title: "Couldn't confirm the visit",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Baby className="w-5 h-5 text-primary" />
            Who's visiting today?
          </DialogTitle>
          <DialogDescription>
            {member.nickname}'s saved children. Confirm who's here and double-check
            allergies — nothing is applied without your confirmation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 max-h-[50vh] overflow-y-auto pr-1">
          {children.map((c) => (
            <div
              key={c.id}
              className={`rounded-xl border p-3 flex flex-col gap-2 transition-colors ${
                selected[c.id] ? 'border-primary/50 bg-primary/5' : 'border-border'
              }`}
            >
              <label className="flex items-center gap-3 cursor-pointer">
                <Checkbox
                  checked={!!selected[c.id]}
                  onCheckedChange={(v) => setSelected((s) => ({ ...s, [c.id]: v === true }))}
                />
                <span className="font-semibold">{c.childName}</span>
                <span className="text-sm text-muted-foreground">
                  {c.dateOfBirth ? `DOB ${c.dateOfBirth}` : `${c.childAge} yrs`}
                </span>
              </label>
              <div className="flex items-start gap-2 pl-8">
                <ShieldAlert className="w-4 h-4 mt-2.5 shrink-0 text-amber-500" />
                <input
                  value={allergyDrafts[c.id] ?? ''}
                  onChange={(e) => setAllergyDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                  placeholder="Allergies / medical — none recorded"
                  className="flex-1 h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          ))}
          {children.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No saved children on this membership yet.
            </p>
          )}
        </div>

        <div className="flex gap-3 pt-1">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
            Skip for now
          </Button>
          <Button className="flex-1" onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {selectedIds.length > 0
              ? `Confirm ${selectedIds.length} child${selectedIds.length > 1 ? 'ren' : ''}`
              : 'Confirm visit'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
