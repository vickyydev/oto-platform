import { useEffect, useState } from 'react';
import { AlertTriangle, Baby, ChevronDown, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
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
import { membersApi, visitsApi, type ApiChild } from '@/api/platform';
import { apiChildToSavedChild } from '@/api/mappers';
import {
  ChildDetailsFields,
  childDetailsDraft,
  childDetailsPatch,
  childDetailsSummary,
  type ChildDetailsDraft,
} from '@/components/shared/ChildDetailsFields';

interface VisitChildrenModalProps {
  open: boolean;
  member: Member | null;
  onClose: () => void;
  /** Called with the refreshed children after the visit is confirmed. */
  onConfirmed: (children: SavedChild[], visitId: string) => void;
}

/**
 * SCRUM-32 — after a membership lookup, staff pick which saved children are
 * visiting today and re-confirm each one's details in place, following the
 * prototype's "offer, never silently apply" rule from SavedChildrenReview.
 * Confirming creates a draft visit via the API.
 *
 * SCRUM-231 — and re-confirming now covers everything the record holds.
 * Until this ticket the step edited ALLERGIES and nothing else, while the
 * child carried a medical alert, medical notes, dietary needs, food
 * restrictions and staff notes that no screen in the POS would show. The
 * fields are the prototype's (see `components/shared/ChildDetailsFields`),
 * and they are read from `GET /members/:id` rather than from the looked-up
 * member, because the POS `Member` type drops the medical alert and the
 * medical notes on its way through the mapper — editing a record through a
 * shape that cannot hold half of it is how a field gets silently cleared.
 *
 * Until that read lands — and if it fails outright — the step still works on
 * what the lookup already carried: the child list, the allergy line and the
 * confirm are all there, and that allergy line is then the only thing sent.
 */
export function VisitChildrenModal({ open, member, onClose, onConfirmed }: VisitChildrenModalProps) {
  const children = member?.savedChildren ?? [];
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [allergyDrafts, setAllergyDrafts] = useState<Record<string, string>>({});
  /** The children as the API holds them; null until the read lands, or if it fails. */
  const [records, setRecords] = useState<ApiChild[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ChildDetailsDraft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(Object.fromEntries(children.map((c) => [c.id, true])));
      setAllergyDrafts(Object.fromEntries(children.map((c) => [c.id, c.allergiesMedical ?? ''])));
      setRecords(null);
      setDrafts({});
      setExpanded({});
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member?.id]);

  const memberId = member?.id;
  useEffect(() => {
    if (!open || !memberId) return;
    let live = true;
    membersApi
      .get(memberId)
      .then((res) => {
        if (!live) return;
        setRecords(res.member.children);
        setDrafts(Object.fromEntries(res.member.children.map((c) => [c.id, childDetailsDraft(c)])));
        // What needs checking is already open: a child carrying a medical
        // alert or an allergy is the one a first-aider has to read before
        // this family walks in, not one to be found behind a chevron.
        setExpanded(
          Object.fromEntries(
            res.member.children
              .filter((c) => c.medicalAlert || c.allergies)
              .map((c) => [c.id, true]),
          ),
        );
      })
      .catch(() => {
        if (live) setRecords(null);
      });
    return () => {
      live = false;
    };
  }, [open, memberId]);

  if (!member) return null;

  const selectedIds = children.filter((c) => selected[c.id]).map((c) => c.id);
  const recordById = new Map((records ?? []).map((c) => [c.id, c]));

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Persist the edits first (each one is audited server-side), then open
      // the visit — a visit confirmed against details that did not save would
      // be the counter believing something the record does not say.
      const updated: SavedChild[] = [];
      for (const c of children) {
        const record = recordById.get(c.id);
        const draft = drafts[c.id];
        if (record && draft) {
          const patch = childDetailsPatch(childDetailsDraft(record), draft);
          if (patch) {
            const res = await membersApi.updateChild(c.id, patch);
            updated.push(apiChildToSavedChild(res.child));
            continue;
          }
          updated.push(c);
          continue;
        }
        // No full record for this child (the detail read did not land): the
        // allergy line is the only thing on screen and the only thing sent.
        const allergyDraft = (allergyDrafts[c.id] ?? '').trim();
        const original = (c.allergiesMedical ?? '').trim();
        if (allergyDraft !== original) {
          const res = await membersApi.updateChild(c.id, { allergies: allergyDraft || null });
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
          {children.map((c) => {
            const draft = drafts[c.id];
            const isOpen = !!expanded[c.id];
            return (
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
                  <span className="min-w-0 truncate font-semibold">{c.childName}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {c.dateOfBirth ? `DOB ${c.dateOfBirth}` : `${c.childAge} yrs`}
                  </span>
                  {draft?.medicalAlert && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-red-400">
                      <AlertTriangle className="w-3 h-3" />
                      Medical alert
                    </span>
                  )}
                </label>

                {draft ? (
                  <div className="pl-8">
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => ({ ...e, [c.id]: !isOpen }))}
                      className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 shrink-0" />
                      )}
                      <span className="shrink-0 font-medium">Details</span>
                      {/* `min-w-0` is what lets `truncate` shrink this: a flex
                          item will not go below its own text width without it,
                          and a long allergy line would widen the modal. */}
                      <span className="ml-auto min-w-0 truncate pl-2 text-right text-xs">
                        {childDetailsSummary(draft) || 'Nothing recorded'}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="mt-2 rounded-lg border p-3">
                        <ChildDetailsFields
                          draft={draft}
                          idPrefix={`visit-child-${c.id}`}
                          showName={false}
                          onChange={(next) =>
                            setDrafts((prev) => ({ ...prev, [c.id]: { ...prev[c.id]!, ...next } }))
                          }
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2 pl-8">
                    <ShieldAlert className="w-4 h-4 mt-2.5 shrink-0 text-amber-500" />
                    <input
                      value={allergyDrafts[c.id] ?? ''}
                      onChange={(e) => setAllergyDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      placeholder="Allergies / medical — none recorded"
                      className="flex-1 h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}
              </div>
            );
          })}
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
