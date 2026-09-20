import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  id: string;
  data?: Record<string, any>;
  children: React.ReactNode;
}

const KanbanCardInner = ({ id, data, children }: KanbanCardProps) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ touchAction: "auto" }}
      className={cn(
        "relative select-none transition-transform transition-shadow duration-200",
        isDragging && "opacity-30 scale-[0.96] shadow-lg"
      )}
      data-testid={`kanban-card-${id}`}
    >
      {children}
    </div>
  );
};

export const KanbanCard = memo(KanbanCardInner);
