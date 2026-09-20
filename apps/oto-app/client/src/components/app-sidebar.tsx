import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
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
  ClipboardCheck,
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

const operationsItems: MenuItem[] = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Attention",
    url: "/attention",
    icon: AlertTriangle,
  },
  {
    title: "Reviews",
    url: "/reviews",
    icon: ClipboardCheck,
    managerOnly: true,
  },
  {
    title: "Scheduling",
    url: "/scheduling",
    icon: CalendarDays,
    managerOnly: true,
  },
  {
    title: "Org Chart",
    url: "/org-chart",
    icon: GitBranch,
    managerOnly: true,
  },
  {
    title: "Timekeeping Review",
    url: "/timekeeping-review",
    icon: Clock,
    managerOnly: true,
  },
  {
    title: "Time & Attendance",
    url: "/time-attendance",
    icon: Clock,
    adminOnly: true,
  },
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
  {
    title: "My Payslips",
    url: "/my-payslips",
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
  hrOperations: boolean;
  configuration: boolean;
  platformAdmin: boolean;
  finance: boolean;
  payroll: boolean;
};

function getStoredSectionState(): SectionState {
  try {
    const stored = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {}
  return { hrOperations: false, configuration: false, platformAdmin: false, finance: false, payroll: false };
}

function storeSectionState(state: SectionState) {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(state));
  } catch {}
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const { isAllBranches } = useBranchContext();
  const [sectionState, setSectionState] = useState<SectionState>(getStoredSectionState);

  useEffect(() => {
    storeSectionState(sectionState);
  }, [sectionState]);

  const toggleSection = (section: keyof SectionState) => {
    setSectionState(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const filteredGlobalAdminItems = filterItems(globalAdminItems, user?.role, isAllBranches);
  const filteredAdminItems = filterItems(adminItems, user?.role, isAllBranches);
  const filteredOperationsItems = filterItems(operationsItems, user?.role, isAllBranches);
  const filteredFinanceItems = filterItems(financeItems, user?.role, isAllBranches);
  const filteredPayrollItems = filterItems(payrollItems, user?.role, isAllBranches);

  const wouldHaveConfigAccess = hasRoleAccess(adminItems, user?.role);
  const wouldHavePayrollAccess = hasRoleAccess(payrollItems, user?.role);
  const configHiddenByBranch = !isAllBranches && wouldHaveConfigAccess && filteredAdminItems.length === 0;

  const renderMenuItems = (items: MenuItem[]) => {
    return items.map((item) => {
      const isActive = location === item.url || 
        (item.url !== "/" && location.startsWith(item.url));
      return (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            asChild
            isActive={isActive}
            data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <Link href={item.url}>
              <item.icon className="h-4 w-4" />
              <span>{item.title}</span>
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
  }: { 
    id: string;
    label: string; 
    icon?: typeof Shield; 
    items: MenuItem[]; 
    isOpen: boolean; 
    onToggle: () => void;
    branchHint?: string;
  }) => {
    if (items.length === 0 && !branchHint) return null;
    
    return (
      <SidebarGroup>
        <Collapsible.Root open={isOpen} onOpenChange={onToggle}>
          <Collapsible.Trigger asChild>
            <SidebarGroupLabel 
              className="flex items-center gap-2 cursor-pointer hover-elevate rounded-md px-2 py-1 w-full justify-between"
              data-testid={`section-toggle-${id}`}
            >
              <span className="flex items-center gap-2">
                {Icon && <Icon className="h-3 w-3" />}
                {label}
              </span>
              {isOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </SidebarGroupLabel>
          </Collapsible.Trigger>
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
        <CollapsibleSection
          id="hr-operations"
          label="HR Operations"
          items={filteredOperationsItems}
          isOpen={sectionState.hrOperations}
          onToggle={() => toggleSection('hrOperations')}
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
          branchHint={configHiddenByBranch ? "Select 'All Branches' to access configuration" : undefined}
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
