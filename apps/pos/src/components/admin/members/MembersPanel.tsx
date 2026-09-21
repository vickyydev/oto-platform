import { useEffect, useState } from 'react';
import { Pencil, Trash2, Plus, Info, Check } from 'lucide-react';
import type { Member } from '@/types';
// Sprint 1 rebuild: members come from the platform API (mockApi retired here).
import { membersApi } from '@/api/platform';
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
import { tierLabel } from '@/lib/membership';

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
    setFormOpen(true);
  };
  const openEdit = (member: Member) => {
    setEditingMember(member);
    setFormOpen(true);
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
    const saved = editingMember
      ? (
          await membersApi.update(editingMember.id, {
            nickname: data.nickname,
            phone: data.phone,
            preferredChannel: data.preferredChannel ?? null,
          })
        ).member
      : (
          await membersApi.create({
            phone: data.phone,
            nickname: data.nickname,
            preferredChannel: data.preferredChannel,
          })
        ).member;

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
                          onClick={() => openEdit(member)}
                          aria-label={`Edit ${member.nickname}`}
                        >
                          <Pencil className="w-4 h-4" />
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
                    onClick={() => openEdit(member)}
                    aria-label={`Edit ${member.nickname}`}
                  >
                    <Pencil className="w-4 h-4" />
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
  const verification = member.tierVerification;
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
