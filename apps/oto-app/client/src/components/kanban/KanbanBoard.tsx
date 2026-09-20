import { useState, useEffect } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { LayoutGrid, ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useKanbanDnD, type KanbanColumnDef } from "./useKanbanDnD";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCard } from "./KanbanCard";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface KanbanBoardProps<T> {
  items: T[];
  columns: KanbanColumnDef[];
  getId: (item: T) => string;
  getStatus: (item: T) => string;
  onMove: (itemId: string, newColumnId: string) => void;
  renderCard: (item: T, columnId: string) => React.ReactNode;
  renderOverlay?: (item: T) => React.ReactNode;
  statusMap?: Record<string, string>;
  disabledColumns?: string[];
  groupOverride?: (item: T) => string | null;
  emptyLabel?: string;
  idPrefix?: string;
  testIdPrefix?: string;
}

function getTabActiveClass(colorClass: string): string {
  if (colorClass.includes("blue")) return "bg-blue-600 text-white";
  if (colorClass.includes("red")) return "bg-red-600 text-white";
  if (colorClass.includes("green")) return "bg-green-600 text-white";
  if (colorClass.includes("yellow")) return "bg-yellow-500 text-white";
  if (colorClass.includes("purple")) return "bg-purple-600 text-white";
  if (colorClass.includes("orange")) return "bg-orange-500 text-white";
  if (colorClass.includes("pink")) return "bg-pink-500 text-white";
  return "bg-foreground text-background";
}

export function KanbanBoard<T>({
  items,
  columns,
  getId,
  getStatus,
  onMove,
  renderCard,
  renderOverlay,
  statusMap,
  disabledColumns,
  groupOverride,
  emptyLabel = "No items yet",
  idPrefix = "",
  testIdPrefix = "kanban",
}: KanbanBoardProps<T>) {
  const isMobile = useIsMobile();
  const [selectedColumnId, setSelectedColumnId] = useState<string>(
    () => columns[0]?.id || ""
  );

  useEffect(() => {
    if (!selectedColumnId && columns.length > 0) {
      setSelectedColumnId(columns[0].id);
    }
  }, [columns, selectedColumnId]);

  const {
    grouped,
    activeItem,
    overColumnId,
    sensors,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    collisionDetection,
    isColumnDropDisabled,
    applyOptimisticMove,
  } = useKanbanDnD({
    items,
    getId,
    getStatus,
    columns,
    onMove,
    statusMap,
    disabledColumns,
    groupOverride,
    idPrefix,
  });

  if (items.length === 0) {
    return (
      <EmptyState
        icon={LayoutGrid}
        title={emptyLabel}
        data-testid={`${testIdPrefix}-empty`}
      />
    );
  }

  if (isMobile) {
    const activeColItems = grouped[selectedColumnId] || [];
    const activeCol = columns.find((c) => c.id === selectedColumnId);

    return (
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-col h-full" data-testid={`${testIdPrefix}-board`}>
          {/* Tab bar */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 no-scrollbar flex-shrink-0">
            {columns.map((col) => {
              const count = (grouped[col.id] || []).length;
              const isActive = col.id === selectedColumnId;
              const activeClass = getTabActiveClass(col.color);
              return (
                <button
                  key={col.id}
                  onClick={() => setSelectedColumnId(col.id)}
                  className={cn(
                    "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-150",
                    isActive
                      ? activeClass
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  data-testid={`${testIdPrefix}-tab-${col.id}`}
                >
                  {col.label}
                  <span
                    className={cn(
                      "text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center",
                      isActive ? "bg-white/20" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Single column */}
          <div
            className={cn(
              "rounded-lg flex-1 overflow-y-auto",
              activeCol?.color
            )}
          >
            <div className="p-2 space-y-2">
              {activeColItems.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-8 border-2 border-dashed border-transparent rounded-md">
                  No items
                </div>
              ) : (
                activeColItems.map((item) => {
                  const itemId = getId(item);
                  const otherColumns = columns.filter(
                    (c) => c.id !== selectedColumnId && !isColumnDropDisabled(c.id)
                  );
                  return (
                    <div key={itemId} className="relative">
                      {renderCard(item, selectedColumnId)}
                      {otherColumns.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute top-1.5 right-1.5 h-7 w-7 z-10 bg-background/80 hover:bg-background shadow-sm rounded-full"
                              onClick={(e) => e.stopPropagation()}
                              data-testid={`${testIdPrefix}-move-${itemId}`}
                            >
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[140px]">
                            {otherColumns.map((targetCol) => (
                              <DropdownMenuItem
                                key={targetCol.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  applyOptimisticMove(itemId, targetCol.id);
                                  onMove(itemId, targetCol.id);
                                }}
                                data-testid={`${testIdPrefix}-move-to-${targetCol.id}-${itemId}`}
                              >
                                {targetCol.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DndContext>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      autoScroll={{
        enabled: true,
        threshold: { x: 0.15, y: 0.15 },
        acceleration: 10,
      }}
    >
      <div
        className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1 h-full"
        data-testid={`${testIdPrefix}-board`}
      >
        {columns.map((col) => {
          const colItems = grouped[col.id] || [];
          return (
            <KanbanColumn
              key={col.id}
              columnId={col.id}
              label={col.label}
              count={colItems.length}
              color={col.color}
              disabled={isColumnDropDisabled(col.id)}
              isOver={overColumnId === col.id}
              prefix={idPrefix}
            >
              {colItems.map((item) => {
                const itemId = getId(item);
                const cardId = idPrefix ? `${idPrefix}-${itemId}` : itemId;
                return (
                  <KanbanCard key={itemId} id={cardId}>
                    {renderCard(item, col.id)}
                  </KanbanCard>
                );
              })}
            </KanbanColumn>
          );
        })}
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
        }}
      >
        {activeItem ? (
          <div className="kanban-drag-overlay w-[260px] rounded-lg shadow-xl ring-2 ring-primary/30 scale-[1.03] rotate-[1deg]">
            {renderOverlay
              ? renderOverlay(activeItem)
              : renderCard(
                  activeItem,
                  Object.entries(grouped).find(([, colItems]) =>
                    colItems.some((i) => getId(i) === getId(activeItem))
                  )?.[0] || columns[0]?.id || ""
                )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
