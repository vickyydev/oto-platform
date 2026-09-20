import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Users,
  Building2,
  GitBranch,
  UserPlus,
  Copy,
  Rocket,
  DollarSign,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Loader2,
  Filter,
  Eye,
  EyeOff,
  Calculator,
  PieChart,
  Megaphone,
  Plus,
  X,
  Phone,
  Mail,
  Link2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { GenerateHiringPostDialog } from "@/components/hiring/GenerateHiringPostDialog";

type OrgMode = "live" | "draft";

interface OrgNode {
  id: string;
  tenantId: string;
  mode: OrgMode;
  scopeType: "company" | "branch";
  scopeBranchId: string | null;
  nodeType: "person" | "vacant_role";
  personEmployeeId: string | null;
  title: string | null;
  nicknameOverride: string | null;
  positionTitle: string | null;
  branchId: string | null;
  departmentId: string | null;
  reportsToNodeId: string | null;
  expectedMonthlySalary: number | null;
  isVacant: boolean;
  isAdvisor: boolean;
  isDisabled: boolean;
  isDeleted: boolean;
  sortOrder: number;
  employeeNickname?: string | null;
  employeeFullName?: string | null;
  employeePositionTitle?: string | null;
  employeeSalary?: number | null;
  employeeDepartmentId?: string | null;
  branchName?: string | null;
  departmentName?: string | null;
  costAllocationCount?: number;
  // Hiring & Recruitment fields
  hiringStatus?: "not_hiring" | "hiring" | null;
  employmentType?: "full_time" | "part_time" | "casual" | null;
  jobDescription?: string | null;
  keyResponsibilities?: string[] | null;
  requirements?: string[] | null;
  salaryRange?: string | null;
  benefits?: string[] | null;
  contactPhone?: string | null;
  contactLine?: string | null;
  contactEmail?: string | null;
  applyUrl?: string | null;
}

interface Department {
  id: string;
  name: string;
}

interface BudgetData {
  live: {
    totalSalary: number;
    personCount: number;
    vacantCount: number;
    byBranch: Record<string, { name: string; salary: number; personCount: number; vacantCount: number }>;
  };
  draft: {
    totalSalary: number;
    personCount: number;
    vacantCount: number;
    byBranch: Record<string, { name: string; salary: number; personCount: number; vacantCount: number }>;
  };
  delta: {
    salary: number;
    personCount: number;
    vacantCount: number;
  };
}

interface Branch {
  id: string;
  name: string;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// Department color palette - consistent colors for each department
// Note: Purple/Violet is reserved for Advisors and not included here
const DEPARTMENT_COLORS = [
  { bg: "bg-blue-100 dark:bg-blue-900/40", border: "border-l-blue-500", text: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/40", border: "border-l-emerald-500", text: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  { bg: "bg-orange-100 dark:bg-orange-900/40", border: "border-l-orange-500", text: "text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
  { bg: "bg-pink-100 dark:bg-pink-900/40", border: "border-l-pink-500", text: "text-pink-700 dark:text-pink-300", dot: "bg-pink-500" },
  { bg: "bg-cyan-100 dark:bg-cyan-900/40", border: "border-l-cyan-500", text: "text-cyan-700 dark:text-cyan-300", dot: "bg-cyan-500" },
  { bg: "bg-lime-100 dark:bg-lime-900/40", border: "border-l-lime-500", text: "text-lime-700 dark:text-lime-300", dot: "bg-lime-500" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/40", border: "border-l-indigo-500", text: "text-indigo-700 dark:text-indigo-300", dot: "bg-indigo-500" },
  { bg: "bg-rose-100 dark:bg-rose-900/40", border: "border-l-rose-500", text: "text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
  { bg: "bg-teal-100 dark:bg-teal-900/40", border: "border-l-teal-500", text: "text-teal-700 dark:text-teal-300", dot: "bg-teal-500" },
  { bg: "bg-sky-100 dark:bg-sky-900/40", border: "border-l-sky-500", text: "text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
];

function getDepartmentColorMap(departments: Department[]): Map<string | null, typeof DEPARTMENT_COLORS[0]> {
  const colorMap = new Map<string | null, typeof DEPARTMENT_COLORS[0]>();
  departments.forEach((dept, index) => {
    colorMap.set(dept.id, DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]);
  });
  // Add a neutral color for unassigned
  colorMap.set(null, { bg: "bg-gray-100 dark:bg-gray-800/40", border: "border-l-gray-400", text: "text-gray-600 dark:text-gray-400", dot: "bg-gray-400" });
  return colorMap;
}

function OrgNodeCard({
  node,
  mode,
  isAdmin,
  onEdit,
  onDelete,
  onToggleDisabled,
  hasChildren,
  isExpanded,
  onToggle,
  departmentColorMap,
}: {
  node: OrgNode;
  mode: OrgMode;
  isAdmin: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleDisabled?: () => void;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  departmentColorMap?: Map<string | null, typeof DEPARTMENT_COLORS[0]>;
}) {
  const displayName = node.nicknameOverride || node.employeeNickname || node.title || "Unnamed";
  const positionTitle = node.positionTitle || node.employeePositionTitle || "";
  const isVacant = node.nodeType === "vacant_role";
  const isAdvisor = node.isAdvisor;
  const isDisabled = node.isDisabled;
  const salary = isVacant ? node.expectedMonthlySalary : node.employeeSalary;
  const departmentName = node.departmentName;
  const deptId = node.departmentId || node.employeeDepartmentId || null;
  const deptColor = departmentColorMap?.get(deptId);

  const getCardStyle = () => {
    const deptBg = deptColor?.bg || "";
    if (isDisabled) {
      return `opacity-50 border-dashed border-2 border-gray-400 ${deptBg}`;
    }
    if (isAdvisor) {
      return "border-dashed border-2 border-purple-500 bg-purple-50/30 dark:bg-purple-950/20";
    }
    if (isVacant) {
      return `border-dashed border-2 border-amber-500 ${deptBg}`;
    }
    return deptBg;
  };

  return (
    <div 
      className="relative group"
      data-testid={`org-node-${node.id}`}
    >
      <Card className={`w-48 transition-shadow hover:shadow-md ${getCardStyle()}`}>
        <CardContent className="p-3">
          <div className="flex items-start justify-between gap-1">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="font-semibold text-sm truncate" title={displayName}>
                  {displayName}
                </span>
              </div>
              {positionTitle && (
                <p className="text-xs text-muted-foreground truncate mt-0.5" title={positionTitle}>
                  {positionTitle}
                </p>
              )}
              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                {isDisabled && (
                  <Badge variant="outline" className="text-xs py-0 px-1.5 bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-400">
                    Disabled
                  </Badge>
                )}
                {isAdvisor && (
                  <Badge variant="outline" className="text-xs py-0 px-1.5 bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900 dark:text-purple-300">
                    Advisor
                  </Badge>
                )}
                {node.branchName && (
                  <Badge variant="secondary" className="text-xs py-0 px-1.5">
                    {node.branchName}
                  </Badge>
                )}
                {node.costAllocationCount && node.costAllocationCount > 1 && (
                  <Badge variant="outline" className="text-xs py-0 px-1.5 bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300" title="Cost split across branches">
                    <PieChart className="h-3 w-3 mr-0.5" />
                    {node.costAllocationCount}
                  </Badge>
                )}
              </div>
              {salary != null && salary > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {formatCurrency(salary)}/mo
                </p>
              )}
            </div>
            {isAdmin && mode === "draft" && (
              <div className="flex flex-col gap-0.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
                {onToggleDisabled && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => { e.stopPropagation(); onToggleDisabled(); }}
                    data-testid={`toggle-disabled-node-${node.id}`}
                    title={isDisabled ? "Enable position" : "Disable position"}
                  >
                    {isDisabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </Button>
                )}
                {onEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    data-testid={`edit-node-${node.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                )}
                {onDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    data-testid={`delete-node-${node.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {hasChildren && (
        <button
          onClick={onToggle}
          className="absolute -bottom-3 left-1/2 -translate-x-1/2 z-10 w-6 h-6 rounded-full bg-background border shadow-sm flex items-center justify-center hover-elevate"
          data-testid={`toggle-node-${node.id}`}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  );
}

function OrgTreeNode({
  node,
  childrenMap,
  mode,
  isAdmin,
  onEdit,
  onDelete,
  onToggleDisabled,
  expandedNodes,
  toggleExpand,
  departmentColorMap,
}: {
  node: OrgNode;
  childrenMap: Map<string | null, OrgNode[]>;
  mode: OrgMode;
  isAdmin: boolean;
  onEdit: (node: OrgNode) => void;
  onDelete: (node: OrgNode) => void;
  onToggleDisabled: (node: OrgNode) => void;
  expandedNodes: Set<string>;
  toggleExpand: (id: string) => void;
  departmentColorMap?: Map<string | null, typeof DEPARTMENT_COLORS[0]>;
}) {
  const children = childrenMap.get(node.id) || [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedNodes.has(node.id);

  return (
    <div className="flex flex-col items-center">
      <OrgNodeCard
        node={node}
        mode={mode}
        isAdmin={isAdmin}
        onEdit={() => onEdit(node)}
        onDelete={() => onDelete(node)}
        onToggleDisabled={() => onToggleDisabled(node)}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onToggle={() => toggleExpand(node.id)}
        departmentColorMap={departmentColorMap}
      />
      {hasChildren && isExpanded && (
        <>
          <div className="w-px h-6 bg-border" />
          <div className="flex gap-3">
            {children.map((child, index) => (
              <div key={child.id} className="flex flex-col items-center relative">
                <div className="w-px h-4 bg-border" />
                {children.length > 1 && (
                  <div 
                    className="absolute top-0 h-px bg-border"
                    style={{
                      left: index === 0 ? '50%' : '0',
                      right: index === children.length - 1 ? '50%' : '0',
                    }}
                  />
                )}
                <OrgTreeNode
                  node={child}
                  childrenMap={childrenMap}
                  mode={mode}
                  isAdmin={isAdmin}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onToggleDisabled={onToggleDisabled}
                  expandedNodes={expandedNodes}
                  toggleExpand={toggleExpand}
                  departmentColorMap={departmentColorMap}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OrgTree({
  nodes,
  mode,
  isAdmin,
  onEdit,
  onDelete,
  onToggleDisabled,
  departmentColorMap,
}: {
  nodes: OrgNode[];
  mode: OrgMode;
  isAdmin: boolean;
  onEdit: (node: OrgNode) => void;
  onDelete: (node: OrgNode) => void;
  onToggleDisabled: (node: OrgNode) => void;
  departmentColorMap?: Map<string | null, typeof DEPARTMENT_COLORS[0]>;
}) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set(nodes.map(n => n.id)));
  
  useEffect(() => {
    setExpandedNodes(prev => {
      const nodeIds = new Set(nodes.map(n => n.id));
      const next = new Set(prev);
      prev.forEach(id => {
        if (!nodeIds.has(id)) next.delete(id);
      });
      nodes.forEach(n => {
        if (!prev.has(n.id)) next.add(n.id);
      });
      return next;
    });
  }, [nodes]);
  
  const toggleExpand = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const childrenMap = new Map<string | null, OrgNode[]>();

  nodes.forEach((node) => {
    const parentId = node.reportsToNodeId;
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, []);
    }
    childrenMap.get(parentId)!.push(node);
  });

  const rootNodes = childrenMap.get(null) || [];
  
  if (rootNodes.length === 0 && nodes.length > 0) {
    return (
      <div className="flex flex-wrap gap-4 justify-center py-4">
        {nodes.map((node) => (
          <OrgTreeNode
            key={node.id}
            node={node}
            childrenMap={childrenMap}
            mode={mode}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleDisabled={onToggleDisabled}
            expandedNodes={expandedNodes}
            toggleExpand={toggleExpand}
            departmentColorMap={departmentColorMap}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto py-4">
      <div className="flex gap-8 justify-center min-w-max">
        {rootNodes.map((node) => (
          <OrgTreeNode
            key={node.id}
            node={node}
            childrenMap={childrenMap}
            mode={mode}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleDisabled={onToggleDisabled}
            expandedNodes={expandedNodes}
            toggleExpand={toggleExpand}
            departmentColorMap={departmentColorMap}
          />
        ))}
      </div>
    </div>
  );
}

function BudgetSummary({ budget }: { budget: BudgetData }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="w-4 h-4" />
            Headcount
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{budget.live.personCount}</div>
          <p className="text-xs text-muted-foreground">
            + {budget.live.vacantCount} vacant positions
          </p>
          {budget.delta.personCount !== 0 && (
            <Badge variant={budget.delta.personCount > 0 ? "default" : "destructive"} className="mt-2">
              {budget.delta.personCount > 0 ? "+" : ""}{budget.delta.personCount} in draft
            </Badge>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Monthly Salary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatCurrency(budget.live.totalSalary)}</div>
          <p className="text-xs text-muted-foreground">Live organization</p>
          {budget.delta.salary !== 0 && (
            <Badge variant={budget.delta.salary > 0 ? "destructive" : "default"} className="mt-2">
              {budget.delta.salary > 0 ? "+" : ""}{formatCurrency(budget.delta.salary)} in draft
            </Badge>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Vacant Positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-amber-600">{budget.live.vacantCount}</div>
          <p className="text-xs text-muted-foreground">Roles to fill</p>
          {budget.delta.vacantCount !== 0 && (
            <Badge variant="outline" className="mt-2">
              {budget.delta.vacantCount > 0 ? "+" : ""}{budget.delta.vacantCount} in draft
            </Badge>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DepartmentTotalsBar({
  nodes,
  departments,
  mode,
  departmentColorMap,
}: {
  nodes: OrgNode[];
  departments: Department[];
  mode: OrgMode;
  departmentColorMap?: Map<string | null, typeof DEPARTMENT_COLORS[0]>;
}) {
  const deptMap = new Map(departments.map(d => [d.id, d.name]));
  
  const costByDepartment = new Map<string | null, { name: string; cost: number; headcount: number; hiringCount: number }>();
  
  let totalEnabledCost = 0;
  let totalHeadcount = 0;
  
  nodes.forEach(node => {
    if (node.isAdvisor || node.isDisabled) return;
    
    const deptId = node.departmentId || node.employeeDepartmentId || null;
    const deptName = deptId ? (deptMap.get(deptId) || "Unknown") : "Unassigned";
    const salary = node.nodeType === "vacant_role" ? (node.expectedMonthlySalary || 0) : (node.employeeSalary || 0);
    const isVacant = node.nodeType === "vacant_role";
    
    if (!costByDepartment.has(deptId)) {
      costByDepartment.set(deptId, { name: deptName, cost: 0, headcount: 0, hiringCount: 0 });
    }
    
    const dept = costByDepartment.get(deptId)!;
    dept.cost += salary;
    dept.headcount += 1;
    if (isVacant) {
      dept.hiringCount += 1;
    }
    totalEnabledCost += salary;
    totalHeadcount += 1;
  });
  
  const sortedDepts = Array.from(costByDepartment.entries())
    .sort((a, b) => b[1].cost - a[1].cost);
  
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t shadow-lg">
      <div className="max-w-full overflow-x-auto">
        <div className="flex items-center gap-3 px-4 py-2 min-w-max">
          <div className="flex items-center gap-2 pr-3 border-r">
            <Calculator className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{mode === "draft" ? "Draft" : "Live"}</span>
            <span className="font-bold">{formatCurrency(totalEnabledCost)}/mo</span>
            <span className="text-xs text-muted-foreground">({totalHeadcount})</span>
          </div>
          {sortedDepts.map(([deptId, data]) => {
            const deptColor = departmentColorMap?.get(deptId);
            return (
              <div 
                key={deptId || "unassigned"} 
                className={`flex items-center gap-2 px-2.5 py-1 rounded-md text-sm ${deptColor?.bg || "bg-gray-100 dark:bg-gray-800"}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${deptColor?.dot || "bg-gray-400"}`} />
                <span className="font-medium truncate max-w-[100px]" title={data.name}>{data.name}</span>
                <span className="text-xs">{formatCurrency(data.cost)}</span>
                <span className="text-xs text-muted-foreground">({data.headcount})</span>
                {data.hiringCount > 0 && (
                  <Badge variant="outline" className="text-xs py-0 px-1 border-dashed border-amber-500 text-amber-600 dark:text-amber-400">
                    {data.hiringCount} hiring
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EditNodeDialog({
  open,
  onOpenChange,
  node,
  onSubmit,
  branches,
  departments,
  allNodes,
  isSubmitting,
  onGeneratePost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: OrgNode | null;
  onSubmit: (nodeId: string, data: {
    title?: string;
    nicknameOverride?: string;
    positionTitle?: string;
    branchId?: string | null;
    departmentId?: string | null;
    reportsToNodeId?: string | null;
    expectedMonthlySalary?: number;
    hiringStatus?: string;
    employmentType?: string | null;
    jobDescription?: string | null;
    keyResponsibilities?: string[];
    requirements?: string[];
    salaryRange?: string | null;
    benefits?: string[];
    contactPhone?: string | null;
    contactLine?: string | null;
    contactEmail?: string | null;
    applyUrl?: string | null;
  }) => void;
  branches: Branch[];
  departments: Department[];
  allNodes: OrgNode[];
  isSubmitting: boolean;
  onGeneratePost?: (node: OrgNode) => void;
}) {
  const [title, setTitle] = useState("");
  const [nicknameOverride, setNicknameOverride] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [reportsToNodeId, setReportsToNodeId] = useState<string>("");
  const [salary, setSalary] = useState("");
  const [isAdvisor, setIsAdvisor] = useState(false);
  
  // Hiring fields
  const [hiringOpen, setHiringOpen] = useState(false);
  const [hiringStatus, setHiringStatus] = useState<"not_hiring" | "hiring">("not_hiring");
  const [employmentType, setEmploymentType] = useState<string>("");
  const [jobDescription, setJobDescription] = useState("");
  const [keyResponsibilities, setKeyResponsibilities] = useState<string[]>([]);
  const [requirements, setRequirements] = useState<string[]>([]);
  const [salaryRange, setSalaryRange] = useState("");
  const [benefits, setBenefits] = useState<string[]>([]);
  const [contactPhone, setContactPhone] = useState("");
  const [contactLine, setContactLine] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [applyUrl, setApplyUrl] = useState("");
  const [newResponsibility, setNewResponsibility] = useState("");
  const [newRequirement, setNewRequirement] = useState("");
  const [newBenefit, setNewBenefit] = useState("");

  const isVacant = node?.nodeType === "vacant_role";

  const resetForm = () => {
    setTitle("");
    setNicknameOverride("");
    setPositionTitle("");
    setBranchId("");
    setDepartmentId("");
    setReportsToNodeId("");
    setSalary("");
    setIsAdvisor(false);
    setHiringOpen(false);
    setHiringStatus("not_hiring");
    setEmploymentType("");
    setJobDescription("");
    setKeyResponsibilities([]);
    setRequirements([]);
    setSalaryRange("");
    setBenefits([]);
    setContactPhone("");
    setContactLine("");
    setContactEmail("");
    setApplyUrl("");
    setNewResponsibility("");
    setNewRequirement("");
    setNewBenefit("");
  };

  useEffect(() => {
    if (node && open) {
      setTitle(node.title || "");
      setNicknameOverride(node.nicknameOverride || "");
      setPositionTitle(node.positionTitle || node.employeePositionTitle || "");
      setBranchId(node.branchId || "");
      setDepartmentId(node.departmentId || "");
      setReportsToNodeId(node.reportsToNodeId || "");
      setSalary(node.nodeType === "vacant_role" ? String(node.expectedMonthlySalary || "") : "");
      setIsAdvisor(node.isAdvisor || false);
      // Hiring fields
      setHiringStatus(node.hiringStatus || "not_hiring");
      setEmploymentType(node.employmentType || "");
      setJobDescription(node.jobDescription || "");
      setKeyResponsibilities(node.keyResponsibilities || []);
      setRequirements(node.requirements || []);
      setSalaryRange(node.salaryRange || "");
      setBenefits(node.benefits || []);
      setContactPhone(node.contactPhone || "");
      setContactLine(node.contactLine || "");
      setContactEmail(node.contactEmail || "");
      setApplyUrl(node.applyUrl || "");
      setHiringOpen(node.hiringStatus === "hiring");
    }
  }, [node, open]);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetForm();
    }
    onOpenChange(isOpen);
  };

  const handleSubmit = () => {
    if (!node) return;
    const data: any = {
      positionTitle: positionTitle || null,
      branchId: branchId && branchId !== "__none__" ? branchId : null,
      reportsToNodeId: reportsToNodeId && reportsToNodeId !== "__none__" ? reportsToNodeId : null,
      isAdvisor,
    };
    if (isVacant) {
      data.title = title;
      data.departmentId = departmentId && departmentId !== "__none__" ? departmentId : null;
      data.expectedMonthlySalary = salary.trim() ? parseFloat(salary) : null;
      // Hiring data
      data.hiringStatus = hiringStatus;
      data.employmentType = employmentType || null;
      data.jobDescription = jobDescription || null;
      data.keyResponsibilities = keyResponsibilities.length > 0 ? keyResponsibilities : null;
      data.requirements = requirements.length > 0 ? requirements : null;
      data.salaryRange = salaryRange || null;
      data.benefits = benefits.length > 0 ? benefits : null;
      data.contactPhone = contactPhone || null;
      data.contactLine = contactLine || null;
      data.contactEmail = contactEmail || null;
      data.applyUrl = applyUrl || null;
    } else {
      data.nicknameOverride = nicknameOverride || null;
    }
    onSubmit(node.id, data);
  };

  const addResponsibility = () => {
    if (newResponsibility.trim()) {
      setKeyResponsibilities([...keyResponsibilities, newResponsibility.trim()]);
      setNewResponsibility("");
    }
  };

  const removeResponsibility = (index: number) => {
    setKeyResponsibilities(keyResponsibilities.filter((_, i) => i !== index));
  };

  const addRequirement = () => {
    if (newRequirement.trim()) {
      setRequirements([...requirements, newRequirement.trim()]);
      setNewRequirement("");
    }
  };

  const removeRequirement = (index: number) => {
    setRequirements(requirements.filter((_, i) => i !== index));
  };

  const addBenefit = () => {
    if (newBenefit.trim()) {
      setBenefits([...benefits, newBenefit.trim()]);
      setNewBenefit("");
    }
  };

  const removeBenefit = (index: number) => {
    setBenefits(benefits.filter((_, i) => i !== index));
  };

  const displayName = node ? (node.nicknameOverride || node.employeeNickname || node.title || "Position") : "Position";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {isVacant ? "Vacant Position" : displayName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {isVacant ? (
            <div>
              <Label htmlFor="edit-title">Position Name</Label>
              <Input
                id="edit-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Senior Developer"
                data-testid="input-edit-title"
              />
            </div>
          ) : (
            <div>
              <Label htmlFor="edit-nickname">Display Name Override</Label>
              <Input
                id="edit-nickname"
                value={nicknameOverride}
                onChange={(e) => setNicknameOverride(e.target.value)}
                placeholder={node?.employeeNickname || "Leave blank to use employee name"}
                data-testid="input-edit-nickname"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Override the display name shown in the org chart
              </p>
            </div>
          )}
          <div>
            <Label htmlFor="edit-position">Job Title</Label>
            <Input
              id="edit-position"
              value={positionTitle}
              onChange={(e) => setPositionTitle(e.target.value)}
              placeholder="e.g., Software Engineer"
              data-testid="input-edit-position"
            />
          </div>
          <div>
            <Label>Branch</Label>
            <Select value={branchId || "__none__"} onValueChange={(v) => setBranchId(v === "__none__" ? "" : v)}>
              <SelectTrigger data-testid="select-edit-branch">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No branch</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isVacant && (
            <div>
              <Label>Department</Label>
              <Select value={departmentId || "__none__"} onValueChange={(v) => setDepartmentId(v === "__none__" ? "" : v)}>
                <SelectTrigger data-testid="select-edit-department">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No department</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Reports To</Label>
            <Select value={reportsToNodeId || "__none__"} onValueChange={(v) => setReportsToNodeId(v === "__none__" ? "" : v)}>
              <SelectTrigger data-testid="select-edit-reports-to">
                <SelectValue placeholder="Select supervisor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No supervisor (top level)</SelectItem>
                {allNodes
                  .filter((n) => n.id !== node?.id)
                  .map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.nicknameOverride || n.employeeNickname || n.title || "Unnamed"}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {isVacant && (
            <div>
              <Label htmlFor="edit-salary">Expected Monthly Salary (THB)</Label>
              <Input
                id="edit-salary"
                type="number"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="0"
                data-testid="input-edit-salary"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="edit-advisor"
              checked={isAdvisor}
              onCheckedChange={(checked) => setIsAdvisor(checked === true)}
              data-testid="checkbox-edit-advisor"
            />
            <Label htmlFor="edit-advisor" className="cursor-pointer">
              Mark as Advisor
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Advisors can be hidden from the chart using the toggle above
          </p>

          {/* Hiring & Recruitment Section - Only for Vacant Roles */}
          {isVacant && (
            <Collapsible open={hiringOpen} onOpenChange={setHiringOpen} className="border rounded-md">
              <CollapsibleTrigger asChild>
                <div className="flex items-center justify-between p-3 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Megaphone className="w-4 h-4" />
                    <span className="font-medium">Hiring & Recruitment</span>
                    {hiringStatus === "hiring" && (
                      <Badge variant="default">Hiring</Badge>
                    )}
                  </div>
                  {hiringOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent className="px-3 pb-3 space-y-4">
                {/* Hiring Status Toggle */}
                <div className="flex items-center justify-between">
                  <Label>Actively Hiring</Label>
                  <Switch
                    checked={hiringStatus === "hiring"}
                    onCheckedChange={(checked) => setHiringStatus(checked ? "hiring" : "not_hiring")}
                    data-testid="switch-hiring-status"
                  />
                </div>

                {/* Employment Type */}
                <div>
                  <Label>Employment Type</Label>
                  <Select value={employmentType || "__none__"} onValueChange={(v) => setEmploymentType(v === "__none__" ? "" : v)}>
                    <SelectTrigger data-testid="select-employment-type">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Not specified</SelectItem>
                      <SelectItem value="full_time">Full-time</SelectItem>
                      <SelectItem value="part_time">Part-time</SelectItem>
                      <SelectItem value="casual">Casual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Job Description */}
                <div>
                  <Label htmlFor="job-description">Job Description</Label>
                  <Textarea
                    id="job-description"
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Describe the role and responsibilities..."
                    className="min-h-[80px]"
                    data-testid="textarea-job-description"
                  />
                </div>

                {/* Key Responsibilities */}
                <div>
                  <Label>Key Responsibilities</Label>
                  <div className="space-y-2">
                    {keyResponsibilities.map((item, index) => (
                      <div key={index} className="flex items-center gap-2 bg-muted/50 rounded px-2 py-1">
                        <span className="flex-1 text-sm">{item}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeResponsibility(index)}
                          data-testid={`button-remove-responsibility-${index}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input
                        value={newResponsibility}
                        onChange={(e) => setNewResponsibility(e.target.value)}
                        placeholder="Add a responsibility..."
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addResponsibility())}
                        data-testid="input-new-responsibility"
                      />
                      <Button size="icon" variant="outline" onClick={addResponsibility} data-testid="button-add-responsibility">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Requirements */}
                <div>
                  <Label>Requirements / Skills</Label>
                  <div className="space-y-2">
                    {requirements.map((item, index) => (
                      <div key={index} className="flex items-center gap-2 bg-muted/50 rounded px-2 py-1">
                        <span className="flex-1 text-sm">{item}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeRequirement(index)}
                          data-testid={`button-remove-requirement-${index}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input
                        value={newRequirement}
                        onChange={(e) => setNewRequirement(e.target.value)}
                        placeholder="Add a requirement..."
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRequirement())}
                        data-testid="input-new-requirement"
                      />
                      <Button size="icon" variant="outline" onClick={addRequirement} data-testid="button-add-requirement">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Salary Range */}
                <div>
                  <Label htmlFor="salary-range">Salary Range (Display Text)</Label>
                  <Input
                    id="salary-range"
                    value={salaryRange}
                    onChange={(e) => setSalaryRange(e.target.value)}
                    placeholder="e.g., 25,000 - 35,000 THB/month"
                    data-testid="input-salary-range"
                  />
                </div>

                {/* Benefits */}
                <div>
                  <Label>Benefits</Label>
                  <div className="space-y-2">
                    {benefits.map((item, index) => (
                      <div key={index} className="flex items-center gap-2 bg-muted/50 rounded px-2 py-1">
                        <span className="flex-1 text-sm">{item}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeBenefit(index)}
                          data-testid={`button-remove-benefit-${index}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input
                        value={newBenefit}
                        onChange={(e) => setNewBenefit(e.target.value)}
                        placeholder="Add a benefit..."
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addBenefit())}
                        data-testid="input-new-benefit"
                      />
                      <Button size="icon" variant="outline" onClick={addBenefit} data-testid="button-add-benefit">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Contact Methods */}
                <div className="space-y-3">
                  <Label className="font-medium">Contact Methods</Label>
                  <div className="grid gap-3">
                    <div className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-muted-foreground" />
                      <Input
                        value={contactPhone}
                        onChange={(e) => setContactPhone(e.target.value)}
                        placeholder="Phone number"
                        data-testid="input-contact-phone"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM15.5 8.5C15.5 9.33 14.83 10 14 10C13.17 10 12.5 9.33 12.5 8.5C12.5 7.67 13.17 7 14 7C14.83 7 15.5 7.67 15.5 8.5ZM9.5 8.5C9.5 7.67 10.17 7 11 7C11.83 7 12.5 7.67 12.5 8.5C12.5 9.33 11.83 10 11 10C10.17 10 9.5 9.33 9.5 8.5ZM12 17.5C9.33 17.5 7.08 15.89 6.15 13.5H17.85C16.92 15.89 14.67 17.5 12 17.5Z"/>
                      </svg>
                      <Input
                        value={contactLine}
                        onChange={(e) => setContactLine(e.target.value)}
                        placeholder="LINE ID"
                        data-testid="input-contact-line"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <Input
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                        placeholder="Email address"
                        data-testid="input-contact-email"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Link2 className="w-4 h-4 text-muted-foreground" />
                      <Input
                        value={applyUrl}
                        onChange={(e) => setApplyUrl(e.target.value)}
                        placeholder="Application URL"
                        data-testid="input-apply-url"
                      />
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="flex-1"
              data-testid="button-save-edit"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
            {isVacant && onGeneratePost && node && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => onGeneratePost(node)}
                data-testid="button-generate-post"
                title="Generate hiring post image"
              >
                <Megaphone className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddVacantRoleDialog({
  open,
  onOpenChange,
  onSubmit,
  branches,
  departments,
  nodes,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { title: string; positionTitle: string; branchId: string | null; departmentId: string | null; reportsToNodeId: string | null; expectedMonthlySalary: number; isAdvisor: boolean }) => void;
  branches: Branch[];
  departments: Department[];
  nodes: OrgNode[];
  isSubmitting: boolean;
}) {
  const [title, setTitle] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [reportsToNodeId, setReportsToNodeId] = useState<string>("");
  const [salary, setSalary] = useState("");
  const [isAdvisor, setIsAdvisor] = useState(false);

  const handleSubmit = () => {
    onSubmit({
      title,
      positionTitle,
      branchId: branchId && branchId !== "__none__" ? branchId : null,
      departmentId: departmentId && departmentId !== "__none__" ? departmentId : null,
      reportsToNodeId: reportsToNodeId && reportsToNodeId !== "__none__" ? reportsToNodeId : null,
      expectedMonthlySalary: parseFloat(salary) || 0,
      isAdvisor,
    });
    setTitle("");
    setPositionTitle("");
    setBranchId("");
    setDepartmentId("");
    setReportsToNodeId("");
    setSalary("");
    setIsAdvisor(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Vacant Position</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="title">Position Name</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Senior Developer"
              data-testid="input-vacant-title"
            />
          </div>
          <div>
            <Label htmlFor="positionTitle">Job Title</Label>
            <Input
              id="positionTitle"
              value={positionTitle}
              onChange={(e) => setPositionTitle(e.target.value)}
              placeholder="e.g., Software Engineer"
              data-testid="input-vacant-position"
            />
          </div>
          <div>
            <Label>Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger data-testid="select-vacant-branch">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger data-testid="select-vacant-department">
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No department</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reports To</Label>
            <Select value={reportsToNodeId || "__none__"} onValueChange={(v) => setReportsToNodeId(v === "__none__" ? "" : v)}>
              <SelectTrigger data-testid="select-vacant-reports-to">
                <SelectValue placeholder="Select supervisor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No supervisor</SelectItem>
                {nodes
                  .filter((n) => n.nodeType === "person")
                  .map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.nicknameOverride || n.employeeNickname || n.title}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="salary">Expected Monthly Salary (THB)</Label>
            <Input
              id="salary"
              type="number"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="0"
              data-testid="input-vacant-salary"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="vacant-isAdvisor"
              checked={isAdvisor}
              onCheckedChange={setIsAdvisor}
              data-testid="switch-vacant-advisor"
            />
            <Label htmlFor="vacant-isAdvisor" className="cursor-pointer">
              Advisor Position
            </Label>
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!title || isSubmitting}
            className="w-full"
            data-testid="button-create-vacant"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Vacant Position"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function OrgChartPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [mode, setMode] = useState<OrgMode>("live");
  const [addVacantOpen, setAddVacantOpen] = useState(false);
  const [editNodeOpen, setEditNodeOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<OrgNode | null>(null);
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [showAdvisors, setShowAdvisors] = useState(true);
  const [hiringPostOpen, setHiringPostOpen] = useState(false);
  const [hiringPostNode, setHiringPostNode] = useState<OrgNode | null>(null);

  const isAdmin = ["admin", "global_admin", "operator_admin"].includes(user?.role || "");

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  // Create department color map for consistent coloring
  const departmentColorMap = getDepartmentColorMap(departments);

  const {
    data: nodes = [],
    isLoading: nodesLoading,
    error: nodesError,
  } = useQuery<OrgNode[]>({
    queryKey: ["/api/org-chart/nodes", mode],
    queryFn: async () => {
      const res = await fetch(`/api/org-chart/nodes?mode=${mode}&scopeType=company`);
      if (!res.ok) throw new Error("Failed to fetch org chart");
      return res.json();
    },
  });

  const { data: budget, isLoading: budgetLoading } = useQuery<BudgetData>({
    queryKey: ["/api/org-chart/budget"],
    enabled: isAdmin,
  });

  const initializeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/org-chart/initialize-from-employees", {
        scopeType: "company",
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Success", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/org-chart/clone-live-to-draft", {
        scopeType: "company",
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Draft Created", description: data.message });
      setMode("draft");
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/org-chart/promote-draft-to-live", {
        scopeType: "company",
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Changes Published", description: data.message });
      setMode("live");
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createNodeMutation = useMutation({
    mutationFn: async (data: {
      title: string;
      positionTitle: string;
      branchId: string | null;
      departmentId: string | null;
      reportsToNodeId: string | null;
      expectedMonthlySalary: number;
      isAdvisor: boolean;
    }) => {
      const res = await apiRequest("POST", "/api/org-chart/nodes", {
        mode: "draft",
        scopeType: "company",
        nodeType: "vacant_role",
        title: data.title,
        positionTitle: data.positionTitle,
        branchId: data.branchId,
        departmentId: data.departmentId,
        reportsToNodeId: data.reportsToNodeId,
        expectedMonthlySalary: data.expectedMonthlySalary,
        isVacant: true,
        isAdvisor: data.isAdvisor,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Vacant Position Created" });
      setAddVacantOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteNodeMutation = useMutation({
    mutationFn: async (nodeId: string) => {
      const res = await apiRequest("DELETE", `/api/org-chart/nodes/${nodeId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Position Removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleDisabledMutation = useMutation({
    mutationFn: async ({ nodeId, isDisabled }: { nodeId: string; isDisabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/org-chart/nodes/${nodeId}`, { isDisabled });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      toast({ title: variables.isDisabled ? "Position Disabled" : "Position Enabled" });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const editNodeMutation = useMutation({
    mutationFn: async ({ nodeId, data }: { nodeId: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/org-chart/nodes/${nodeId}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Position Updated" });
      setEditNodeOpen(false);
      setEditingNode(null);
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-chart/budget"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleEdit = (node: OrgNode) => {
    setEditingNode(node);
    setEditNodeOpen(true);
  };

  const handleDelete = (node: OrgNode) => {
    if (confirm(`Remove "${node.title || node.employeeNickname}" from the org chart?`)) {
      deleteNodeMutation.mutate(node.id);
    }
  };

  const handleToggleDisabled = (node: OrgNode) => {
    toggleDisabledMutation.mutate({ nodeId: node.id, isDisabled: !node.isDisabled });
  };

  const filteredNodes = nodes.filter(n => {
    if (branchFilter !== "all" && n.branchId !== branchFilter) return false;
    if (!showAdvisors && n.isAdvisor) return false;
    return true;
  });

  return (
    <div className="container mx-auto p-6 space-y-6 pb-20">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="w-6 h-6" />
            Organization Chart
          </h1>
          <p className="text-muted-foreground">
            Visualize company hierarchy and manage positions
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            {nodes.length === 0 && mode === "live" && (
              <Button
                onClick={() => initializeMutation.mutate()}
                disabled={initializeMutation.isPending}
                data-testid="button-initialize-org"
              >
                {initializeMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Users className="w-4 h-4 mr-2" />
                )}
                Initialize from Employees
              </Button>
            )}
            {mode === "live" && nodes.length > 0 && (
              <Button
                variant="outline"
                onClick={() => cloneMutation.mutate()}
                disabled={cloneMutation.isPending}
                data-testid="button-clone-to-draft"
              >
                {cloneMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Copy className="w-4 h-4 mr-2" />
                )}
                Open Structure Lab
              </Button>
            )}
            {mode === "draft" && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setAddVacantOpen(true)}
                  data-testid="button-add-vacant"
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  Add Vacant Position
                </Button>
                <Button
                  onClick={() => promoteMutation.mutate()}
                  disabled={promoteMutation.isPending}
                  data-testid="button-publish-draft"
                >
                  {promoteMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Rocket className="w-4 h-4 mr-2" />
                  )}
                  Publish Changes
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {isAdmin && budget && <BudgetSummary budget={budget} />}

      {isAdmin && (
        <Tabs value={mode} onValueChange={(v) => setMode(v as OrgMode)}>
          <TabsList>
            <TabsTrigger value="live" data-testid="tab-live">
              <Building2 className="w-4 h-4 mr-2" />
              Live
            </TabsTrigger>
            <TabsTrigger value="draft" data-testid="tab-draft">
              <GitBranch className="w-4 h-4 mr-2" />
              Structure Lab (Draft)
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="w-[200px]" data-testid="select-branch-filter">
              <SelectValue placeholder="Filter by branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {branchFilter !== "all" && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => setBranchFilter("all")}
              data-testid="button-clear-branch-filter"
            >
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="show-advisors"
            checked={showAdvisors}
            onCheckedChange={setShowAdvisors}
            data-testid="switch-show-advisors"
          />
          <Label htmlFor="show-advisors" className="cursor-pointer text-sm">
            Show Advisors
          </Label>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          {nodesLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-56" />
              <div className="ml-6 pl-4 border-l-2 border-muted space-y-2">
                <Skeleton className="h-16 w-56" />
                <Skeleton className="h-16 w-56" />
              </div>
            </div>
          ) : nodesError ? (
            <div className="text-center py-8 text-destructive">
              <AlertCircle className="w-8 h-8 mx-auto mb-2" />
              <p>Failed to load organization chart</p>
            </div>
          ) : filteredNodes.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              {nodes.length === 0 ? (
                <>
                  <p className="text-lg font-medium">No organization chart yet</p>
                  {isAdmin && mode === "live" && (
                    <p className="mt-2">
                      Click "Initialize from Employees" to create your org chart from existing employee data.
                    </p>
                  )}
                  {mode === "draft" && (
                    <p className="mt-2">
                      The draft is empty. Clone the live chart or add positions manually.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-lg font-medium">No employees in this branch</p>
                  <p className="mt-2">
                    Try selecting "All Branches" or a different branch.
                  </p>
                </>
              )}
            </div>
          ) : (
            <OrgTree
              nodes={filteredNodes}
              mode={mode}
              isAdmin={isAdmin}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleDisabled={handleToggleDisabled}
              departmentColorMap={departmentColorMap}
            />
          )}
        </CardContent>
      </Card>

      <AddVacantRoleDialog
        open={addVacantOpen}
        onOpenChange={setAddVacantOpen}
        onSubmit={(data) => createNodeMutation.mutate(data)}
        branches={branches}
        departments={departments}
        nodes={nodes}
        isSubmitting={createNodeMutation.isPending}
      />

      <EditNodeDialog
        open={editNodeOpen}
        onOpenChange={(open) => {
          setEditNodeOpen(open);
          if (!open) setEditingNode(null);
        }}
        node={editingNode}
        onSubmit={(nodeId, data) => editNodeMutation.mutate({ nodeId, data })}
        branches={branches}
        departments={departments}
        allNodes={nodes}
        isSubmitting={editNodeMutation.isPending}
        onGeneratePost={(node) => {
          setHiringPostNode(node);
          setHiringPostOpen(true);
        }}
      />

      <GenerateHiringPostDialog
        open={hiringPostOpen}
        onOpenChange={setHiringPostOpen}
        nodeData={hiringPostNode}
        companyName="OTO"
      />

      {isAdmin && mode === "draft" && nodes.length > 0 && (
        <DepartmentTotalsBar 
          nodes={filteredNodes} 
          departments={departments} 
          mode={mode} 
          departmentColorMap={departmentColorMap} 
        />
      )}
    </div>
  );
}
