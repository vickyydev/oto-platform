import { useEffect, useState } from 'react';
import { Archive, Building2, Loader2, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { PhoneInput } from '@/components/shared/PhoneInput';
import { toast } from '@/hooks/use-toast';
import { adminApi } from '@/api/platform';

/**
 * SCRUM-27 — platform admin: operators (tenants) and their administrators.
 * New screen in the prototype admin design language (UI addition, §7.2).
 * Only platform-wide accounts can load this data; others see the API's 403.
 */
export function OperatorsPanel() {
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');

  const [pendingArchive, setPendingArchive] = useState<{ id: string; name: string } | null>(null);
  const [adminFor, setAdminFor] = useState<{ id: string; name: string } | null>(null);
  const [adminName, setAdminName] = useState('');
  const [adminPhone, setAdminPhone] = useState('');

  const apiFail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

  const refresh = () =>
    adminApi
      .operators()
      .then((r) => {
        setOperators(r.operators);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Not allowed'));

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    if (busy || !newName.trim()) return;
    setBusy(true);
    try {
      await adminApi.createOperator(newName.trim());
      setNewName('');
      await refresh();
      toast({ title: 'Operator created' });
    } catch (err) {
      apiFail("Couldn't create the operator")(err);
    } finally {
      setBusy(false);
    }
  };

  const archive = (id: string) =>
    adminApi
      .archiveOperator(id)
      .then(() => {
        toast({ title: 'Operator archived', description: 'Hidden from every picker.' });
        return refresh();
      })
      .catch(apiFail("Couldn't archive the operator"));

  const assignAdmin = async () => {
    if (!adminFor || busy || !adminName.trim() || !adminPhone.trim()) return;
    setBusy(true);
    try {
      await adminApi.assignOperatorAdmin(adminFor.id, { phone: adminPhone, name: adminName.trim() });
      toast({
        title: 'Administrator invited',
        description: 'Setup code sent via SMS (dev: see the API console log).',
      });
      setAdminFor(null);
      setAdminName('');
      setAdminPhone('');
    } catch (err) {
      apiFail("Couldn't assign the administrator")(err);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
        Platform administrators only. ({error})
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New operator name (e.g. OTO)"
          className="flex-1 max-w-sm h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button onClick={() => void create()} disabled={busy || !newName.trim()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Create operator
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {operators.map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between rounded-2xl border border-foreground/10 px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/5">
                <Building2 className="w-5 h-5 text-foreground/60" />
              </span>
              <div>
                <p className="font-semibold">{o.name}</p>
                <p className="text-xs text-foreground/40">{o.id}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setAdminFor(o)}>
                <UserPlus className="w-4 h-4" />
                Assign admin
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                title="Archive (hidden from pickers)"
                onClick={() => setPendingArchive(o)}
              >
                <Archive className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
        {operators.length === 0 && (
          <div className="rounded-2xl border border-dashed border-foreground/15 px-6 py-10 text-center text-sm text-foreground/50">
            No operators yet.
          </div>
        )}
      </div>

      <AlertDialog open={pendingArchive !== null} onOpenChange={(o) => !o && setPendingArchive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive operator "{pendingArchive?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The operator disappears from every picker. Its data is kept (soft delete) and a
              platform admin can unarchive it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingArchive) void archive(pendingArchive.id);
                setPendingArchive(null);
              }}
            >
              Archive operator
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={adminFor !== null} onOpenChange={(o) => !busy && !o && setAdminFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign an administrator — {adminFor?.name}</DialogTitle>
            <DialogDescription>
              Creates an invited account with the operator_admin role; they finish setup with the SMS
              code.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="text-sm font-semibold text-foreground/60">Full name</label>
            <input
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="e.g. Khun Anan"
              className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <label className="text-sm font-semibold text-foreground/60">Phone</label>
            <PhoneInput value={adminPhone} onChange={setAdminPhone} />
            <Button
              className="mt-2"
              onClick={() => void assignAdmin()}
              disabled={busy || !adminName.trim() || !adminPhone.trim()}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              Invite administrator
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
