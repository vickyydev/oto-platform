import { Baby, User, Heart, Phone, Upload, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { differenceInYears, parseISO } from "date-fns";

export interface ParentContact {
  name: string;
  phone: string;
}

export interface ChildProfileFormValues {
  childFullName: string;
  dateOfBirth: string;
  primaryLanguage: string;
  allergies: string;
  foodRestrictions: string;
  behavioralNotes: string;
  specialNotes: string;
  authorizedPickupPersons: string;
  parentContacts: ParentContact[];
  childPhotoUrl: string;
}

interface ChildProfileEditorProps {
  form: ChildProfileFormValues;
  onChange: (updates: Partial<ChildProfileFormValues>) => void;
  onPhotoUpload: (file: File) => void;
  photoUploading: boolean;
}

export function ChildProfileEditor({
  form,
  onChange,
  onPhotoUpload,
  photoUploading,
}: ChildProfileEditorProps) {
  const age = form.dateOfBirth
    ? (() => { try { return differenceInYears(new Date(), parseISO(form.dateOfBirth)); } catch { return null; } })()
    : null;

  const updateContact = (idx: number, field: keyof ParentContact, value: string) => {
    const next = form.parentContacts.map((c, i) => i === idx ? { ...c, [field]: value } : c);
    onChange({ parentContacts: next });
  };

  const addContact = () => {
    onChange({ parentContacts: [...form.parentContacts, { name: "", phone: "" }] });
  };

  const removeContact = (idx: number) => {
    onChange({ parentContacts: form.parentContacts.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-6">
      {/* Photo */}
      <div className="flex flex-col items-center gap-3">
        {form.childPhotoUrl ? (
          <img
            src={form.childPhotoUrl}
            alt="Child photo"
            className="h-24 w-24 rounded-full object-cover border-2 border-teal-200"
          />
        ) : (
          <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center border-2 border-dashed border-muted-foreground/30">
            <Baby className="h-10 w-10 text-muted-foreground/40" />
          </div>
        )}
        <label className={cn(
          "inline-flex items-center gap-1.5 text-sm cursor-pointer px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent transition-colors",
          photoUploading && "opacity-60 pointer-events-none"
        )}>
          <Upload className="h-3.5 w-3.5" />
          {photoUploading ? "Uploading…" : form.childPhotoUrl ? "Change Photo" : "Upload Photo"}
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="sr-only"
            disabled={photoUploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPhotoUpload(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {/* Child Information */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
          <User className="h-4 w-4 text-teal-600" />
          Child Information
        </h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Full Name <span className="text-destructive">*</span></Label>
            <Input
              value={form.childFullName}
              onChange={(e) => onChange({ childFullName: e.target.value })}
              placeholder="Child's full name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date of Birth</Label>
              <Input
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => onChange({ dateOfBirth: e.target.value })}
              />
              {age !== null && (
                <p className="text-xs text-muted-foreground">{age} year{age !== 1 ? "s" : ""} old</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Primary Language</Label>
              <Input
                value={form.primaryLanguage}
                onChange={(e) => onChange({ primaryLanguage: e.target.value })}
                placeholder="e.g. Thai, English"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Health & Behavior */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
          <Heart className="h-4 w-4 text-rose-500" />
          Health & Behavior
        </h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Allergies</Label>
            <Textarea
              value={form.allergies}
              onChange={(e) => onChange({ allergies: e.target.value })}
              placeholder="Any allergies or medical conditions…"
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Food Restrictions</Label>
            <Textarea
              value={form.foodRestrictions}
              onChange={(e) => onChange({ foodRestrictions: e.target.value })}
              placeholder="Dietary requirements or restrictions…"
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Behavioral / Special Notes</Label>
            <Textarea
              value={form.behavioralNotes}
              onChange={(e) => onChange({ behavioralNotes: e.target.value })}
              placeholder="Any behavioral notes or special needs…"
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Additional Notes</Label>
            <Textarea
              value={form.specialNotes}
              onChange={(e) => onChange({ specialNotes: e.target.value })}
              placeholder="Any other notes…"
              rows={2}
              className="resize-none"
            />
          </div>
        </div>
      </div>

      {/* Parent & Pickup */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
          <Phone className="h-4 w-4 text-blue-500" />
          Parent & Pickup
        </h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Authorized Pickup Persons</Label>
            <Textarea
              value={form.authorizedPickupPersons}
              onChange={(e) => onChange({ authorizedPickupPersons: e.target.value })}
              placeholder="Names of people authorized to pick up the child…"
              rows={2}
              className="resize-none"
            />
          </div>

          {/* Multi-contact parent list */}
          <div className="space-y-2">
            {form.parentContacts.map((contact, idx) => (
              <div key={idx} className="rounded-lg border border-input bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {idx === 0 ? "Primary Parent / Guardian" : `Parent / Contact ${idx + 1}`}
                  </span>
                  {form.parentContacts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeContact(idx)}
                      className="text-xs text-red-400 hover:text-red-600 flex items-center gap-1 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Name {idx === 0 && <span className="text-destructive">*</span>}</Label>
                    <Input
                      value={contact.name}
                      onChange={(e) => updateContact(idx, "name", e.target.value)}
                      placeholder="Full name"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phone {idx === 0 && <span className="text-destructive">*</span>}</Label>
                    <Input
                      value={contact.phone}
                      onChange={(e) => updateContact(idx, "phone", e.target.value)}
                      placeholder="+66 8x xxx xxxx"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addContact}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-blue-300 text-blue-600 text-xs font-medium hover:bg-blue-50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Another Parent / Contact
          </button>
        </div>
      </div>
    </div>
  );
}
