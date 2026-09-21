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
  /**
   * The enlarged photo is a plain `<img>`, so unlike the avatar itself — which
   * preloads and falls back to initials — a path whose file is not in this
   * deployment's storage would draw the browser's broken-image icon under the
   * person's name. A record can carry a photo path the storage does not have:
   * data copied from another deployment does exactly that. So the dialog says
   * the photograph is not on this deployment rather than showing a torn page.
   */
  const [photoFailed, setPhotoFailed] = useState(false);

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
              {photoFailed ? (
                <p
                  className="text-sm text-muted-foreground text-center py-8"
                  data-testid={`photo-unavailable-${employeeId}`}
                >
                  This photograph is not stored on this deployment.
                </p>
              ) : (
                <img
                  src={photoUrl}
                  alt={fullName}
                  onError={() => setPhotoFailed(true)}
                  className="max-w-full max-h-[60vh] rounded-lg object-contain"
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
