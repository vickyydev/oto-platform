import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  LayoutDashboard,
  FileText,
  Users,
  FileSignature,
  Settings,
  ChevronDown,
  ChevronRight,
  Building2,
  BookOpen,
  Activity,
  Clock,
  AlertTriangle,
  Briefcase,
  CalendarDays,
  Contact,
  Network,
  Shield,
  UserCog,
  Banknote,
  Calendar,
  Play,
  Download,
  Scale,
  MapPin,
  GitBranch,
  Lock,
  KeyRound,
  BarChart3,
} from "lucide-react";

const SIDEBAR_SECTIONS_KEY = "oto_sidebar_sections";

function isGlobalAdmin(role: string | undefined): boolean {
  return role === "global_admin" || role === "admin";
}

function isAnyAdmin(role: string | undefined): boolean {
  return role === "global_admin" || role === "operator_admin" || role === "admin";
}

function isManagerOrAbove(role: string | undefined): boolean {
  return isAnyAdmin(role) || role === "manager";
}

type MenuItem = {
  title: string;
  url: string;
  icon: any;
  globalAdminOnly?: boolean;
  adminOnly?: boolean;
  managerOnly?: boolean;
  requireAllBranches?: boolean;
};

const globalAdminItems: MenuItem[] = [
  {
    title: "Operators",
    url: "/operators",
    icon: Network,
    globalAdminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "User Management",
    url: "/users",
    icon: UserCog,
    globalAdminOnly: true,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
    globalAdminOnly: true,
  },
];

const adminItems: MenuItem[] = [
  {
    title: "Branches",
    url: "/branches",
    icon: Building2,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Departments",
    url: "/departments",
    icon: Building2,
    requireAllBranches: true,
  },
  {
    title: "Locations",
    url: "/locations",
    icon: MapPin,
    requireAllBranches: true,
  },
  {
    title: "Roles",
    url: "/roles",
    icon: Briefcase,
    requireAllBranches: true,
  },
  {
    title: "Templates",
    url: "/templates",
    icon: FileText,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Policies",
    url: "/policies",
    icon: BookOpen,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Access",
    url: "/permissions",
    icon: Shield,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Vault",
    url: "/settings/access",
    icon: KeyRound,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Advisors",
    url: "/advisors",
    icon: Contact,
    adminOnly: true,
    requireAllBranches: true,
  },
];

// Daily work first; the people records after. Role fences are unchanged from
// the old single "HR Operations" list: each link keeps the flag it had there.
const dailyOperationsItems: MenuItem[] = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Needs action",
    url: "/attention",
    icon: AlertTriangle,
  },
  {
    title: "Today's attendance",
    url: "/timekeeping-review",
    icon: Clock,
    managerOnly: true,
  },
  {
    title: "Scheduling",
    url: "/scheduling",
    icon: CalendarDays,
    managerOnly: true,
  },
];

const peopleAndHrItems: MenuItem[] = [
  {
    title: "Employees",
    url: "/employees",
    icon: Users,
  },
  {
    title: "Contracts",
    url: "/contracts",
    icon: FileSignature,
  },
  {
    title: "Org Chart",
    url: "/org-chart",
    icon: GitBranch,
    managerOnly: true,
  },
  {
    title: "Activity Logbook",
    url: "/activity-logbook",
    icon: Activity,
  },
];

const financeItems: MenuItem[] = [
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    adminOnly: true,
    requireAllBranches: true,
  },
];

const payrollItems: MenuItem[] = [
  {
    title: "Payroll Overview",
    url: "/payroll",
    icon: LayoutDashboard,
    managerOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Periods",
    url: "/payroll/periods",
    icon: Calendar,
    adminOnly: true,
    requireAllBranches: true,
  },
  {
    title: "Statutory Rules",
    url: "/payroll/statutory-rules",
    icon: Scale,
    adminOnly: true,
    requireAllBranches: true,
  },
  // The company payroll (SCRUM-567, R2): payroll roles only (hr.view_salary is
  // every admin role). R7 regroups this section when the new hub replaces the old.
  {
    title: "Payroll Setup",
    url: "/payroll/setup",
    icon: Settings,
    adminOnly: true,
  },
  {
    title: "Payroll Profiles",
    url: "/payroll/people",
    icon: Users,
    adminOnly: true,
  },
  // SCRUM-569 (R4): payslips from locked company payroll months. The old
  // /my-payslips page stays reachable by its address until R7 removes it.
  {
    title: "My Payslips",
    url: "/payroll/me/payslips",
    icon: FileText,
  },
];

function filterItems(items: MenuItem[], role: string | undefined, isAllBranches: boolean): MenuItem[] {
  return items.filter((item) => {
    if (item.globalAdminOnly && !isGlobalAdmin(role)) return false;
    if (item.adminOnly && !isAnyAdmin(role)) return false;
    if (item.managerOnly && !isManagerOrAbove(role)) return false;
    if (item.requireAllBranches && !isAllBranches && !isAnyAdmin(role)) return false;
    return true;
  });
}

function hasRoleAccess(items: MenuItem[], role: string | undefined): boolean {
  return items.some((item) => {
    if (item.globalAdminOnly && !isGlobalAdmin(role)) return false;
    if (item.adminOnly && !isAnyAdmin(role)) return false;
    if (item.managerOnly && !isManagerOrAbove(role)) return false;
    return true;
  });
}

type SectionState = {
  dailyOperations: boolean;
  peopleAndHr: boolean;
  configuration: boolean;
  platformAdmin: boolean;
  finance: boolean;
  payroll: boolean;
};

// Keys the regroup retired (the old "hrOperations") are simply ignored when
// read back; the two sections it became start open until someone closes them.
const DEFAULT_SECTIONS: SectionState = {
  dailyOperations: true,
  peopleAndHr: true,
  configuration: false,
  platformAdmin: false,
  finance: false,
  payroll: false,
};

function normalizeSections(value: Partial<SectionState> | undefined): SectionState {
  const result = { ...DEFAULT_SECTIONS };
  for (const key of Object.keys(result) as (keyof SectionState)[]) {
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  }
  return result;
}

// The browser copy is per account, so one person's open sections never
// become the next person's on a shared device; the server copy follows the
// account across devices.
function getStoredSectionState(userId: string): SectionState {
  try {
    const stored = localStorage.getItem(`${SIDEBAR_SECTIONS_KEY}:${userId}`);
    if (stored) {
      return normalizeSections(JSON.parse(stored));
    }
  } catch {}
  return { ...DEFAULT_SECTIONS };
}

function storeSectionState(userId: string, state: SectionState) {
  try {
    localStorage.setItem(`${SIDEBAR_SECTIONS_KEY}:${userId}`, JSON.stringify(state));
  } catch {}
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const { isAllBranches, activeBranchIds, isLoading: branchesLoading } = useBranchContext();
  const [localSections, setLocalSections] = useState<{ userId: string; sections: SectionState } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const { data: savedSections } = useQuery<{ sections: Partial<SectionState> }>({
    queryKey: ["/api/me/sidebar-sections", user?.id],
    queryFn: async () => {
      const response = await fetch("/api/me/sidebar-sections", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load saved menu preferences");
      return response.json();
    },
    enabled: !!user?.id,
    refetchOnMount: "always",
  });
  const sectionState = localSections && localSections.userId === user?.id ? localSections.sections
    : savedSections ? normalizeSections(savedSections.sections)
    : user?.id ? getStoredSectionState(user.id) : { ...DEFAULT_SECTIONS };

  const scopeKey = activeBranchIds.slice().sort().join(",");
  const { data: badges } = useQuery<{ needsAction: number; todaysAttendance: number }>({
    queryKey: ["/api/sidebar/badges", user?.id, scopeKey],
    queryFn: async () => {
      const response = await fetch(`/api/sidebar/badges?branchIds=${encodeURIComponent(scopeKey)}`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load navigation counts");
      return response.json();
    },
    enabled: !!user?.id && !branchesLoading && activeBranchIds.length > 0,
    staleTime: 0,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const toggleSection = (section: keyof SectionState) => {
    if (!user?.id) return;
    const next = { ...sectionState, [section]: !sectionState[section] };
    setLocalSections({ userId: user.id, sections: next });
    storeSectionState(user.id, next);
    setSaveError(false);
    const userId = user.id;
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      const response = await apiRequest("PATCH", "/api/me/sidebar-sections", { sections: { [section]: next[section] } });
      const saved = await response.json() as { sections: Partial<SectionState> };
      queryClient.setQueryData(["/api/me/sidebar-sections", userId], saved);
    }).catch(() => {
      // The browser copy above still holds the choice; the next change retries the save.
      if (userId === user.id) setSaveError(true);
    });
  };

  const filteredGlobalAdminItems = filterItems(globalAdminItems, user?.role, isAllBranches);
  const filteredAdminItems = filterItems(adminItems, user?.role, isAllBranches);
  const filteredDailyOperationsItems = filterItems(dailyOperationsItems, user?.role, isAllBranches);
  const filteredPeopleAndHrItems = filterItems(peopleAndHrItems, user?.role, isAllBranches);
  const filteredFinanceItems = filterItems(financeItems, user?.role, isAllBranches);
  const filteredPayrollItems = filterItems(payrollItems, user?.role, isAllBranches);

  const wouldHaveConfigAccess = hasRoleAccess(adminItems, user?.role);
  const wouldHavePayrollAccess = hasRoleAccess(payrollItems, user?.role);
  const configHiddenByBranch = !isAllBranches && wouldHaveConfigAccess && filteredAdminItems.length === 0;

  const renderMenuItems = (items: MenuItem[]) => {
    return items.map((item) => {
      const isActive = location === item.url || 
        (item.url !== "/" && location.startsWith(item.url));
      const count = item.url === "/attention" ? badges?.needsAction : item.url === "/timekeeping-review" ? badges?.todaysAttendance : undefined;
      return (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            asChild
            isActive={isActive}
            data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <Link href={item.url} aria-label={count ? `${item.title}, ${count} open items` : undefined}>
              <item.icon className="h-4 w-4" />
              <span>{item.title}</span>
              {!!count && count > 0 && <span aria-hidden="true" className="ml-auto rounded-full bg-amber-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white dark:bg-amber-300 dark:text-amber-950">{count > 99 ? "99+" : count}</span>}
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      );
    });
  };

  const CollapsibleSection = ({ 
    id, 
    label, 
    icon: Icon, 
    items, 
    isOpen, 
    onToggle,
    branchHint,
    hasBadge,
  }: { 
    id: string;
    label: string; 
    icon?: typeof Shield; 
    items: MenuItem[]; 
    isOpen: boolean; 
    onToggle: () => void;
    branchHint?: string;
    hasBadge?: boolean;
  }) => {
    if (items.length === 0 && !branchHint) return null;
    
    return (
      <SidebarGroup>
        <Collapsible.Root open={isOpen} onOpenChange={onToggle}>
          <SidebarGroupLabel asChild>
            <Collapsible.Trigger
              type="button"
              className="flex items-center gap-2 cursor-pointer hover-elevate rounded-md px-2 py-1 w-full justify-between"
              data-testid={`section-toggle-${id}`}
            >
              <span className="flex items-center gap-2">
                {Icon && <Icon className="h-3 w-3" />}
                {label}
              </span>
              <span className="flex items-center gap-2">
                {!isOpen && hasBadge && <span aria-label="Items need attention" className="h-2 w-2 rounded-full bg-amber-700 dark:bg-amber-300" />}
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </span>
            </Collapsible.Trigger>
          </SidebarGroupLabel>
          <Collapsible.Content>
            <SidebarGroupContent>
              {branchHint && items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground italic group-data-[collapsible=icon]:hidden" data-testid={`hint-${id}`}>
                  {branchHint}
                </div>
              ) : (
                <SidebarMenu>
                  {renderMenuItems(items)}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </Collapsible.Content>
        </Collapsible.Root>
      </SidebarGroup>
    );
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border p-4 group-data-[collapsible=icon]:hidden">
        <div className="flex items-center gap-3">
          <img src="/oto-logo.png" alt="OTO" className="h-8 w-auto" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {saveError && <p role="alert" className="px-3 py-1 text-xs text-destructive group-data-[collapsible=icon]:hidden">Menu preference could not sync. It is saved on this device.</p>}
        <CollapsibleSection
          id="daily-operations"
          label="Daily Operations"
          items={filteredDailyOperationsItems}
          isOpen={sectionState.dailyOperations}
          onToggle={() => toggleSection('dailyOperations')}
          hasBadge={!!badges && (badges.needsAction > 0 || (filteredDailyOperationsItems.some((i) => i.url === "/timekeeping-review") && badges.todaysAttendance > 0))}
        />

        <CollapsibleSection
          id="people-and-hr"
          label="People & HR"
          items={filteredPeopleAndHrItems}
          isOpen={sectionState.peopleAndHr}
          onToggle={() => toggleSection('peopleAndHr')}
        />

        {filteredFinanceItems.length > 0 && (
          <CollapsibleSection
            id="finance"
            label="Finance"
            icon={BarChart3}
            items={filteredFinanceItems}
            isOpen={sectionState.finance}
            onToggle={() => toggleSection('finance')}
          />
        )}

        {(filteredPayrollItems.length > 0 || wouldHavePayrollAccess) && (
          <CollapsibleSection
            id="payroll"
            label="Payroll"
            icon={Banknote}
            items={filteredPayrollItems}
            isOpen={sectionState.payroll}
            onToggle={() => toggleSection('payroll')}
            branchHint={!isAllBranches && filteredPayrollItems.length === 0 ? "Select 'All Branches' to access payroll" : undefined}
          />
        )}

        <CollapsibleSection
          id="configuration"
          label="Configuration"
          items={filteredAdminItems}
          isOpen={sectionState.configuration}
          onToggle={() => toggleSection('configuration')}
          branchHint={configHiddenByBranch ? "Configuration needs access to all branches. Ask an administrator." : undefined}
        />

        <CollapsibleSection
          id="platform-admin"
          label="Platform Admin"
          icon={Shield}
          items={filteredGlobalAdminItems}
          isOpen={sectionState.platformAdmin}
          onToggle={() => toggleSection('platformAdmin')}
        />
      </SidebarContent>
    </Sidebar>
  );
}
