import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface KanbanColumnProps {
  columnId: string;
  label: string;
  count: number;
  color: string;
  disabled?: boolean;
  isOver?: boolean;
  children: React.ReactNode;
  prefix?: string;
}

export function KanbanColumn({
  columnId,
  label,
  count,
  color,
  disabled = false,
  isOver: isOverProp,
  children,
  prefix = "",
}: KanbanColumnProps) {
  const droppableId = prefix ? `${prefix}-col-${columnId}` : columnId;
  const { setNodeRef, isOver: isOverLocal } = useDroppable({
    id: droppableId,
    disabled,
  });

  const active = (isOverProp ?? isOverLocal) && !disabled;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-w-[240px] w-[280px] shrink-0 rounded-lg transition-all duration-150 flex flex-col",
        color,
        active && "ring-2 ring-primary ring-offset-2 ring-offset-background"
      )}
      data-testid={`kanban-column-${columnId}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border/50">
        <span className="text-sm font-semibold truncate">{label}</span>
        <Badge variant="secondary" className="text-xs px-1.5 py-0 font-medium">
          {count}
        </Badge>
      </div>
      <div className="p-2 space-y-2 overflow-y-auto flex-1">
        {count === 0 ? (
          <div
            className={cn(
              "text-xs text-muted-foreground text-center py-6 rounded-md border-2 border-dashed transition-colors",
              active ? "border-primary/40 bg-primary/5" : "border-transparent"
            )}
          >
            {active ? "Drop here" : "No items"}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
