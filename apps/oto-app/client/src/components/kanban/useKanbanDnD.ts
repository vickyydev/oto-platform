import { useState, useCallback, useMemo, useRef } from "react";
import {
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";

export interface KanbanColumnDef {
  id: string;
  label: string;
  color: string;
  statuses?: string[];
}

interface UseKanbanDnDOptions<T> {
  items: T[];
  getId: (item: T) => string;
  getStatus: (item: T) => string;
  columns: KanbanColumnDef[];
  onMove: (itemId: string, newColumnId: string) => void;
  statusMap?: Record<string, string>;
  disabledColumns?: string[];
  groupOverride?: (item: T) => string | null;
  idPrefix?: string;
}

export function useKanbanDnD<T>(options: UseKanbanDnDOptions<T>) {
  const {
    items,
    getId,
    getStatus,
    columns,
    onMove,
    disabledColumns = [],
    groupOverride,
    idPrefix = "",
  } = options;

  const [activeItem, setActiveItem] = useState<T | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [optimisticMoves, setOptimisticMoves] = useState<Record<string, string>>({});
  const optimisticTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: { distance: 8 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 300, tolerance: 8 },
  });
  const sensors = useSensors(mouseSensor, touchSensor);

  const grouped = useMemo(() => {
    const result: Record<string, T[]> = {};
    for (const col of columns) {
      result[col.id] = [];
    }

    for (const item of items) {
      const itemId = getId(item);
      const optimisticCol = optimisticMoves[itemId];
      if (optimisticCol && result[optimisticCol]) {
        result[optimisticCol].push(item);
        continue;
      }

      const overrideCol = groupOverride?.(item);
      if (overrideCol && result[overrideCol]) {
        result[overrideCol].push(item);
        continue;
      }

      const status = getStatus(item);
      let placed = false;
      for (const col of columns) {
        if (col.statuses && col.statuses.includes(status)) {
          result[col.id].push(item);
          placed = true;
          break;
        }
      }
      if (!placed && columns.length > 0) {
        result[columns[0].id].push(item);
      }
    }

    return result;
  }, [items, columns, groupOverride, getStatus, getId, optimisticMoves]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragId = String(event.active.id);
      const rawId = idPrefix ? dragId.replace(`${idPrefix}-`, "") : dragId;
      const item = items.find((i) => getId(i) === rawId);
      setActiveItem(item || null);
    },
    [items, getId, idPrefix]
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (!over) {
        setOverColumnId(null);
        return;
      }
      const overId = String(over.id);
      const colId = idPrefix ? overId.replace(`${idPrefix}-col-`, "") : overId;
      setOverColumnId(columns.some((c) => c.id === colId) ? colId : null);
    },
    [columns, idPrefix]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItem(null);
      setOverColumnId(null);
      const { active, over } = event;
      if (!over) return;

      const overId = String(over.id);
      const targetColumnId = idPrefix ? overId.replace(`${idPrefix}-col-`, "") : overId;

      if (disabledColumns.includes(targetColumnId)) return;

      const activeId = String(active.id);
      const rawId = idPrefix ? activeId.replace(`${idPrefix}-`, "") : activeId;

      const currentColumn = Object.entries(grouped).find(([, colItems]) =>
        colItems.some((i) => getId(i) === rawId)
      );

      if (currentColumn && currentColumn[0] !== targetColumnId) {
        setOptimisticMoves((prev) => ({ ...prev, [rawId]: targetColumnId }));

        if (optimisticTimers.current[rawId]) {
          clearTimeout(optimisticTimers.current[rawId]);
        }
        optimisticTimers.current[rawId] = setTimeout(() => {
          setOptimisticMoves((prev) => {
            const next = { ...prev };
            delete next[rawId];
            return next;
          });
          delete optimisticTimers.current[rawId];
        }, 3000);

        onMove(rawId, targetColumnId);
      }
    },
    [grouped, getId, onMove, disabledColumns, idPrefix]
  );

  const handleDragCancel = useCallback(() => {
    setActiveItem(null);
    setOverColumnId(null);
  }, []);

  const isColumnDropDisabled = useCallback(
    (columnId: string) => disabledColumns.includes(columnId),
    [disabledColumns]
  );

  const applyOptimisticMove = useCallback(
    (rawId: string, targetColumnId: string) => {
      setOptimisticMoves((prev) => ({ ...prev, [rawId]: targetColumnId }));
      if (optimisticTimers.current[rawId]) {
        clearTimeout(optimisticTimers.current[rawId]);
      }
      optimisticTimers.current[rawId] = setTimeout(() => {
        setOptimisticMoves((prev) => {
          const next = { ...prev };
          delete next[rawId];
          return next;
        });
        delete optimisticTimers.current[rawId];
      }, 3000);
    },
    []
  );

  return {
    grouped,
    activeItem,
    overColumnId,
    sensors,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    collisionDetection: closestCenter,
    isColumnDropDisabled,
    applyOptimisticMove,
  };
}
