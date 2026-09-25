import { useEffect, useState } from 'react';
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
import {
  getAuthorizedPickups,
  addGuardianToRegistration,
  editGuardian,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import {
  ShieldCheck,
  UserPlus,
  Pencil,
  X,
  Check,
  User,
  MessageCircle,
} from 'lucide-react';

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
}

const EMPTY_FORM: FormState = { name: '', relationship: '', phone: '', photoUrl: '' };

export function AuthorizedPickupSheet({
  open,
  onOpenChange,
  registrationId,
  parentName,
}: AuthorizedPickupSheetProps) {
  const { operator } = useOperator();
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const reload = () => setPickups(getAuthorizedPickups(registrationId));

  useEffect(() => {
    if (open) {
      reload();
      setMode('list');
      setForm(EMPTY_FORM);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is a new function every render; it reads only registrationId, which is listed
  }, [open, registrationId]);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setMode('add');
  };

  const openEdit = (p: AuthorizedPickup) => {
    setForm({
      name: p.name,
      relationship: p.relationship ?? '',
      phone: p.phone ?? '',
      photoUrl: p.photoUrl ?? '',
    });
    setEditingId(p.id);
    setMode('edit');
  };

  const handleSaveAdd = () => {
    if (!form.name.trim()) return;
    addGuardianToRegistration(
      registrationId,
      {
        name: form.name,
        phone: form.phone || undefined,
        relationship: form.relationship || undefined,
        photoUrl: form.photoUrl || undefined,
        source: 'in_person',
      },
      { operatorName: operator?.name ?? 'Unknown', operatorId: operator?.id ?? 'unknown' },
    );
    reload();
    setMode('list');
    setForm(EMPTY_FORM);
  };

  const handleSaveEdit = () => {
    if (!editingId || !form.name.trim()) return;
    editGuardian(
      editingId,
      {
        name: form.name,
        phone: form.phone || undefined,
        relationship: form.relationship || undefined,
        photoUrl: form.photoUrl || undefined,
      },
      { operatorName: operator?.name ?? 'Unknown', operatorId: operator?.id ?? 'unknown' },
    );
    reload();
    setMode('list');
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleCancel = () => {
    setMode('list');
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const isFormValid = form.name.trim().length > 0;

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
          {mode === 'list' && (
            <>
              <p className="text-xs text-muted-foreground">
                The parent / dropper-off is always authorized. Add anyone else who may collect.
              </p>
              <div className="space-y-2">
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

              <Button variant="outline" className="w-full gap-2" onClick={openAdd}>
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
                    onCapture={(url) => setForm((f) => ({ ...f, photoUrl: url }))}
                    onClear={() => setForm((f) => ({ ...f, photoUrl: '' }))}
                  />
                </div>
              </div>

              <Button
                className="w-full h-12 gap-2"
                disabled={!isFormValid}
                onClick={mode === 'add' ? handleSaveAdd : handleSaveEdit}
              >
                <Check className="w-4 h-4" />
                {mode === 'add' ? 'Save pickup person' : 'Save changes'}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
