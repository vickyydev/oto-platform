import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { ModeSwitcher } from "@/components/mode-switcher";
import { useTheme } from "@/components/theme-provider";
import { useSessionReplay } from "@/hooks/use-session-replay";
import { SessionReplayDialog } from "@/components/session-replay-dialog";
import { BranchSelector } from "@/components/branch-selector";
import { Button } from "@/components/ui/button";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useNotificationCount, NotificationPanel } from "@/components/notification-bell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAvatarWorkStatus } from "@/hooks/use-avatar-work-status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { 
  ListTodo, 
  CalendarDays, 
  ClipboardList,
  MessageCircleQuestion,
  GraduationCap,
  LogOut,
  KeyRound,
  Calendar,
  Moon,
  Sun,
  Lock,
  User,
  Bell,
  Video,
  VideoOff,
  Baby,
} from "lucide-react";

const studioNavItems = [
  { title: "Tasks", url: "/studio/tasks", icon: ListTodo },
  { title: "Events", url: "/studio/events", icon: CalendarDays },
  { title: "Children", url: "/studio/children", icon: Baby },
  { title: "Checklists", url: "/studio/checklists", icon: ClipboardList },
  { title: "ASK OTO", url: "/studio/kb", icon: MessageCircleQuestion },
  { title: "Quizzes", url: "/studio/quizzes", icon: GraduationCap },
];

interface StudioLayoutProps {
  children: ReactNode;
}

export function StudioLayout({ children }: StudioLayoutProps) {
  const [location] = useLocation();
  const { user, logoutMutation } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);
  const unreadCount = useNotificationCount();
  const { isRecording, startRecording, stopRecording } = useSessionReplay();
  const [replayDialogOpen, setReplayDialogOpen] = useState(false);

  const initials = user?.fullName
    ? user.fullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  const linkedEmployeeId = user?.linkedEmployeeId;
  const { data: headerAvatarStatus } = useAvatarWorkStatus(
    linkedEmployeeId ? [linkedEmployeeId] : [],
    { scope: "GLOBAL" }
  );

  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <header className="flex items-center gap-4 px-4 py-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <img src="/oto-logo.png" alt="OTO" className="h-8 w-auto flex-shrink-0" />
          <BranchSelector compact />
        </div>
        
        <div className="flex-shrink-0">
          <ModeSwitcher />
        </div>
        
        <div className="flex items-center justify-end gap-2 flex-1 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" data-testid="button-user-menu-studio" className="relative overflow-visible">
                {linkedEmployeeId ? (
                  <EmployeeAvatar
                    employeeId={linkedEmployeeId}
                    fullName={user?.fullName || ""}
                    profilePhotoPath={user?.linkedEmployeeProfilePhoto}
                    workStatus={headerAvatarStatus?.[linkedEmployeeId]?.status as any}
                    size="sm"
                  />
                ) : (
                  <Avatar className="h-8 w-8">
                    {user?.profilePhotoPath && (
                      <AvatarImage src={user.profilePhotoPath} alt={user.fullName} />
                    )}
                    <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                )}
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold px-0.5">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5 text-sm font-medium">{user?.fullName}</div>
              <div className="px-2 pb-1.5 text-xs text-muted-foreground">{user?.email}</div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setNotifOpen(true)} data-testid="menu-notifications-studio">
                <Bell className="mr-2 h-4 w-4" />
                Notifications
                {unreadCount > 0 && (
                  <span className="ml-auto text-[10px] font-bold bg-destructive text-destructive-foreground rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/core/rota">
                  <Calendar className="mr-2 h-4 w-4" />
                  My Schedule
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/my-account">
                  <User className="mr-2 h-4 w-4" />
                  My Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/access">
                  <Lock className="mr-2 h-4 w-4" />
                  Vault
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleTheme} data-testid="menu-theme-toggle-studio">
                {theme === "light" ? (
                  <Moon className="mr-2 h-4 w-4" />
                ) : (
                  <Sun className="mr-2 h-4 w-4" />
                )}
                {theme === "light" ? "Dark Mode" : "Light Mode"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => isRecording ? stopRecording() : setReplayDialogOpen(true)} data-testid="menu-session-replay-studio">
                {isRecording ? (
                  <VideoOff className="mr-2 h-4 w-4" />
                ) : (
                  <Video className="mr-2 h-4 w-4" />
                )}
                {isRecording ? "Stop Recording" : "Start Recording"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main 
        className="flex-1 overflow-auto"
        style={{ paddingBottom: "calc(4rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </main>

      <nav 
        className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 py-2 px-1"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {studioNavItems.map((item) => {
          const isActive = location === item.url || 
            (item.url !== "/studio" && location.startsWith(item.url));
          const Icon = item.icon;
          return (
            <Link key={item.url} href={item.url}>
              <button
                className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md transition-colors ${
                  isActive 
                    ? "text-primary bg-primary/10" 
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`nav-studio-${item.title.toLowerCase()}`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-xs font-medium">{item.title}</span>
              </button>
            </Link>
          );
        })}
      </nav>
      <NotificationPanel open={notifOpen} onOpenChange={setNotifOpen} />
      <SessionReplayDialog
        open={replayDialogOpen}
        onOpenChange={setReplayDialogOpen}
        onConfirm={(description) => {
          startRecording(description || undefined);
        }}
      />
    </div>
  );
}
