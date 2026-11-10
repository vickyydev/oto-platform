import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import {
  PARTY_MENU_ITEM_NAME_MAX,
  partyMenuItemProblem,
  type PartyMenuItemBody,
  type PartyMenuItemStation,
  type PartyMenuLine,
} from "@shared/partyMenuItem";

/**
 * "New item" on the BEO's food lines (SCRUM-828).
 *
 * An item the till's catalogue does not have yet — a special cake, a dish the
 * family asked for — with a name, the station it is made at and either a
 * price or a tick for "free / included / alternate item". Create asks the
 * server, which has the till make it a BEO-only product and writes the line
 * with the till's code (`server/party-menu-routes.ts`); only then is the line
 * handed to the form. A refusal (the till did not answer, the app's key was
 * refused, the park is not linked) is said here, the dialog stays open and no
 * line is added: never a line without its code. A retry is the same press —
 * the same action id — so it can never make a second product.
 */

function newActionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The price field as a number of baht; null when empty or not a number. */
export function priceOfField(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** What the form sends for what it holds. */
export function partyMenuItemBodyOf(form: {
  actionId: string;
  menu: "kids" | "adults";
  name: string;
  station: PartyMenuItemStation;
  price: string;
  free: boolean;
}): PartyMenuItemBody {
  return {
    actionId: form.actionId,
    menu: form.menu,
    name: form.name.trim(),
    station: form.station,
    price: form.free ? null : priceOfField(form.price),
    free: form.free,
  };
}

interface PartyMenuItemAnswer {
  line: PartyMenuLine;
  productId: string;
  productCode: string;
  replayed: boolean;
}

export function PartyMenuItemDialog({
  eventId,
  menu,
  open,
  onClose,
  onCreated,
}: {
  eventId: string;
  menu: "kids" | "adults";
  open: boolean;
  onClose: () => void;
  /** The line as the server wrote it, with the till's code. */
  onCreated: (line: PartyMenuLine) => void;
}) {
  const [name, setName] = useState("");
  const [station, setStation] = useState<PartyMenuItemStation>("kitchen");
  const [price, setPrice] = useState("");
  const [free, setFree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState(newActionId);

  // A fresh form, and a fresh press, each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setStation("kitchen");
    setPrice("");
    setFree(false);
    setError(null);
    setSaving(false);
    setActionId(newActionId());
  }, [open]);

  const create = async () => {
    if (saving) return;
    const body = partyMenuItemBodyOf({ actionId, menu, name, station, price, free });
    const problem = partyMenuItemProblem(body);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/party-menu-items`, body);
      const answer = (await res.json()) as PartyMenuItemAnswer;
      onCreated(answer.line);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "The item could not be added. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-party-menu-item">
        <DialogHeader>
          <DialogTitle>New item for this party</DialogTitle>
          <DialogDescription>
            Not in the menu yet — a special cake, a dish the family asked for. It is added to the till as a party-only
            item in "Party menu", and prints on the kitchen or bar slip like any other.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="party-menu-item-name">Name</Label>
            <Input
              id="party-menu-item-name"
              value={name}
              maxLength={PARTY_MENU_ITEM_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Unicorn cake"
              autoFocus
              data-testid="input-party-menu-item-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Made at</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={station === "kitchen" ? "default" : "outline"}
                onClick={() => setStation("kitchen")}
                data-testid="button-party-menu-item-kitchen"
              >
                Kitchen
              </Button>
              <Button
                type="button"
                size="sm"
                variant={station === "bar" ? "default" : "outline"}
                onClick={() => setStation("bar")}
                data-testid="button-party-menu-item-bar"
              >
                Bar
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="party-menu-item-price">Price ฿</Label>
            <Input
              id="party-menu-item-price"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={free ? "" : price}
              disabled={free}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={free ? "No price: part of the package" : "e.g. 450"}
              data-testid="input-party-menu-item-price"
            />
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="party-menu-item-free"
                checked={free}
                onCheckedChange={(v) => {
                  setFree(v === true);
                  if (v === true) setPrice("");
                }}
                data-testid="checkbox-party-menu-item-free"
              />
              <Label htmlFor="party-menu-item-free" className="text-sm font-normal">
                Free / included / alternate item (no price, part of the package)
              </Label>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="text-party-menu-item-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving} data-testid="button-party-menu-item-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={saving} data-testid="button-party-menu-item-create">
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
              Add to the till and the BEO
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
