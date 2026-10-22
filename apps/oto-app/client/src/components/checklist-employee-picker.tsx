import { Checkbox } from "@/components/ui/checkbox";

/**
 * The checklist editors' employee picker (SCRUM-658): a checklist can name
 * several people, so this is the same bordered checkbox list the editors use
 * for branches, one row per employee.
 */
export function ChecklistEmployeePicker({
  employees,
  value,
  onChange,
  testId,
}: {
  employees: Array<{ id: string; fullName: string; nickname?: string | null }>;
  value: string[];
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <>
      <div className="border rounded-md p-3 space-y-2 max-h-40 overflow-y-auto" data-testid={testId}>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employees found</p>
        ) : (
          employees.map((emp) => (
            <label key={emp.id} className="flex items-center gap-2 cursor-pointer hover-elevate p-1 rounded">
              <Checkbox
                checked={value.includes(emp.id)}
                onCheckedChange={() => toggle(emp.id)}
                data-testid={`${testId}-${emp.id}`}
              />
              <span className="text-sm">{emp.nickname || emp.fullName}</span>
            </label>
          ))
        )}
      </div>
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {value.length === 1 ? "1 employee selected" : `${value.length} employees selected`}
        </p>
      )}
    </>
  );
}
