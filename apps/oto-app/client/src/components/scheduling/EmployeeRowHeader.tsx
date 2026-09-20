import { useState, useRef, useEffect } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatEmployeeName, getInitials, type NameDisplayMode } from "./utils";
import { EmployeeInfoPopup } from "./EmployeeInfoPopup";

interface EmployeeRowHeaderProps {
  name: string;
  avatarUrl?: string | null;
  hoursInfo?: string;
  costInfo?: string;
  shiftCount?: number;
  isCompact?: boolean;
  showNameWhenCompact?: boolean;
  hideAvatar?: boolean;
  className?: string;
  employeeId?: string;
  onEmployeeClick?: (employeeId: string) => void;
  gripElement?: React.ReactNode;
}

export function EmployeeRowHeader({
  name,
  avatarUrl,
  hoursInfo,
  costInfo,
  shiftCount,
  isCompact = false,
  showNameWhenCompact = false,
  hideAvatar = false,
  className,
  employeeId,
  onEmployeeClick,
  gripElement,
}: EmployeeRowHeaderProps) {
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false);
  const [nameMode, setNameMode] = useState<NameDisplayMode>('abbreviated');
  const nameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const initials = getInitials(name);
  // Always use abbreviated mode (First Name + Last Initial)
  const displayName = formatEmployeeName(name, 'abbreviated');

  useEffect(() => {
    const checkOverflow = () => {
      if (!nameRef.current || !containerRef.current) return;
      
      const containerWidth = containerRef.current.offsetWidth;
      
      // Only switch to initials when very compact
      if (containerWidth < 50) {
        setNameMode('initials');
      } else {
        setNameMode('abbreviated');
      }
    };

    checkOverflow();
    
    const resizeObserver = new ResizeObserver(checkOverflow);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => resizeObserver.disconnect();
  }, [name]);

  // Build summary parts including hours and cost info
  const summaryParts = [hoursInfo, costInfo, shiftCount ? `${shiftCount} Shifts` : null]
    .filter(Boolean)
    .join(" / ");

  const showName = !isCompact || showNameWhenCompact;

  const handleClick = () => {
    if (employeeId && onEmployeeClick) {
      onEmployeeClick(employeeId);
    }
  };

  const handleAvatarClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPhotoDialogOpen(true);
  };

  const handleNameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPhotoDialogOpen(true);
  };

  const isClickable = !!employeeId && !!onEmployeeClick;

  return (
    <>
      <div 
        ref={containerRef}
        className={cn(
          "flex items-center gap-1", 
          isClickable && "cursor-pointer hover:bg-muted/50 rounded-md transition-colors",
          className
        )} 
        onClick={handleClick}
        data-testid="employee-row-header"
      >
        {gripElement}
        {!hideAvatar && (
          <Avatar 
            className={cn(
              isCompact ? "h-7 w-7" : "h-10 w-10", 
              "shrink-0",
              "cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
            )}
            onClick={handleAvatarClick}
            data-testid="avatar-employee"
          >
            {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        )}
        {(showName || hideAvatar) && (
          <div ref={nameRef} className="min-w-0 flex-1">
            <div 
              className={cn(
                "font-medium truncate cursor-pointer", 
                isCompact ? "text-xs" : "text-sm",
                "hover:text-primary transition-colors"
              )} 
              onClick={handleNameClick}
              data-testid="text-employee-name"
              title={name}
            >
              {displayName}
            </div>
            {!isCompact && summaryParts && (
              <div className="text-xs text-muted-foreground truncate" data-testid="text-employee-summary">
                {summaryParts}
              </div>
            )}
          </div>
        )}
      </div>

      {employeeId && (
        <EmployeeInfoPopup
          open={photoDialogOpen}
          onOpenChange={setPhotoDialogOpen}
          employeeId={employeeId}
          employeeName={name}
          avatarUrl={avatarUrl}
        />
      )}
    </>
  );
}

interface OpenShiftsRowHeaderProps {
  shiftCount: number;
  isCompact?: boolean;
  className?: string;
}

export function OpenShiftsRowHeader({ shiftCount, isCompact = false, className }: OpenShiftsRowHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} data-testid="open-shifts-header">
      <div className={cn(
        "rounded-full bg-[#E8EAF6] flex items-center justify-center",
        isCompact ? "h-8 w-8" : "h-10 w-10"
      )}>
        <svg className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
        </svg>
      </div>
      {!isCompact && (
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Open Shifts</div>
          <div className="text-xs text-muted-foreground">{shiftCount} Shifts</div>
        </div>
      )}
    </div>
  );
}

interface DaysOffRowHeaderProps {
  departmentName: string;
  isCompact?: boolean;
  className?: string;
}

export function DaysOffRowHeader({ departmentName, isCompact = false, className }: DaysOffRowHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} data-testid="days-off-header">
      <div className={cn(
        "rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center",
        isCompact ? "h-8 w-8" : "h-10 w-10"
      )}>
        <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
      {!isCompact && (
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-muted-foreground">Days Off</div>
        </div>
      )}
    </div>
  );
}
