import { useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

interface TimeWheelPickerProps {
  value: string; // "HH:MM" format
  onChange: (value: string) => void;
  minHour?: number;
  maxHour?: number;
}

function WheelColumn({
  items,
  selectedIndex,
  onSelect,
  testId,
}: {
  items: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  testId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScroll = useRef(false);
  const itemHeight = 44;
  const visibleItems = 5;
  const paddingItems = Math.floor(visibleItems / 2);

  const scrollToIndex = useCallback((index: number) => {
    if (containerRef.current) {
      isProgrammaticScroll.current = true;
      containerRef.current.scrollTop = index * itemHeight;
      setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
    }
  }, []);

  useEffect(() => {
    scrollToIndex(selectedIndex);
    requestAnimationFrame(() => scrollToIndex(selectedIndex));
    const t1 = setTimeout(() => scrollToIndex(selectedIndex), 100);
    const t2 = setTimeout(() => scrollToIndex(selectedIndex), 250);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [selectedIndex, scrollToIndex]);

  const handleScroll = () => {
    if (isProgrammaticScroll.current) return;
    if (containerRef.current) {
      const scrollTop = containerRef.current.scrollTop;
      const newIndex = Math.round(scrollTop / itemHeight);
      if (newIndex >= 0 && newIndex < items.length && newIndex !== selectedIndex) {
        onSelect(newIndex);
      }
    }
  };

  const handleItemClick = (index: number) => {
    onSelect(index);
    if (containerRef.current) {
      isProgrammaticScroll.current = true;
      containerRef.current.scrollTo({
        top: index * itemHeight,
        behavior: "smooth",
      });
      setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
    }
  };

  return (
    <div className="relative h-[220px] w-20 overflow-hidden">
      <div 
        className="absolute left-0 right-0 pointer-events-none z-10 border-y border-primary/30 bg-primary/5"
        style={{
          top: paddingItems * itemHeight,
          height: itemHeight,
        }}
      />
      <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-background to-transparent pointer-events-none z-20" />
      <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent pointer-events-none z-20" />
      
      <div
        ref={containerRef}
        className="h-full overflow-y-auto scrollbar-hide"
        onScroll={handleScroll}
        style={{
          scrollSnapType: "y mandatory",
          paddingTop: paddingItems * itemHeight,
          paddingBottom: paddingItems * itemHeight,
        }}
        data-testid={testId}
      >
        {items.map((item, index) => {
          const distance = Math.abs(index - selectedIndex);
          const isSelected = index === selectedIndex;
          return (
            <div
              key={item}
              className={cn(
                "h-[44px] flex items-center justify-center text-lg font-medium cursor-pointer transition-all",
                isSelected ? "text-foreground scale-110" : "text-muted-foreground",
                distance === 1 && "opacity-60",
                distance === 2 && "opacity-30",
                distance > 2 && "opacity-10"
              )}
              style={{ scrollSnapAlign: "center" }}
              onClick={() => handleItemClick(index)}
            >
              {item}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TimeWheelPicker({
  value,
  onChange,
  minHour = 0,
  maxHour = 23,
}: TimeWheelPickerProps) {
  const [hour, minute] = value ? value.split(":").map(Number) : [new Date().getHours(), new Date().getMinutes()];
  
  const hours = Array.from({ length: maxHour - minHour + 1 }, (_, i) => 
    String(minHour + i).padStart(2, "0")
  );
  const minutes = Array.from({ length: 60 }, (_, i) => 
    String(i).padStart(2, "0")
  );

  const hourIndex = Math.max(0, hour - minHour);
  const minuteIndex = Math.max(0, Math.min(59, minute));

  const handleHourChange = (index: number) => {
    const newHour = String(minHour + index).padStart(2, "0");
    const currentMinute = String(minute).padStart(2, "0");
    onChange(`${newHour}:${currentMinute}`);
  };

  const handleMinuteChange = (index: number) => {
    const currentHour = String(hour).padStart(2, "0");
    const newMinute = String(index).padStart(2, "0");
    onChange(`${currentHour}:${newMinute}`);
  };

  return (
    <div className="flex items-center justify-center gap-2 py-4" data-testid="time-wheel-picker">
      <WheelColumn
        items={hours}
        selectedIndex={hourIndex}
        onSelect={handleHourChange}
        testId="wheel-hours"
      />
      <span className="text-2xl font-bold text-muted-foreground">:</span>
      <WheelColumn
        items={minutes}
        selectedIndex={minuteIndex}
        onSelect={handleMinuteChange}
        testId="wheel-minutes"
      />
    </div>
  );
}
