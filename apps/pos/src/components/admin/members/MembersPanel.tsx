import { useEffect, useState } from 'react';
import { Pencil, Trash2, Plus, Info, Check, Loader2 } from 'lucide-react';
import type { Member } from '@/types';
// Sprint 1 rebuild: members come from the platform API (mockApi retired here).
import { membersApi, type ApiMember } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { MemberFormDialog, type MemberFormData } from './MemberFormDialog';
import { getDefaultTier } from '@/mockApi';
import { isDefaultTier, tierLabel } from '@/lib/membership';

/**
 * Admin editing screen for member profiles — the customer records that carry a
 * VERIFIED tier entitlement (the discounted expat/Thai rate, keyed by phone).
 * Members are NOT on the reactive catalog store, so this screen holds the list
 * in local state and re-reads getMembers() after every create/update/delete.
 */
export function MembersPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  /**
   * The member as the API holds them, read one at a time (SCRUM-231): the
   * full name, email and staff notes the list row carries but the POS `Member`
   * type does not, and the children WITH their medical fields, which a
   * register row does not carry at all (SCRUM-246).
   */
  const [editingRecord, setEditingRecord] = useState<ApiMember | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);

  const refresh = () =>
    membersApi
      .list()
      .then((res) => setMembers(res.members.map(apiMemberToMember)))
      .catch((err: unknown) =>
        toast({
          title: "Couldn't load members",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        }),
      );

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setEditingMember(null);
    setEditingRecord(null);
    setFormOpen(true);
  };

  /**
   * Read the member before the form opens, rather than opening on the list row
   * and filling in later: the dialog seeds every field from what it is handed,
   * and a form that gains an email halfway through typing is how an edit gets
   * lost. A read that fails opens nothing and says so.
   */
  const openEdit = async (member: Member) => {
    setLoadingId(member.id);
    try {
      const { member: detail } = await membersApi.get(member.id);
      setEditingMember(member);
      setEditingRecord(detail);
      setFormOpen(true);
    } catch (err: unknown) {
      toast({
        title: "Couldn't open this member",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setLoadingId(null);
    }
  };

  const apiFail = (err: unknown) =>
    toast({
      title: "Couldn't save the member",
      description: err instanceof Error ? err.message : 'Unknown error',
      variant: 'destructive',
    });

  /**
   * Profile fields go to the member route; a tier change goes to the
   * verification route, which is the only thing in the platform that writes
   * `member.tierCode` — and it writes the evidence row in the same
   * transaction, so a discounted rate can never stand with no document behind
   * it. Rejects on failure so the dialog stays open holding the entry.
   */
  const handleSave = async (data: MemberFormData): Promise<void> => {
    /**
     * An edit sends the fields that changed and nothing else (SCRUM-321).
     * This used to PATCH the nickname, phone and channel every time, so a
     * save with no edits wrote `preferredChannel: "whatsapp"` onto a member
     * who had never chosen one. An empty patch is a save with nothing in it,
     * and makes no request at all.
     */
    let saved: ApiMember;
    if (editingMember) {
      saved =
        Object.keys(data.patch).length > 0
          ? (await membersApi.update(editingMember.id, data.patch)).member
          : (editingRecord ?? (await membersApi.get(editingMember.id)).member);
    } else {
      const created = (
        await membersApi.create({
          phone: data.phone,
          nickname: data.nickname,
          // Only when one was actually picked: `POST /members` leaves the
          // column null when the field is absent, which is the honest record
          // of a member who has not chosen a channel.
          ...(data.preferredChannel ? { preferredChannel: data.preferredChannel } : {}),
        })
      ).member;
      // The create route takes a phone and a nickname; the rest of the
      // profile follows in one PATCH when the form carried any of it.
      saved =
        Object.keys(data.patch).length > 0
          ? (await membersApi.update(created.id, data.patch)).member
          : created;
    }

    /**
     * Each child's edits go to that child's own route, and one failing says
     * which child (SCRUM-231): these are allergies and medical notes, so
     * "some of it saved" is not a thing to leave a staff member guessing at.
     */
    for (const c of data.childPatches) {
      try {
        await membersApi.updateChild(c.id, c.patch);
      } catch (err) {
        await refresh();
        throw new Error(
          `the member saved, but ${c.name}'s details did not: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      }
    }

    if (data.tierChange) {
      try {
        const { member: verified } = await membersApi.verifyTier(saved.id, data.tierChange);
        toast({
          title: `${tierLabel(data.tierChange.toTier)} rate verified`,
          description: `${verified.nickname} · ${data.tierChange.evidenceType} · valid until ${data.tierChange.evidenceExpiresAt}`,
        });
      } catch (err) {
        // The profile write already landed; say which half failed rather than
        // letting the dialog report the whole save as lost.
        await refresh();
        throw new Error(
          `the name and phone saved, but the tier did not: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      }
    }

    /**
     * Ending a verified tier (SCRUM-241). Its own route, for the same reason
     * the grant has one: `member.tier_code` is never a field on the profile
     * form — it moves only alongside the evidence row that accounts for the
     * move, in one transaction on the server.
     */
    if (data.tierRevoke) {
      try {
        const { member: cleared } = await membersApi.revokeTierVerification(
          saved.id,
          data.tierRevoke,
        );
        toast({
          title: `${cleared.nickname} is back on the ${tierLabel(getDefaultTier().id)} rate`,
          description: `Filed: ${data.tierRevoke.reason}`,
        });
      } catch (err) {
        await refresh();
        throw new Error(
          `the name and phone saved, but the rate did not end: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      }
    }
    await refresh();
  };

  const confirmDelete = () => {
    if (pendingDelete) {
      void membersApi
        .archive(pendingDelete.id)
        .then(refresh)
        .catch(apiFail);
    }
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground/40">
          {members.length} member{members.length === 1 ? '' : 's'}
        </span>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add member
        </Button>
      </div>

      {members.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No members yet. Use "Add member" to create one.
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block overflow-hidden rounded-2xl border border-foreground/10">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Nickname</TableHead>
                  <TableHead className="w-44">Phone</TableHead>
                  <TableHead className="w-48">Verified Tier</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">{member.nickname}</TableCell>
                    <TableCell className="tabular-nums text-foreground/70">
                      {member.phone}
                    </TableCell>
                    <TableCell>
                      <TierBadge member={member} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="icon"
                          disabled={loadingId === member.id}
                          onClick={() => void openEdit(member)}
                          aria-label={`Edit ${member.nickname}`}
                        >
                          {loadingId === member.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Pencil className="w-4 h-4" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setPendingDelete(member)}
                          aria-label={`Delete ${member.nickname}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="flex flex-col gap-2 md:hidden">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-start justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{member.nickname}</div>
                  <div className="text-sm tabular-nums text-foreground/60">
                    {member.phone}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <TierBadge member={member} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={loadingId === member.id}
                    onClick={() => void openEdit(member)}
                    aria-label={`Edit ${member.nickname}`}
                  >
                    {loadingId === member.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Pencil className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPendingDelete(member)}
                    aria-label={`Delete ${member.nickname}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes are saved to the database and audited.
      </p>

      <MemberFormDialog
        open={formOpen}
        member={editingMember}
        record={editingRecord}
        onOpenChange={setFormOpen}
        onSave={handleSave}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete member?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.nickname}" (${pendingDelete.phone}) and their verified tier will be removed.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TierBadge({ member }: { member: Member }) {
  /**
   * A verification OF the baseline tier is not an entitlement: the baseline is
   * the rate that needs no document, and a row saying so is the record of one
   * that was revoked (SCRUM-241). `GET /members/:id` filters those out; the
   * register list this table reads hands the latest row over as it stands, so
   * the badge applies the same rule rather than showing a green tick against
   * the rate everybody gets.
   */
  const verification =
    member.tierVerification && !isDefaultTier(member.tierVerification.tier)
      ? member.tierVerification
      : undefined;
  if (!verification) {
    return (
      <span className="inline-flex items-center rounded-full bg-foreground/5 px-2.5 py-0.5 text-xs text-foreground/45">
        {tierLabel(getDefaultTier().id)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-300"
      title={`${verification.proofType} • verified by ${verification.verifiedBy}${
        verification.expiresAt ? ` • expires ${verification.expiresAt}` : ''
      }`}
    >
      <Check className="w-3 h-3" />
      {tierLabel(verification.tier)}
      {verification.expiresAt && (
        <span className="font-normal opacity-70">· exp {verification.expiresAt}</span>
      )}
    </span>
  );
}
