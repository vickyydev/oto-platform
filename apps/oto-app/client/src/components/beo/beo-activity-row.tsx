import { useEffect, useRef, useState } from "react";
import { Briefcase, Building2, Minus, Plus, Search, Trash2, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditableText } from "@/components/ui/editable-text";
import {
  ACTIVITY_NOTE_MAX,
  ACTIVITY_PEOPLE_MAX,
  ACTIVITY_ROLE_COUNT_MAX,
  activityPersonWords,
  type ActivityPerson,
  type ActivityPersonEntry,
} from "@shared/beoActivityPeople";

/** An activity as `GET …/beo/entertainment-items` answers it (SCRUM-1032: with its people, named). */
export interface BeoActivity {
  id: string;
  customName: string | null;
  startTime: string | null;
  notes?: string | null;
  people?: ActivityPerson[];
}

/** A person the pickers offer: the BEO's staff list (`/api/beo/party-hosts`) and the park group's roles. */
export interface ActivityPickable {
  id: string;
  label: string;
}

/** The person as the people route takes it back: the person of before as it is, any other by kind and id. */
const entryOf = (p: ActivityPerson): ActivityPersonEntry =>
  p.kept ? { type: "kept", id: p.targetId } : { type: p.type, id: p.id, ...(p.type === "role" ? { count: p.count ?? null } : {}) };

const keyOf = (p: { type: string; id: string }) => `${p.type}:${p.id}`;

const PERSON_ICON = { employee: User, user: User, role: Briefcase, department: Building2 } as const;

/**
 * SCRUM-1032: one activity of Entertainment & Program: its name, its time (one box), its people and
 * its note. Every change is written at once, as the activity's other fields always were; the people
 * one change after the other, so the last one stands.
 */
export function BeoActivityRow({
  act,
  idx,
  readOnly,
  staff,
  staffType,
  roles,
  onField,
  onPeople,
  onDelete,
}: {
  act: BeoActivity;
  idx: number;
  readOnly: boolean;
  staff: readonly ActivityPickable[];
  /** What the staff list holds: the staff list's people, or (a park group with none) its logins. */
  staffType: "employee" | "user";
  roles: readonly ActivityPickable[];
  onField: (data: Partial<{ customName: string; startTime: string | null; notes: string | null }>) => void;
  onPeople: (people: ActivityPersonEntry[]) => Promise<unknown>;
  onDelete: () => void;
}) {
  const stored = act.people ?? [];
  const storedKey = JSON.stringify(stored);
  const [people, setPeople] = useState<ActivityPerson[]>(stored);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);
  const storedNow = useRef(stored);
  storedNow.current = stored;
  // The people as stored once no change of this row is still on its way.
  useEffect(() => {
    if (pending.current === 0) setPeople(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stored list, compared by its words
  }, [storedKey]);

  const change = (next: ActivityPerson[]) => {
    setPeople(next);
    pending.current += 1;
    writes.current = writes.current
      .then(() => onPeople(next.map(entryOf)))
      .catch(() => { failed.current = true; })
      .finally(() => {
        pending.current -= 1;
        // A change refused (its toast says why): the row shows the people as stored again.
        if (pending.current === 0 && failed.current) {
          failed.current = false;
          setPeople(storedNow.current);
        }
      });
  };

  return (
    <div className="space-y-1.5 rounded-lg border bg-background p-2" data-testid={`entertainment-act-${idx}`}>
      <div className="flex items-center gap-2">
        <EditableText
          className="min-w-0 flex-1 text-sm font-medium"
          value={act.customName || ""}
          onChange={(v) => onField({ customName: v })}
          placeholder="Activity (e.g., Bubble show)…"
          disabled={readOnly}
          data-testid={`input-entertainment-act-name-${idx}`}
        />
        {readOnly ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground" data-testid={`text-entertainment-act-time-${idx}`}>{act.startTime || "no time"}</span>
        ) : (
          <input
            type="time"
            className="h-8 w-[6.75rem] shrink-0 rounded-md border border-input bg-background px-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={act.startTime || ""}
            onChange={(e) => onField({ startTime: e.target.value || null })}
            title="Its time puts the activity on the timeline"
            aria-label="Activity time"
            data-testid={`input-entertainment-act-time-${idx}`}
          />
        )}
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Remove activity"
            data-testid={`button-delete-entertainment-act-${idx}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <ActivityPeoplePicker
        people={people}
        onChange={change}
        staff={staff}
        staffType={staffType}
        roles={roles}
        disabled={readOnly}
        testId={`entertainment-act-people-${idx}`}
      />
      <EditableText
        className="text-xs text-muted-foreground"
        value={act.notes || ""}
        onChange={(v) => onField({ notes: v.trim() ? v.slice(0, ACTIVITY_NOTE_MAX) : null })}
        placeholder="Note for this activity (optional)…"
        disabled={readOnly}
        data-testid={`input-entertainment-act-notes-${idx}`}
      />
    </div>
  );
}

/**
 * SCRUM-1032: the people on one activity, as the app's other pickers choose them (the search box and
 * its list of the BEO's staff and the park group's roles): staff by name, one or several; a role with
 * its number, stepped from 1. Each person a chip; a role's chip carries its number.
 */
export function ActivityPeoplePicker({
  people,
  onChange,
  staff,
  staffType,
  roles,
  disabled = false,
  testId,
}: {
  people: readonly ActivityPerson[];
  onChange: (next: ActivityPerson[]) => void;
  staff: readonly ActivityPickable[];
  staffType: "employee" | "user";
  roles: readonly ActivityPickable[];
  disabled?: boolean;
  testId: string;
}) {
  const [query, setQuery] = useState("");
  const [showList, setShowList] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const picked = new Set(people.map(keyOf));
  const full = people.length >= ACTIVITY_PEOPLE_MAX;
  const q = query.trim().toLowerCase();
  const offer = (type: "employee" | "user" | "role", list: readonly ActivityPickable[]) =>
    list.filter((p) => !picked.has(keyOf({ type, id: p.id })) && (!q || p.label.toLowerCase().includes(q))).map((p) => ({ type, ...p }));
  const groups = [
    { title: "Staff", items: offer(staffType, staff) },
    { title: "Role (a number, names later)", items: offer("role", roles) },
  ].filter((g) => g.items.length > 0);

  useEffect(() => {
    const away = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setShowList(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
    };
  }, []);

  const add = (p: { type: "employee" | "user" | "role"; id: string; label: string }) => {
    onChange([...people, { type: p.type, id: p.id, targetId: "", label: p.label, count: p.type === "role" ? 1 : null }]);
    setQuery("");
  };
  const remove = (at: number) => onChange(people.filter((_, i) => i !== at));
  const step = (at: number, by: number) =>
    onChange(people.map((p, i) => {
      if (i !== at) return p;
      const count = Math.min(ACTIVITY_ROLE_COUNT_MAX, Math.max(1, (p.count ?? 1) + by));
      // A number changed is the activity's own role from now on (the person of before is kept as it was only untouched).
      return { ...p, count, kept: false };
    }));

  return (
    <div ref={box} className="relative" data-testid={testId}>
      <div className={`flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 ${disabled ? "border-transparent bg-transparent px-0" : "bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"}`}>
        {!disabled && <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {people.map((p, at) => {
          const Icon = PERSON_ICON[p.type];
          const isRole = p.type === "role";
          const stepper = "flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent";
          return (
            <span
              key={`${keyOf(p)}:${at}`}
              className={`inline-flex h-8 max-w-full items-center gap-1 rounded-full border pl-2.5 text-xs ${disabled ? "pr-2.5" : "pr-0.5"} ${
                isRole ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
              }`}
              data-testid={`${testId}-chip-${at}`}
            >
              <Icon className="h-3 w-3 shrink-0 opacity-70" />
              {isRole && p.count != null ? (
                // "2 × Animator": the number, then the role, as every reader prints it.
                <span className="truncate">
                  <span className="font-semibold tabular-nums" data-testid={`${testId}-count-${at}`}>{p.count}</span> × {p.label}
                </span>
              ) : (
                <span className="truncate">{activityPersonWords(p)}</span>
              )}
              {isRole && !disabled && (
                <span className="ml-0.5 flex shrink-0 items-center border-l border-amber-500/30 pl-0.5">
                  <button type="button" className={stepper} onClick={() => step(at, -1)} disabled={(p.count ?? 1) <= 1} aria-label={`One ${p.label} fewer`} data-testid={`${testId}-less-${at}`}>
                    <Minus className="h-3 w-3" />
                  </button>
                  <button type="button" className={stepper} onClick={() => step(at, 1)} disabled={(p.count ?? 1) >= ACTIVITY_ROLE_COUNT_MAX} aria-label={`One ${p.label} more`} data-testid={`${testId}-more-${at}`}>
                    <Plus className="h-3 w-3" />
                  </button>
                </span>
              )}
              {!disabled && (
                <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={() => remove(at)} aria-label={`Remove ${p.label}`} data-testid={`${testId}-remove-${at}`}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
        {disabled && people.length === 0 && <span className="text-xs text-muted-foreground">No one assigned</span>}
        {!disabled && (
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowList(true); }}
            onFocus={() => setShowList(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowList(false);
              if (e.key === "Enter" && groups[0]?.items[0]) { e.preventDefault(); add(groups[0].items[0]); }
            }}
            placeholder={people.length ? "Add more…" : "Add staff or a role…"}
            disabled={full}
            className="h-8 min-w-[8rem] flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Add staff or a role"
            data-testid={`${testId}-search`}
          />
        )}
      </div>
      {!disabled && showList && !full && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md" data-testid={`${testId}-list`}>
          {groups.length === 0 ? (
            <p className="p-3 text-center text-sm text-muted-foreground">{q ? `No one called "${query.trim()}"` : "Everyone is on this activity"}</p>
          ) : (
            groups.map((g) => (
              <div key={g.title}>
                <div className="sticky top-0 bg-muted/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{g.title}</div>
                {g.items.map((p) => (
                  <button
                    key={keyOf(p)}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); add(p); }}
                    className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                    data-testid={`${testId}-option-${p.type}-${p.id}`}
                  >
                    {p.type === "role" ? <Briefcase className="h-3.5 w-3.5 text-muted-foreground" /> : <User className="h-3.5 w-3.5 text-muted-foreground" />}
                    {p.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
