import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Plus,
  Edit,
  Trash2,
  AlertTriangle,
  Building2,
  CheckCircle,
  Archive,
  RefreshCw,
  FileText,
  Scale,
  DollarSign,
} from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";

interface Operator {
  id: string;
  name: string;
  status: string;
}

interface Branch {
  id: string;
  name: string;
  operatorId?: string;
}

interface StatutoryRuleSet {
  id: string;
  tenantId: string;
  operatorId: string | null;
  branchId: string | null;
  countryCode: string;
  name: string;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "archived";
  rules: {
    sso?: {
      contributionRate: number;
      ceilingAmount: number;
      effectiveFrom: string;
      effectiveTo: string | null;
    };
    pit?: {
      brackets: Array<{ min: number; max: number | null; rate: number }>;
      personalExemption: number;
      spouseExemption: number;
      childExemption: number;
    };
  };
  createdBy: string | null;
  createdAt: string;
  updatedAt: string | null;
}

type RuleSetFormData = {
  countryCode: string;
  name: string;
  description: string;
  effectiveFrom: string;
  effectiveTo: string;
  operatorId: string;
  branchId: string;
  status: "active" | "archived";
  ssoContributionRate: string;
  ssoCeilingAmount: string;
  pitBrackets: string;
  pitPersonalExemption: string;
  pitSpouseExemption: string;
  pitChildExemption: string;
};

const defaultFormData: RuleSetFormData = {
  countryCode: "TH",
  name: "",
  description: "",
  effectiveFrom: "",
  effectiveTo: "",
  operatorId: "",
  branchId: "",
  status: "active",
  ssoContributionRate: "0.05",
  ssoCeilingAmount: "17500",
  pitBrackets: JSON.stringify([
    { min: 0, max: 150000, rate: 0 },
    { min: 150000, max: 300000, rate: 0.05 },
    { min: 300000, max: 500000, rate: 0.10 },
    { min: 500000, max: 750000, rate: 0.15 },
    { min: 750000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: 2000000, rate: 0.25 },
    { min: 2000000, max: 5000000, rate: 0.30 },
    { min: 5000000, max: null, rate: 0.35 },
  ], null, 2),
  pitPersonalExemption: "60000",
  pitSpouseExemption: "60000",
  pitChildExemption: "30000",
};

export default function PayrollStatutoryRulesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>("");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [selectedRuleSet, setSelectedRuleSet] = useState<StatutoryRuleSet | null>(null);
  const [formData, setFormData] = useState<RuleSetFormData>(defaultFormData);

  const isAdmin = user?.role === "global_admin" || user?.role === "admin";
  const isOperatorAdmin = user?.role === "operator_admin";

  const { data: operators = [] } = useQuery<Operator[]>({
    queryKey: ["/api/operators"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  useEffect(() => {
    if (operators.length > 0 && !selectedOperatorId) {
      const defaultOp = user?.operatorId || operators[0]?.id;
      if (defaultOp) {
        setSelectedOperatorId(defaultOp);
      }
    }
  }, [operators, selectedOperatorId, user?.operatorId]);

  const { data: ruleSets = [], isLoading, error, refetch } = useQuery<StatutoryRuleSet[]>({
    queryKey: ["/api/payroll/statutory-rule-sets", selectedOperatorId],
    queryFn: async () => {
      const url = selectedOperatorId 
        ? `/api/payroll/statutory-rule-sets?operatorId=${selectedOperatorId}`
        : "/api/payroll/statutory-rule-sets";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch statutory rule sets");
      return res.json();
    },
    enabled: !!user,
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("/api/payroll/statutory-rule-sets/seed", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/statutory-rule-sets"] });
      toast({ title: "Default rules created", description: "Thailand statutory rules have been seeded." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: RuleSetFormData) => {
      const payload = formDataToPayload(data);
      return apiRequest("/api/payroll/statutory-rule-sets", { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/statutory-rule-sets"] });
      setIsCreateDialogOpen(false);
      setFormData(defaultFormData);
      toast({ title: "Rule set created", description: "Statutory rule set has been created successfully." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: RuleSetFormData }) => {
      const payload = formDataToPayload(data);
      return apiRequest(`/api/payroll/statutory-rule-sets/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/statutory-rule-sets"] });
      setIsEditDialogOpen(false);
      setSelectedRuleSet(null);
      toast({ title: "Rule set updated", description: "Statutory rule set has been updated successfully." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest(`/api/payroll/statutory-rule-sets/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/statutory-rule-sets"] });
      toast({ title: "Rule set deleted", description: "Statutory rule set has been deleted." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  function formDataToPayload(data: RuleSetFormData) {
    let pitBrackets;
    try {
      pitBrackets = JSON.parse(data.pitBrackets);
    } catch {
      pitBrackets = [];
    }
    return {
      countryCode: data.countryCode,
      name: data.name,
      description: data.description || null,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo || null,
      operatorId: data.operatorId || null,
      branchId: data.branchId || null,
      status: data.status,
      rules: {
        sso: {
          contributionRate: parseFloat(data.ssoContributionRate) || 0.05,
          ceilingAmount: parseFloat(data.ssoCeilingAmount) || 17500,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo || null,
        },
        pit: {
          brackets: pitBrackets,
          personalExemption: parseFloat(data.pitPersonalExemption) || 60000,
          spouseExemption: parseFloat(data.pitSpouseExemption) || 60000,
          childExemption: parseFloat(data.pitChildExemption) || 30000,
        },
      },
    };
  }

  function ruleSetToFormData(ruleSet: StatutoryRuleSet): RuleSetFormData {
    return {
      countryCode: ruleSet.countryCode,
      name: ruleSet.name,
      description: ruleSet.description || "",
      effectiveFrom: ruleSet.effectiveFrom,
      effectiveTo: ruleSet.effectiveTo || "",
      operatorId: ruleSet.operatorId || "",
      branchId: ruleSet.branchId || "",
      status: ruleSet.status,
      ssoContributionRate: String(ruleSet.rules.sso?.contributionRate || 0.05),
      ssoCeilingAmount: String(ruleSet.rules.sso?.ceilingAmount || 17500),
      pitBrackets: JSON.stringify(ruleSet.rules.pit?.brackets || [], null, 2),
      pitPersonalExemption: String(ruleSet.rules.pit?.personalExemption || 60000),
      pitSpouseExemption: String(ruleSet.rules.pit?.spouseExemption || 60000),
      pitChildExemption: String(ruleSet.rules.pit?.childExemption || 30000),
    };
  }

  function handleEdit(ruleSet: StatutoryRuleSet) {
    setSelectedRuleSet(ruleSet);
    setFormData(ruleSetToFormData(ruleSet));
    setIsEditDialogOpen(true);
  }

  function handleDelete(id: string) {
    if (confirm("Are you sure you want to delete this rule set?")) {
      deleteMutation.mutate(id);
    }
  }

  function getScopeLabel(ruleSet: StatutoryRuleSet) {
    if (ruleSet.branchId) {
      const branch = branches.find((b) => b.id === ruleSet.branchId);
      return `Branch: ${branch?.name || ruleSet.branchId}`;
    }
    if (ruleSet.operatorId) {
      const operator = operators.find((o) => o.id === ruleSet.operatorId);
      return `Operator: ${operator?.name || ruleSet.operatorId}`;
    }
    return "Default (All)";
  }

  const operatorBranches = branches.filter(
    (b) => !selectedOperatorId || b.operatorId === selectedOperatorId
  );

  const RuleSetForm = ({ onSubmit, isLoading: isPending, submitLabel }: { onSubmit: () => void; isLoading: boolean; submitLabel: string }) => (
    <div className="space-y-4" data-testid="form-rule-set">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Thailand Statutory Rules 2026-2028"
            data-testid="input-rule-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="countryCode">Country Code</Label>
          <Input
            id="countryCode"
            value={formData.countryCode}
            onChange={(e) => setFormData({ ...formData, countryCode: e.target.value })}
            placeholder="TH"
            data-testid="input-country-code"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input
          id="description"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Optional description"
          data-testid="input-rule-description"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="effectiveFrom">Effective From</Label>
          <DatePicker
            value={formData.effectiveFrom}
            onChange={(date) => setFormData({ ...formData, effectiveFrom: date })}
            data-testid="input-effective-from"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="effectiveTo">Effective To (optional)</Label>
          <DatePicker
            value={formData.effectiveTo}
            onChange={(date) => setFormData({ ...formData, effectiveTo: date })}
            data-testid="input-effective-to"
          />
        </div>
      </div>

      {isAdmin && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="operatorId">Operator Scope (optional)</Label>
            <Select
              value={formData.operatorId}
              onValueChange={(value) => setFormData({ ...formData, operatorId: value === "_none" ? "" : value, branchId: "" })}
            >
              <SelectTrigger data-testid="select-operator-scope">
                <SelectValue placeholder="Default (All operators)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">Default (All operators)</SelectItem>
                {operators.map((op) => (
                  <SelectItem key={op.id} value={op.id}>
                    {op.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="branchId">Branch Scope (optional)</Label>
            <Select
              value={formData.branchId}
              onValueChange={(value) => setFormData({ ...formData, branchId: value === "_none" ? "" : value })}
              disabled={!formData.operatorId}
            >
              <SelectTrigger data-testid="select-branch-scope">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">All branches</SelectItem>
                {operatorBranches
                  .filter((b) => !formData.operatorId || b.operatorId === formData.operatorId)
                  .map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="status">Status</Label>
        <Select
          value={formData.status}
          onValueChange={(value: "active" | "archived") => setFormData({ ...formData, status: value })}
        >
          <SelectTrigger data-testid="select-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold mb-3 flex items-center gap-2">
          <Scale className="h-4 w-4" />
          SSO (Social Security) Rules
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ssoContributionRate">Contribution Rate</Label>
            <Input
              id="ssoContributionRate"
              type="number"
              step="0.01"
              value={formData.ssoContributionRate}
              onChange={(e) => setFormData({ ...formData, ssoContributionRate: e.target.value })}
              placeholder="0.05"
              data-testid="input-sso-rate"
            />
            <p className="text-xs text-muted-foreground">e.g., 0.05 = 5%</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssoCeilingAmount">Ceiling Amount (THB)</Label>
            <Input
              id="ssoCeilingAmount"
              type="number"
              value={formData.ssoCeilingAmount}
              onChange={(e) => setFormData({ ...formData, ssoCeilingAmount: e.target.value })}
              placeholder="17500"
              data-testid="input-sso-ceiling"
            />
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-semibold mb-3 flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          PIT (Personal Income Tax) Rules
        </h4>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="space-y-2">
            <Label htmlFor="pitPersonalExemption">Personal Exemption</Label>
            <Input
              id="pitPersonalExemption"
              type="number"
              value={formData.pitPersonalExemption}
              onChange={(e) => setFormData({ ...formData, pitPersonalExemption: e.target.value })}
              placeholder="60000"
              data-testid="input-pit-personal"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pitSpouseExemption">Spouse Exemption</Label>
            <Input
              id="pitSpouseExemption"
              type="number"
              value={formData.pitSpouseExemption}
              onChange={(e) => setFormData({ ...formData, pitSpouseExemption: e.target.value })}
              placeholder="60000"
              data-testid="input-pit-spouse"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pitChildExemption">Child Exemption</Label>
            <Input
              id="pitChildExemption"
              type="number"
              value={formData.pitChildExemption}
              onChange={(e) => setFormData({ ...formData, pitChildExemption: e.target.value })}
              placeholder="30000"
              data-testid="input-pit-child"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pitBrackets">Tax Brackets (JSON)</Label>
          <Textarea
            id="pitBrackets"
            value={formData.pitBrackets}
            onChange={(e) => setFormData({ ...formData, pitBrackets: e.target.value })}
            rows={8}
            className="font-mono text-sm"
            data-testid="input-pit-brackets"
          />
          <p className="text-xs text-muted-foreground">
            Format: [{"{"} "min": 0, "max": 150000, "rate": 0 {"}"}, ...]. Use null for no upper limit.
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => {
          setIsCreateDialogOpen(false);
          setIsEditDialogOpen(false);
          setFormData(defaultFormData);
        }} data-testid="button-cancel">
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={isPending} data-testid="button-submit">
          {isPending ? "Saving..." : submitLabel}
        </Button>
      </DialogFooter>
    </div>
  );

  if (!isAdmin && !isOperatorAdmin) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You do not have permission to manage statutory rules. Please contact an administrator.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="page-statutory-rules">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Statutory Rules</h1>
          <p className="text-muted-foreground">
            Manage SSO and PIT rules for payroll calculations with operator/branch-level customization
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Select value={selectedOperatorId} onValueChange={setSelectedOperatorId}>
              <SelectTrigger className="w-48" data-testid="select-operator-filter">
                <Building2 className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Select operator" />
              </SelectTrigger>
              <SelectContent>
                {operators.map((op) => (
                  <SelectItem key={op.id} value={op.id}>
                    {op.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          {isAdmin && ruleSets.length === 0 && (
            <Button
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
              data-testid="button-seed-defaults"
            >
              <FileText className="h-4 w-4 mr-2" />
              {seedMutation.isPending ? "Creating..." : "Create Default TH Rules"}
            </Button>
          )}
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-rule">
                <Plus className="h-4 w-4 mr-2" />
                Create Rule Set
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Statutory Rule Set</DialogTitle>
                <DialogDescription>
                  Define SSO and PIT rules that apply to payroll calculations.
                </DialogDescription>
              </DialogHeader>
              <RuleSetForm
                onSubmit={() => createMutation.mutate(formData)}
                isLoading={createMutation.isPending}
                submitLabel="Create Rule Set"
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-64" />
                <Skeleton className="h-4 w-48" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : ruleSets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Scale className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Statutory Rules Found</h3>
            <p className="text-muted-foreground mb-4">
              Create your first rule set or seed default Thailand rules.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {ruleSets.map((ruleSet) => (
            <Card key={ruleSet.id} data-testid={`card-rule-set-${ruleSet.id}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg">{ruleSet.name}</CardTitle>
                    <Badge variant={ruleSet.status === "active" ? "default" : "secondary"}>
                      {ruleSet.status === "active" ? (
                        <CheckCircle className="h-3 w-3 mr-1" />
                      ) : (
                        <Archive className="h-3 w-3 mr-1" />
                      )}
                      {ruleSet.status}
                    </Badge>
                    <Badge variant="outline">{ruleSet.countryCode}</Badge>
                  </div>
                  <CardDescription className="mt-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <Building2 className="h-3 w-3" />
                      {getScopeLabel(ruleSet)}
                      <Calendar className="h-3 w-3 ml-2" />
                      {format(new Date(ruleSet.effectiveFrom), "d MMM yyyy")} -{" "}
                      {ruleSet.effectiveTo ? format(new Date(ruleSet.effectiveTo), "d MMM yyyy") : "Ongoing"}
                    </span>
                  </CardDescription>
                  {ruleSet.description && (
                    <p className="text-sm text-muted-foreground mt-1">{ruleSet.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleEdit(ruleSet)}
                    data-testid={`button-edit-${ruleSet.id}`}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleDelete(ruleSet.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-${ruleSet.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                      <Scale className="h-4 w-4" />
                      SSO Rules
                    </h4>
                    <div className="text-sm space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Contribution Rate:</span>
                        <span>{((ruleSet.rules.sso?.contributionRate || 0) * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Ceiling Amount:</span>
                        <span>฿{(ruleSet.rules.sso?.ceilingAmount || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      PIT Rules
                    </h4>
                    <div className="text-sm space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Personal Exemption:</span>
                        <span>฿{(ruleSet.rules.pit?.personalExemption || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Tax Brackets:</span>
                        <span>{ruleSet.rules.pit?.brackets?.length || 0} tiers</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Statutory Rule Set</DialogTitle>
            <DialogDescription>
              Update SSO and PIT rules for this rule set.
            </DialogDescription>
          </DialogHeader>
          <RuleSetForm
            onSubmit={() => selectedRuleSet && updateMutation.mutate({ id: selectedRuleSet.id, data: formData })}
            isLoading={updateMutation.isPending}
            submitLabel="Save Changes"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
