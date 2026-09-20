import { useState, useEffect, useRef } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { User } from "lucide-react";
import type { AvatarWorkStatus } from "@/hooks/use-avatar-work-status";
import { getWorkStatusColor, getWorkStatusTooltip } from "@/hooks/use-avatar-work-status";

interface EmployeeAvatarProps {
  employeeId: string;
  fullName: string;
  profilePhotoPath?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  showFallback?: boolean;
  workStatus?: AvatarWorkStatus;
}

const sizeClasses = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-16 w-16",
  xl: "h-24 w-24",
};

const textSizeClasses = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-xl",
  xl: "text-2xl",
};

function getInitials(name: string | undefined | null): string {
  if (!name) return "";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const statusIndicatorSizes = {
  sm: "h-2.5 w-2.5 border",
  md: "h-3 w-3 border-2",
  lg: "h-4 w-4 border-2",
  xl: "h-5 w-5 border-2",
};

const imageCache = new Map<string, "loading" | "loaded" | "error">();

export function EmployeeAvatar({
  employeeId,
  fullName,
  profilePhotoPath,
  size = "md",
  className,
  showFallback = true,
  workStatus,
}: EmployeeAvatarProps) {
  const photoUrl = profilePhotoPath
    ? `/api/files/profile-photos/${profilePhotoPath.split('/').pop()}`
    : null;

  const cachedState = photoUrl ? imageCache.get(photoUrl) : null;
  const [imageState, setImageState] = useState<"loading" | "loaded" | "error">(
    cachedState === "loaded" ? "loaded" : cachedState === "error" ? "error" : photoUrl ? "loading" : "error"
  );
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!photoUrl) {
      setImageState("error");
      return;
    }
    const cached = imageCache.get(photoUrl);
    if (cached === "loaded") {
      setImageState("loaded");
      return;
    }
    if (cached === "error") {
      setImageState("error");
      return;
    }

    imageCache.set(photoUrl, "loading");
    const img = new Image();
    img.src = photoUrl;
    img.onload = () => {
      imageCache.set(photoUrl, "loaded");
      setImageState("loaded");
    };
    img.onerror = () => {
      imageCache.set(photoUrl, "error");
      setImageState("error");
    };
  }, [photoUrl]);

  const initials = getInitials(fullName);

  const dot = workStatus ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full border-background",
            statusIndicatorSizes[size],
            getWorkStatusColor(workStatus)
          )}
          data-testid={`status-indicator-${employeeId}`}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {getWorkStatusTooltip(workStatus)}
      </TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className="relative inline-block">
      <Avatar
        className={cn(sizeClasses[size], className)}
        data-testid={`avatar-employee-${employeeId}`}
      >
        {photoUrl && imageState === "loaded" ? (
          <AvatarImage
            ref={imgRef}
            src={photoUrl}
            alt={fullName}
            loading="eager"
            onError={() => {
              imageCache.set(photoUrl, "error");
              setImageState("error");
            }}
          />
        ) : null}
        <AvatarFallback
          delayMs={0}
          className={cn(
            "bg-primary text-primary-foreground font-medium",
            textSizeClasses[size]
          )}
        >
          {showFallback ? (
            initials || <User className="h-4 w-4" />
          ) : (
            <User className="h-4 w-4" />
          )}
        </AvatarFallback>
      </Avatar>
      {dot}
    </div>
  );
}
