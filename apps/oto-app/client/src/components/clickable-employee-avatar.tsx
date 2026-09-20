import { useState } from "react";
import { EmployeeAvatar } from "./employee-avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AvatarWorkStatus } from "@/hooks/use-avatar-work-status";

interface ClickableEmployeeAvatarProps {
  employeeId: string;
  fullName: string;
  profilePhotoPath?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  showFallback?: boolean;
  workStatus?: AvatarWorkStatus;
}

export function ClickableEmployeeAvatar({
  employeeId,
  fullName,
  profilePhotoPath,
  size = "md",
  className,
  showFallback = true,
  workStatus,
}: ClickableEmployeeAvatarProps) {
  const [isOpen, setIsOpen] = useState(false);

  const photoUrl = profilePhotoPath
    ? `/api/files/profile-photos/${profilePhotoPath.split('/').pop()}`
    : null;

  const handleClick = () => {
    if (photoUrl) {
      setIsOpen(true);
    }
  };

  return (
    <>
      <div
        onClick={handleClick}
        className={cn(
          photoUrl && "cursor-pointer hover:opacity-80 transition-opacity",
          className
        )}
        data-testid={`clickable-avatar-${employeeId}`}
      >
        <EmployeeAvatar
          employeeId={employeeId}
          fullName={fullName}
          profilePhotoPath={profilePhotoPath}
          size={size}
          showFallback={showFallback}
          workStatus={workStatus}
        />
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{fullName}</DialogTitle>
          </DialogHeader>
          {photoUrl && (
            <div className="flex justify-center p-4">
              <img
                src={photoUrl}
                alt={fullName}
                className="max-w-full max-h-[60vh] rounded-lg object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
