import { useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { AuthorizedPickup } from '@/types';
import type { PickupView } from '@oto/shared';
import { pickupFromView, releaseApi } from '@/api/release';
import {
  ShieldCheck,
  UserPlus,
  Pencil,
  X,
  Check,
  User,
  MessageCircle,
  AlertTriangle,
  Loader2,
  UserMinus,
} from 'lucide-react';

/**
 * The authorised-pickup sheet (S2-13 round 3, plan docs/progress/plans/
 * checkin/PLAN.md §2.4). Same look and the same steps as the prototype's;
 * the list, the additions and the edits are the platform's now, audited
 * there, and a photo taken here is stored through the presigned path before
 * it is named on the person. Taking someone off the list (R-91) revokes —
 * nobody is ever deleted.
 */

interface AuthorizedPickupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registrationId: string;
  /** If provided, shown as a heading sub-label */
  parentName?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  dropper_off: 'Parent / dropper-off',
  in_person: 'Added in person',
  from_chat: 'Promoted from chat',
  on_the_spot: 'Added on the spot',
};

const SOURCE_COLOR: Record<string, string> = {
  dropper_off: 'text-primary bg-primary/10',
  in_person: 'text-emerald-400 bg-emerald-500/10',
  from_chat: 'text-sky-400 bg-sky-500/10',
  on_the_spot: 'text-amber-400 bg-amber-500/10',
};

interface FormState {
  name: string;
  relationship: string;
  phone: string;
  photoUrl: string;
  /** The stored file behind `photoUrl` when it was taken in this form; null otherwise. */
  photoFileId: string | null;
}

const EMPTY_FORM: FormState = { name: '', relationship: '', phone: '', photoUrl: '', photoFileId: null };

export function AuthorizedPickupSheet({
  open,
  onOpenChange,
  registrationId,
  parentName,
}: AuthorizedPickupSheetProps) {
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A taken photo is shown as captured from memory; a stored one is read once (access-logged).
  const photoUrlsRef = useRef(new Map<string, string>());

  const photoUrlOf = async (fileId: string | null): Promise<string | undefined> => {
    if (!fileId) return undefined;
    const known = photoUrlsRef.current.get(fileId);
    if (known) return known;
    try {
      const url = await releaseApi.photoUrl(fileId);
      photoUrlsRef.current.set(fileId, url);
      return url;
    } catch {
      return undefined;
    }
  };

  const show = async (views: PickupView[]) => {
    setPickups(await Promise.all(views.map(async (p) => pickupFromView(p, await photoUrlOf(p.photoFileId)))));
  };

  const reload = async () => {
    if (!registrationId) return;
    setLoading(true);
    try {
      const res = await releaseApi.pickups(registrationId);
      await show(res.pickups);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pickup list could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      photoUrlsRef.current = new Map();
      setPickups([]);
      setError(null);
      void reload();
      setMode('list');
      setForm(EMPTY_FORM);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is a new function every render; it reads only registrationId, which is listed
  }, [open, registrationId]);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError(null);
    setMode('add');
  };

  const openEdit = (p: AuthorizedPickup) => {
    setForm({
      name: p.name,
      relationship: p.relationship ?? '',
      phone: p.phone ?? '',
      photoUrl: p.photoUrl ?? '',
      photoFileId: null,
    });
    setEditingId(p.id);
    setError(null);
    setMode('edit');
  };

  const run = async (work: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await work();
      await reload();
      setMode('list');
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      // The platform's refusal is already in the counter's words.
      setError(err instanceof Error ? err.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remember = () => {
    if (form.photoFileId && form.photoUrl) photoUrlsRef.current.set(form.photoFileId, form.photoUrl);
  };

  const handleSaveAdd = () => {
    if (!form.name.trim()) return;
    remember();
    void run(() =>
      releaseApi.addGuardian(registrationId, {
        id: releaseApi.newId(),
        name: form.name,
        phone: form.phone || null,
        relationship: form.relationship || null,
        photoFileId: form.photoFileId,
        source: 'in_person',
      }),
    );
  };

  const handleSaveEdit = () => {
    if (!editingId || !form.name.trim()) return;
    remember();
    void run(() =>
      releaseApi.editGuardian(editingId, {
        name: form.name,
        phone: form.phone || null,
        relationship: form.relationship || null,
        // Only a newly taken photo replaces the one on file (prototype `editGuardian`).
        ...(form.photoFileId ? { photoFileId: form.photoFileId } : {}),
      }),
    );
  };

  const handleRevoke = () => {
    if (!editingId) return;
    void run(() => releaseApi.revokeGuardian(editingId));
  };

  const handleCancel = () => {
    setMode('list');
    setEditingId(null);
    setError(null);
    setForm(EMPTY_FORM);
  };

  // A photo still saving (taken, not yet stored) holds the save button.
  const photoPending = form.photoUrl.startsWith('data:') && !form.photoFileId;
  const isFormValid = form.name.trim().length > 0 && !photoPending && !saving;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="shrink-0 px-5 pt-5 pb-4 border-b text-left space-y-1">
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Authorized pickups
          </SheetTitle>
          <SheetDescription>
            {parentName ? `${parentName} · ` : ''}Who may collect this child
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 flex items-start gap-2 text-red-300 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {mode === 'list' && (
            <>
              <p className="text-xs text-muted-foreground">
                The parent / dropper-off is always authorized. Add anyone else who may collect.
              </p>
              <div className="space-y-2">
                {loading && pickups.length === 0 && (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading the pickup list…
                  </div>
                )}
                {pickups.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card/50 p-3"
                  >
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                      {p.photoUrl ? (
                        <img
                          src={p.photoUrl}
                          alt={p.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <User className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm truncate">{p.name}</span>
                        {p.relationship && (
                          <span className="text-xs text-muted-foreground">· {p.relationship}</span>
                        )}
                      </div>
                      {p.phone && (
                        <div className="text-xs font-mono text-muted-foreground mt-0.5">{p.phone}</div>
                      )}
                      <div className="mt-1">
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 ${SOURCE_COLOR[p.source] ?? 'text-muted-foreground bg-muted'}`}
                        >
                          {SOURCE_LABEL[p.source] ?? p.source}
                        </span>
                      </div>
                    </div>

                    {/* Edit (not for dropper-off) */}
                    {!p.isDropperOff && (
                      <button
                        type="button"
                        onClick={() => openEdit(p)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <Button variant="outline" className="w-full gap-2" onClick={openAdd} disabled={!registrationId}>
                <UserPlus className="w-4 h-4" />
                Add authorized pickup person
              </Button>
            </>
          )}

          {(mode === 'add' || mode === 'edit') && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
                <span className="font-bold text-sm">
                  {mode === 'add' ? 'Add authorized pickup' : 'Edit pickup person'}
                </span>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Full name <span className="text-red-400">*</span>
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Khun Somchai"
                    className="h-11"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Relationship (optional)
                  </label>
                  <Input
                    value={form.relationship}
                    onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))}
                    placeholder="e.g. grandfather, uncle, family friend"
                    className="h-11"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Phone (optional)
                  </label>
                  <div className="relative">
                    <MessageCircle className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                      placeholder="+66 8X XXX XXXX"
                      className="h-11 pl-9"
                    />
                  </div>
                </div>

                {/* Photo capture */}
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-2">
                    Photo (optional)
                  </label>
                  <CameraCapture
                    value={form.photoUrl || undefined}
                    onCapture={(url) => setForm((f) => ({ ...f, photoUrl: url, photoFileId: null }))}
                    onClear={() => setForm((f) => ({ ...f, photoUrl: '', photoFileId: null }))}
                    upload={(dataUrl) => releaseApi.uploadPhoto(registrationId, dataUrl)}
                    onUploaded={(fileId) => setForm((f) => ({ ...f, photoFileId: fileId }))}
                  />
                </div>
              </div>

              <Button
                className="w-full h-12 gap-2"
                disabled={!isFormValid}
                onClick={mode === 'add' ? handleSaveAdd : handleSaveEdit}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {mode === 'add' ? 'Save pickup person' : 'Save changes'}
              </Button>

              {/* R-91: off the list, audited — never deleted. */}
              {mode === 'edit' && (
                <Button
                  variant="ghost"
                  className="w-full gap-2 text-red-400 hover:text-red-300"
                  disabled={saving}
                  onClick={handleRevoke}
                >
                  <UserMinus className="w-4 h-4" />
                  Take off the pickup list
                </Button>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
