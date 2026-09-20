import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Employee, Branch, insertEmployeeSchema, EmployeeChange, ContractInstance, employeeStatuses, EmployeeAsset, Department, Role } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { ArrowLeft, Save, Loader2, User, Mail, Phone, MapPin, Building2, Briefcase, MapPinned, Globe, CreditCard, FileText, Trash2, Upload, RefreshCw, Eye, EyeOff, History, DollarSign, Plus, CheckCircle, Clock, AlertTriangle, FileSignature, UserX, ChevronDown, Package, RotateCcw, Fingerprint, QrCode, XCircle, Camera, Shield, Calendar, Download, Percent, X, PieChart, Settings, Lock, Pencil } from "lucide-react";
import { MODULES, MODULE_KEYS, BRANCH_SCOPE_TYPES, type ModuleKey, type BranchScopeType, type EffectivePermissions, type EffectiveModulePermission } from "@shared/permissions";
import { DatePicker } from "@/components/ui/date-picker";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";
import { useAvatarWorkStatus } from "@/hooks/use-avatar-work-status";
import { Link } from "wouter";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmployeeDocument } from "@shared/schema";
import { UpdateTermsModal } from "@/components/update-terms-modal";
import { OffboardingModal } from "@/components/offboarding-modal";
import { IssueWarningModal } from "@/components/issue-warning-modal";
import { EmployeeOnboardingStepper } from "@/components/employee-onboarding-stepper";
import { EmployeeVouchersSection } from "@/components/employee-vouchers-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { differenceInDays } from "date-fns";
import { formatDate, formatCurrency } from "@/lib/format-utils";
import { QRCodeSVG } from "qrcode.react";

// Access Status Section for showing employee's system access
function AccessStatusSection({ employeeId, personId, employee, forceOpen }: { employeeId: string; personId: string | null; employee: Employee; forceOpen?: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin" || user?.role === "global_admin" || user?.role === "operator_admin";
  const isManager = user?.role === "manager" || isAdmin;
  const [isOpen, setIsOpen] = useState(false);
  
  useEffect(() => {
    if (forceOpen) {
      setIsOpen(true);
    }
  }, [forceOpen]);
  
  // Quick login generation state
  const [generateLoginModalOpen, setGenerateLoginModalOpen] = useState(false);
  const [generatedCredentials, setGeneratedCredentials] = useState<{ username: string; tempPassword: string } | null>(null);
  const [generateLoginRole, setGenerateLoginRole] = useState<"staff" | "manager">("staff");
  const [resetPasswordModalOpen, setResetPasswordModalOpen] = useState(false);
  const [newTempPassword, setNewTempPassword] = useState<string | null>(null);
  
  const [enableLoginModalOpen, setEnableLoginModalOpen] = useState(false);

  const [wizardStep, setWizardStep] = useState(1);
  const [tempPassword, setTempPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accessLevel, setAccessLevel] = useState<"STAFF" | "MANAGER" | "ADMIN">("STAFF");
  const [enableCoreModule, setEnableCoreModule] = useState(true);
  const [enableHrModule, setEnableHrModule] = useState(false);
  const [enableStudioModule, setEnableStudioModule] = useState(false);
  const [enableEventsModule, setEnableEventsModule] = useState(false);
  const [enableOpsModule, setEnableOpsModule] = useState(false);
  const [enableSetupModule, setEnableSetupModule] = useState(false);
  const [branchScope, setBranchScope] = useState<"SELECTED" | "ALL">("SELECTED");
  const [loginEmail, setLoginEmail] = useState(employee.email || "");
  
  // State for edit access modal
  const [editAccessModalOpen, setEditAccessModalOpen] = useState(false);
  const [editBranchScope, setEditBranchScope] = useState<"SELECTED" | "ALL">("SELECTED");
  const [editBranchIds, setEditBranchIds] = useState<string[]>([]);
  const [editAccessLevel, setEditAccessLevel] = useState<"STAFF" | "MANAGER" | "ADMIN">("STAFF");
  const [editEnableCoreModule, setEditEnableCoreModule] = useState(false);
  const [editEnableHrModule, setEditEnableHrModule] = useState(false);
  const [editEnableStudioModule, setEditEnableStudioModule] = useState(false);
  const [editEnableEventsModule, setEditEnableEventsModule] = useState(false);
  const [editEnableOpsModule, setEditEnableOpsModule] = useState(false);
  const [editEnableSetupModule, setEditEnableSetupModule] = useState(false);
  
  // Granular permissions state
  const [granularOverridesOpen, setGranularOverridesOpen] = useState(false);
  const [overrideEdits, setOverrideEdits] = useState<Record<ModuleKey, { enabled: boolean; branchScopeType: BranchScopeType; branchIds: string[]; notes: string }>>({} as any);

  // Fetch effective permissions for this employee's user
  const { data: effectivePerms, isLoading: effectivePermsLoading } = useQuery<EffectivePermissions>({
    queryKey: ["/api/permissions/effective", employee.userId],
    enabled: !!employee.userId && isManager,
  });

  // Fetch existing module overrides
  const { data: existingOverrides = [] } = useQuery<Array<{ moduleKey: ModuleKey; enabled: boolean; branchScopeType: BranchScopeType; branchIds: string[]; notes?: string | null }>>({
    queryKey: ["/api/module-overrides", employee.userId],
    enabled: !!employee.userId && isAdmin,
  });

  // Save overrides mutation
  const saveOverridesMutation = useMutation({
    mutationFn: async (overrides: Array<{ moduleKey: ModuleKey; enabled: boolean; branchScopeType: BranchScopeType; branchIds: string[]; notes?: string }>) => {
      const res = await apiRequest("PUT", `/api/module-overrides/${employee.userId}`, { overrides });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Overrides saved", description: "Module permission overrides have been updated." });
      setGranularOverridesOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/permissions/effective", employee.userId] });
      queryClient.invalidateQueries({ queryKey: ["/api/module-overrides", employee.userId] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save overrides", description: error.message, variant: "destructive" });
    },
  });

  const openGranularOverrides = () => {
    const edits: Record<string, { enabled: boolean; branchScopeType: BranchScopeType; branchIds: string[]; notes: string }> = {};
    MODULE_KEYS.forEach((key) => {
      const existing = existingOverrides.find(o => o.moduleKey === key);
      const effectiveMod = effectivePerms?.modules.find(m => m.moduleKey === key);
      edits[key] = {
        enabled: existing ? existing.enabled : (effectiveMod?.allowed ?? false),
        branchScopeType: existing ? existing.branchScopeType : (effectiveMod?.branchScope ?? "HOME_ONLY"),
        branchIds: existing ? existing.branchIds : (effectiveMod?.branchIds ?? []),
        notes: existing?.notes ?? "",
      };
    });
    setOverrideEdits(edits as any);
    setGranularOverridesOpen(true);
  };

  const handleSaveOverrides = () => {
    const overrides = MODULE_KEYS.map((key) => ({
      moduleKey: key,
      enabled: overrideEdits[key]?.enabled ?? false,
      branchScopeType: overrideEdits[key]?.branchScopeType ?? "HOME_ONLY" as BranchScopeType,
      branchIds: overrideEdits[key]?.branchIds ?? [],
      notes: overrideEdits[key]?.notes ?? "",
    }));
    saveOverridesMutation.mutate(overrides);
  };

  const handleClearAllOverrides = () => {
    saveOverridesMutation.mutate([]);
  };

  // Fetch branches for editing
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
    enabled: isManager,
  });
  
  // Fetch access policy if personId exists
  const { data: accessData, isLoading, refetch } = useQuery<{ accessPolicy?: { accessLevel: string; modules: { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean }; branchScope: string; branchIds?: string[] | null } }>({
    queryKey: [`/api/people/${personId}`],
    enabled: !!personId && isManager,
  });
  
  const accessPolicy = accessData?.accessPolicy;
  
  // Initialize edit form when opening modal
  const openEditAccessModal = () => {
    if (accessPolicy) {
      setEditBranchScope(accessPolicy.branchScope as "SELECTED" | "ALL");
      setEditBranchIds(accessPolicy.branchIds || []);
      setEditAccessLevel(accessPolicy.accessLevel as "STAFF" | "MANAGER" | "ADMIN");
      setEditEnableCoreModule(accessPolicy.modules.core);
      setEditEnableHrModule(accessPolicy.modules.hr);
      setEditEnableStudioModule(accessPolicy.modules.studio);
      setEditEnableEventsModule(accessPolicy.modules.events ?? false);
      setEditEnableOpsModule(accessPolicy.modules.ops ?? false);
      setEditEnableSetupModule(accessPolicy.modules.setup ?? false);
    }
    setEditAccessModalOpen(true);
  };
  
  // Edit access mutation
  const editAccessMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/people/${personId}/access`, {
        accessLevel: editAccessLevel,
        modules: {
          core: editEnableCoreModule,
          hr: editEnableHrModule,
          studio: editEnableStudioModule,
          events: editEnableEventsModule,
          ops: editEnableOpsModule,
          setup: editEnableSetupModule,
        },
        branchScope: editBranchScope,
        branchIds: editBranchScope === "SELECTED" ? editBranchIds : [],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Access updated",
        description: "Employee access settings have been saved.",
      });
      setEditAccessModalOpen(false);
      queryClient.invalidateQueries({ queryKey: [`/api/people/${personId}`] });
      refetch();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update access",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Generate random password
  const generatePassword = (forRetry = false) => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
    let password = "";
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (forRetry) {
      setRetryTempPassword(password);
    } else {
      setTempPassword(password);
    }
    return password;
  };
  
  // Enable login mutation
  const enableLoginMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/enable-login`, {
        email: loginEmail,
        password: tempPassword,
        accessLevel,
        enableCoreModule,
        enableHrModule,
        enableStudioModule,
        enableEventsModule,
        enableOpsModule,
        enableSetupModule,
        branchScope,
        branchIds: employee.branchId ? [employee.branchId] : [],
      });
      return res.json();
    },
    onSuccess: () => {
      setWizardStep(3);
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/attention-items"] });
      refetch();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to enable login",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  

  const resetWizard = () => {
    setWizardStep(1);
    setTempPassword("");
    setAccessLevel("STAFF");
    setEnableCoreModule(true);
    setEnableHrModule(false);
    setEnableStudioModule(false);
    setEnableEventsModule(false);
    setEnableOpsModule(false);
    setEnableSetupModule(false);
    setBranchScope("SELECTED");
    setLoginEmail(employee.email || "");
  };
  
  const openEnableLoginModal = () => {
    resetWizard();
    generatePassword();
    setEnableLoginModalOpen(true);
  };
  
  // Quick login generation mutation
  const generateLoginMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/generate-login`, {
        role: generateLoginRole,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setGeneratedCredentials({ username: data.username, tempPassword: data.tempPassword });
      toast({
        title: "Login created",
        description: "Save the credentials - the password will not be shown again.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to generate login",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Reset password mutation
  const resetPasswordMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/reset-password`, {});
      return res.json();
    },
    onSuccess: (data) => {
      setNewTempPassword(data.tempPassword);
      toast({
        title: "Password reset",
        description: "Save the new password - it will not be shown again.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to reset password",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Toggle login mutation
  const toggleLoginMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/toggle-login`, {});
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.isActive ? "Login enabled" : "Login disabled",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to toggle login",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // If not manager or admin, don't show this section at all
  if (!isManager) {
    return null;
  }
  
  // Check if login can be enabled (hasLogin checks legacy personId/accessPolicy, hasSimpleLogin checks new userId)
  const hasLogin = !!(personId && accessPolicy);
  const hasSimpleLogin = !!employee.userId;
  const canEnableLogin = !hasLogin;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <Card data-testid="collapsible-access-login" className="border-l-4 border-l-violet-500 bg-violet-500/5">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover-elevate">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>Access & Login</CardTitle>
                    <CardDescription>System access and module permissions</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!hasLogin ? (
                    <Badge variant="outline" className="text-muted-foreground">No login</Badge>
                  ) : isLoading ? (
                    <Badge variant="secondary">Loading...</Badge>
                  ) : accessPolicy ? (
                    <div className="flex gap-1 flex-wrap">
                      <Badge variant="outline">{accessPolicy.accessLevel}</Badge>
                    </div>
                  ) : null}
                  <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
                </div>
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              {!hasLogin && !hasSimpleLogin ? (
                <div className="space-y-6">
                  <div className="text-center py-4 space-y-4">
                    <p className="text-muted-foreground">This employee does not have a system login configured.</p>
                    <div className="flex justify-center">
                      <Button onClick={openEnableLoginModal} data-testid="button-enable-login">
                        <User className="h-4 w-4 mr-2" />
                        Create Login
                      </Button>
                    </div>
                  </div>
                </div>
              ) : hasSimpleLogin && !hasLogin ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <span className="font-medium">Login account linked</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => setResetPasswordModalOpen(true)}
                      disabled={resetPasswordMutation.isPending}
                      data-testid="button-reset-password"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Reset Password
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => toggleLoginMutation.mutate()}
                      disabled={toggleLoginMutation.isPending}
                      data-testid="button-toggle-login"
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Disable Login
                    </Button>
                  </div>
                </div>
              ) : isLoading ? (
                <div className="text-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </div>
              ) : accessPolicy ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Access Level</p>
                    <Badge variant="outline">{accessPolicy.accessLevel}</Badge>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Branch Access</p>
                    {accessPolicy.branchScope === "ALL" ? (
                      <p className="font-medium">All Branches</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {accessPolicy.branchIds && accessPolicy.branchIds.length > 0 ? (
                          accessPolicy.branchIds.map((branchId) => {
                            const branch = branches.find(b => b.id === branchId);
                            return (
                              <Badge key={branchId} variant="outline">
                                {branch?.name || branchId}
                              </Badge>
                            );
                          })
                        ) : (
                          <span className="text-sm text-muted-foreground">No branches selected</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <p className="text-sm text-muted-foreground">Module Access</p>
                    <div className="flex flex-wrap gap-2">
                      {accessPolicy.modules.hr && <Badge variant="secondary">HR</Badge>}
                      {accessPolicy.modules.core && <Badge variant="secondary">Today</Badge>}
                      {accessPolicy.modules.studio && <Badge variant="secondary">Studio</Badge>}
                      {accessPolicy.modules.events && <Badge variant="secondary">Events</Badge>}
                      {accessPolicy.modules.ops && <Badge variant="secondary">Ops</Badge>}
                      {accessPolicy.modules.setup && <Badge variant="secondary">Setup</Badge>}
                      {!accessPolicy.modules.hr && !accessPolicy.modules.core && !accessPolicy.modules.studio && !accessPolicy.modules.events && !accessPolicy.modules.ops && !accessPolicy.modules.setup && (
                        <span className="text-muted-foreground text-sm">No modules enabled</span>
                      )}
                    </div>
                  </div>
                  {employee.userId && (
                    <div className="space-y-2 md:col-span-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm text-muted-foreground">Granular Permissions</p>
                        {isAdmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={openGranularOverrides}
                            data-testid="button-edit-overrides"
                          >
                            <Settings className="h-4 w-4 mr-2" />
                            Edit Overrides
                          </Button>
                        )}
                      </div>
                      {effectivePermsLoading ? (
                        <div className="flex items-center gap-2 py-2">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">Loading permissions...</span>
                        </div>
                      ) : effectivePerms ? (
                        <div className="space-y-1">
                          {effectivePerms.modules.map((mod) => (
                            <div key={mod.moduleKey} className="flex items-center justify-between gap-2 py-1 border-b last:border-b-0" data-testid={`perm-row-${mod.moduleKey}`}>
                              <div className="flex items-center gap-2">
                                {mod.allowed ? (
                                  <CheckCircle className="h-4 w-4 text-green-600" />
                                ) : (
                                  <XCircle className="h-4 w-4 text-red-500" />
                                )}
                                <span className="text-sm">{mod.label}</span>
                                {MODULES[mod.moduleKey]?.adminOnly && (
                                  <span className="text-xs text-muted-foreground">(Admin only)</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-wrap">
                                <Badge variant={mod.allowed ? "default" : "outline"} className="text-xs">
                                  {mod.allowed ? "Allowed" : "Denied"}
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  {mod.source === "role_default" ? "Role" : mod.source === "override" ? "Override" : "Admin"}
                                </Badge>
                                {MODULES[mod.moduleKey]?.isBranchScoped && (
                                  <Badge variant="outline" className="text-xs">
                                    {mod.branchScope === "ALL" ? "All branches" : mod.branchScope === "HOME_ONLY" ? "Home only" : `${mod.branchIds.length} branch${mod.branchIds.length !== 1 ? "es" : ""}`}
                                  </Badge>
                                )}
                                {mod.hasOverride && (
                                  <Badge variant="secondary" className="text-xs gap-1">
                                    <Lock className="h-3 w-3" />
                                    Override
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">Unable to load permissions</p>
                      )}
                    </div>
                  )}

                  {isAdmin && (
                    <div className="md:col-span-2 pt-2">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={openEditAccessModal}
                        data-testid="button-edit-access"
                      >
                        Edit Access Settings
                      </Button>
                    </div>
                  )}
                  {(hasSimpleLogin || hasLogin) && (
                    <div className="md:col-span-2 pt-2 border-t">
                      <p className="text-sm text-muted-foreground mb-2 pt-2">Login Actions</p>
                      <div className="flex flex-wrap gap-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => setResetPasswordModalOpen(true)}
                          disabled={resetPasswordMutation.isPending}
                          data-testid="button-reset-password-policy"
                        >
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Reset Password
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => toggleLoginMutation.mutate()}
                          disabled={toggleLoginMutation.isPending}
                          data-testid="button-toggle-login-policy"
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          Disable Login
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-4">
                  <p className="text-muted-foreground">No access policy configured for this employee.</p>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      
      {/* Enable Login Modal */}
      <Dialog open={enableLoginModalOpen} onOpenChange={(open) => {
        if (!open) resetWizard();
        setEnableLoginModalOpen(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Enable Login Access</DialogTitle>
            <DialogDescription>
              {wizardStep === 1 && "Configure access level and permissions"}
              {wizardStep === 2 && "Set temporary password"}
              {wizardStep === 3 && "Login access created"}
            </DialogDescription>
          </DialogHeader>
          
          {wizardStep === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Login Email</Label>
                <Input 
                  value={loginEmail} 
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="employee@company.com"
                  data-testid="input-login-email"
                />
              </div>
              
              <div className="space-y-2">
                <Label>Access Level</Label>
                <Select value={accessLevel} onValueChange={(v) => {
                  setAccessLevel(v as "STAFF" | "MANAGER" | "ADMIN");
                  if (v === "MANAGER" || v === "ADMIN") {
                    setEnableHrModule(true);
                  }
                  if (v === "ADMIN") {
                    setBranchScope("ALL");
                  }
                }}>
                  <SelectTrigger data-testid="select-access-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STAFF">Staff</SelectItem>
                    <SelectItem value="MANAGER">Manager</SelectItem>
                    {isAdmin && <SelectItem value="ADMIN">Admin</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label>Module Access</Label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={enableCoreModule} 
                      onCheckedChange={(c) => setEnableCoreModule(!!c)}
                      id="enable-core"
                    />
                    <label htmlFor="enable-core" className="text-sm">Today (Tasks & Checklists)</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={enableOpsModule} 
                      onCheckedChange={(c) => setEnableOpsModule(!!c)}
                      id="enable-ops"
                    />
                    <label htmlFor="enable-ops" className="text-sm">Ops (Unified Workspace)</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={enableEventsModule} 
                      onCheckedChange={(c) => setEnableEventsModule(!!c)}
                      id="enable-events"
                    />
                    <label htmlFor="enable-events" className="text-sm">Events</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={enableHrModule} 
                      onCheckedChange={(c) => setEnableHrModule(!!c)}
                      id="enable-hr"
                    />
                    <label htmlFor="enable-hr" className="text-sm">HR (Contracts, Employees)</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={enableSetupModule} 
                      onCheckedChange={(c) => setEnableSetupModule(!!c)}
                      id="enable-setup"
                    />
                    <label htmlFor="enable-setup" className="text-sm">Setup (Configuration)</label>
                  </div>
                </div>
              </div>
              
              {isAdmin && accessLevel !== "STAFF" && (
                <div className="space-y-2">
                  <Label>Branch Scope</Label>
                  <Select value={branchScope} onValueChange={(v) => setBranchScope(v as "SELECTED" | "ALL")}>
                    <SelectTrigger data-testid="select-branch-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SELECTED">Selected Branches</SelectItem>
                      <SelectItem value="ALL">All Branches</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEnableLoginModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setWizardStep(2)} disabled={!loginEmail}>
                  Next
                </Button>
              </div>
            </div>
          )}
          
          {wizardStep === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Temporary Password</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input 
                      type={showPassword ? "text" : "password"}
                      value={tempPassword} 
                      onChange={(e) => setTempPassword(e.target.value)}
                      data-testid="input-temp-password"
                    />
                  </div>
                  <Button variant="outline" size="icon" onClick={() => setShowPassword(!showPassword)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" onClick={() => generatePassword()}>
                    Generate
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  User must change password on first login.
                </p>
              </div>
              
              <div className="flex justify-between gap-2">
                <Button variant="outline" onClick={() => setWizardStep(1)}>
                  Back
                </Button>
                <Button 
                  onClick={() => enableLoginMutation.mutate()} 
                  disabled={!tempPassword || tempPassword.length < 6 || enableLoginMutation.isPending}
                  data-testid="button-create-login"
                >
                  {enableLoginMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Login
                </Button>
              </div>
            </div>
          )}
          
          {wizardStep === 3 && (
            <div className="space-y-4">
              <div className="bg-muted p-4 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">Login access created</span>
                </div>
                <div className="space-y-1 text-sm">
                  <p><span className="text-muted-foreground">Email:</span> {loginEmail}</p>
                  <p><span className="text-muted-foreground">Temp Password:</span> <code className="bg-background px-1 py-0.5 rounded">{tempPassword}</code></p>
                  <p><span className="text-muted-foreground">Access Level:</span> {accessLevel}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                <p className="text-sm">User must change password on first login.</p>
              </div>
              
              <Button className="w-full" onClick={() => {
                navigator.clipboard.writeText(tempPassword);
                toast({ title: "Password copied", description: "Temporary password copied to clipboard." });
              }}>
                Copy Password
              </Button>
              
              <Button variant="outline" className="w-full" onClick={() => setEnableLoginModalOpen(false)}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      

      
      {/* Granular Permissions Override Dialog */}
      <Dialog open={granularOverridesOpen} onOpenChange={setGranularOverridesOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Module Overrides</DialogTitle>
            <DialogDescription>
              Configure per-module permission overrides for this employee. These override role defaults.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {MODULE_KEYS.map((key) => {
              const moduleDef = MODULES[key];
              const edit = overrideEdits[key];
              if (!edit) return null;
              return (
                <div key={key} className="space-y-2 border-b pb-3 last:border-b-0" data-testid={`override-module-${key}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{moduleDef.label}</span>
                      {moduleDef.adminOnly && (
                        <span className="text-xs text-muted-foreground">(Admin only)</span>
                      )}
                    </div>
                    <Switch
                      checked={edit.enabled}
                      onCheckedChange={(checked) => {
                        setOverrideEdits(prev => ({
                          ...prev,
                          [key]: { ...prev[key], enabled: checked },
                        }));
                      }}
                      data-testid={`switch-override-${key}`}
                    />
                  </div>
                  {edit.enabled && moduleDef.isBranchScoped && (
                    <div className="space-y-2 pl-4">
                      <Label className="text-xs text-muted-foreground">Branch Scope</Label>
                      <Select
                        value={edit.branchScopeType}
                        onValueChange={(val) => {
                          setOverrideEdits(prev => ({
                            ...prev,
                            [key]: { ...prev[key], branchScopeType: val as BranchScopeType, branchIds: val === "CUSTOM" ? prev[key].branchIds : [] },
                          }));
                        }}
                      >
                        <SelectTrigger data-testid={`select-scope-${key}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BRANCH_SCOPE_TYPES.map((scope) => (
                            <SelectItem key={scope} value={scope}>{scope === "HOME_ONLY" ? "Home Only" : scope === "ALL" ? "All Branches" : "Custom"}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {edit.branchScopeType === "CUSTOM" && (
                        <div className="space-y-1 pl-2">
                          <Label className="text-xs text-muted-foreground">Select Branches</Label>
                          {branches.map((branch) => (
                            <div key={branch.id} className="flex items-center gap-2">
                              <Checkbox
                                checked={edit.branchIds.includes(branch.id)}
                                onCheckedChange={(checked) => {
                                  setOverrideEdits(prev => {
                                    const current = prev[key].branchIds;
                                    const updated = checked
                                      ? [...current, branch.id]
                                      : current.filter(id => id !== branch.id);
                                    return { ...prev, [key]: { ...prev[key], branchIds: updated } };
                                  });
                                }}
                                data-testid={`checkbox-branch-${key}-${branch.id}`}
                              />
                              <Label className="text-sm">{branch.name}</Label>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between gap-2 pt-2 flex-wrap">
            <Button
              variant="outline"
              onClick={handleClearAllOverrides}
              disabled={saveOverridesMutation.isPending}
              data-testid="button-clear-overrides"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Clear All Overrides
            </Button>
            <Button
              onClick={handleSaveOverrides}
              disabled={saveOverridesMutation.isPending}
              data-testid="button-save-overrides"
            >
              {saveOverridesMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Overrides
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Access Modal */}
      <Dialog open={editAccessModalOpen} onOpenChange={setEditAccessModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Access Settings</DialogTitle>
            <DialogDescription>
              Update access level, modules, and branch permissions.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Access Level</Label>
              <Select 
                value={editAccessLevel} 
                onValueChange={(v) => {
                  setEditAccessLevel(v as "STAFF" | "MANAGER" | "ADMIN");
                  if (v === "MANAGER" || v === "ADMIN") {
                    setEditEnableHrModule(true);
                  }
                  if (v === "ADMIN") {
                    setEditBranchScope("ALL");
                  }
                }}
              >
                <SelectTrigger data-testid="select-edit-access-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">Staff</SelectItem>
                  <SelectItem value="MANAGER">Manager</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label>Module Access</Label>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableCoreModule}
                    onCheckedChange={(checked) => setEditEnableCoreModule(!!checked)}
                    id="edit-core-module"
                    data-testid="checkbox-edit-core-module"
                  />
                  <label htmlFor="edit-core-module" className="text-sm">Today (Tasks & Checklists)</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableHrModule}
                    onCheckedChange={(checked) => setEditEnableHrModule(!!checked)}
                    disabled={editAccessLevel === "MANAGER" || editAccessLevel === "ADMIN"}
                    id="edit-hr-module"
                    data-testid="checkbox-edit-hr-module"
                  />
                  <label htmlFor="edit-hr-module" className="text-sm">
                    HR {(editAccessLevel === "MANAGER" || editAccessLevel === "ADMIN") && <span className="text-xs text-muted-foreground">(required for {editAccessLevel.toLowerCase()}s)</span>}
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableStudioModule}
                    onCheckedChange={(checked) => setEditEnableStudioModule(!!checked)}
                    id="edit-studio-module"
                    data-testid="checkbox-edit-studio-module"
                  />
                  <label htmlFor="edit-studio-module" className="text-sm">Studio (Legacy - grants Ops/Events/Setup)</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableEventsModule}
                    onCheckedChange={(checked) => setEditEnableEventsModule(!!checked)}
                    id="edit-events-module"
                    data-testid="checkbox-edit-events-module"
                  />
                  <label htmlFor="edit-events-module" className="text-sm">Events</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableOpsModule}
                    onCheckedChange={(checked) => setEditEnableOpsModule(!!checked)}
                    id="edit-ops-module"
                    data-testid="checkbox-edit-ops-module"
                  />
                  <label htmlFor="edit-ops-module" className="text-sm">Ops (Unified Workspace)</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox 
                    checked={editEnableSetupModule}
                    onCheckedChange={(checked) => setEditEnableSetupModule(!!checked)}
                    id="edit-setup-module"
                    data-testid="checkbox-edit-setup-module"
                  />
                  <label htmlFor="edit-setup-module" className="text-sm">Setup (Configuration)</label>
                </div>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Branch Access</Label>
              <Select 
                value={editBranchScope} 
                onValueChange={(v) => setEditBranchScope(v as "ALL" | "SELECTED")}
                disabled={editAccessLevel === "ADMIN"}
              >
                <SelectTrigger data-testid="select-edit-branch-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Branches</SelectItem>
                  <SelectItem value="SELECTED">Selected Branches</SelectItem>
                </SelectContent>
              </Select>
              {editAccessLevel === "ADMIN" && (
                <p className="text-xs text-muted-foreground">Admins automatically have access to all branches</p>
              )}
            </div>
            
            {editBranchScope === "SELECTED" && (
              <div className="space-y-2">
                <Label>Select Branches</Label>
                <div className="max-h-48 overflow-y-auto space-y-2 border rounded-md p-3">
                  {branches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No branches available</p>
                  ) : (
                    branches.map((branch) => (
                      <div key={branch.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={editBranchIds.includes(branch.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setEditBranchIds([...editBranchIds, branch.id]);
                            } else {
                              setEditBranchIds(editBranchIds.filter(id => id !== branch.id));
                            }
                          }}
                          id={`edit-branch-${branch.id}`}
                          data-testid={`checkbox-edit-branch-${branch.id}`}
                        />
                        <label htmlFor={`edit-branch-${branch.id}`} className="text-sm">{branch.name}</label>
                      </div>
                    ))
                  )}
                </div>
                {editBranchIds.length === 0 && (
                  <p className="text-xs text-amber-600">At least one branch should be selected</p>
                )}
              </div>
            )}
            
            <div className="flex justify-end gap-2 pt-2">
              <Button 
                variant="outline" 
                onClick={() => setEditAccessModalOpen(false)}
                data-testid="button-cancel-edit-access"
              >
                Cancel
              </Button>
              <Button 
                onClick={() => editAccessMutation.mutate()} 
                disabled={editAccessMutation.isPending || (editBranchScope === "SELECTED" && editBranchIds.length === 0)}
                data-testid="button-save-edit-access"
              >
                {editAccessMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Generate Login Modal */}
      <Dialog open={generateLoginModalOpen} onOpenChange={(open) => {
        if (!open) {
          setGeneratedCredentials(null);
          setGenerateLoginRole("staff");
        }
        setGenerateLoginModalOpen(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Login</DialogTitle>
            <DialogDescription>
              {generatedCredentials 
                ? "Login credentials generated. Save these - the password will not be shown again."
                : "Create a login account for this employee with auto-generated credentials."
              }
            </DialogDescription>
          </DialogHeader>
          
          {!generatedCredentials ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={generateLoginRole} onValueChange={(v) => setGenerateLoginRole(v as "staff" | "manager")}>
                  <SelectTrigger data-testid="select-generate-login-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="staff">Staff</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Staff can view schedules and timekeeping. Managers can edit schedules and manage employees.
                </p>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setGenerateLoginModalOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={() => generateLoginMutation.mutate()} 
                  disabled={generateLoginMutation.isPending}
                  data-testid="button-confirm-generate-login"
                >
                  {generateLoginMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Generate Login
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-muted rounded-lg p-4 space-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">Username</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono font-medium">{generatedCredentials.username}</p>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(generatedCredentials.username);
                        toast({ title: "Copied", description: "Username copied to clipboard." });
                      }}
                    >
                      <User className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground">Temporary Password</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono font-medium">{generatedCredentials.tempPassword}</p>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(generatedCredentials.tempPassword);
                        toast({ title: "Copied", description: "Password copied to clipboard." });
                      }}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/20 p-3 rounded-md">
                <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                <p className="text-sm">Save these credentials now. The password will not be shown again.</p>
              </div>
              
              <Button className="w-full" onClick={() => setGenerateLoginModalOpen(false)}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      
      {/* Reset Password Modal */}
      <Dialog open={resetPasswordModalOpen} onOpenChange={(open) => {
        if (!open) {
          setNewTempPassword(null);
        }
        setResetPasswordModalOpen(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              {newTempPassword 
                ? "New password generated. Save this - it will not be shown again."
                : "Generate a new temporary password for this employee's account."
              }
            </DialogDescription>
          </DialogHeader>
          
          {!newTempPassword ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This will generate a new temporary password. The employee will need to change it on their next login.
              </p>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setResetPasswordModalOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={() => resetPasswordMutation.mutate()} 
                  disabled={resetPasswordMutation.isPending}
                  data-testid="button-confirm-reset-password"
                >
                  {resetPasswordMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Reset Password
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-muted rounded-lg p-4">
                <p className="text-sm text-muted-foreground">New Temporary Password</p>
                <div className="flex items-center gap-2">
                  <p className="font-mono font-medium">{newTempPassword}</p>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(newTempPassword);
                      toast({ title: "Copied", description: "Password copied to clipboard." });
                    }}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              
              <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/20 p-3 rounded-md">
                <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                <p className="text-sm">Save this password now. It will not be shown again.</p>
              </div>
              
              <Button className="w-full" onClick={() => setResetPasswordModalOpen(false)}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProbationStatusSection({ employee }: { employee: Employee }) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);

  const completeProbationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/complete-probation-review`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/attention-items"] });
      toast({
        title: "Review completed",
        description: "Probation review has been marked as completed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to complete probation review.",
        variant: "destructive",
      });
    },
  });

  const startDate = (employee.defaultMergeData as any)?.startDate;
  const probationEndDate = employee.probationEndDate;
  const probationDays = employee.probationDays;
  const reviewCompleted = employee.probationReviewCompletedAt;

  if (!startDate && !probationEndDate) {
    return null;
  }

  const today = new Date();
  const daysUntilEnd = probationEndDate
    ? differenceInDays(new Date(probationEndDate), today)
    : null;

  const getStatusBadge = () => {
    if (reviewCompleted) {
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle className="h-3 w-3" />
          Completed
        </Badge>
      );
    }
    if (daysUntilEnd === null) {
      return <Badge variant="secondary">Pending calculation</Badge>;
    }
    if (daysUntilEnd < 0) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="h-3 w-3" />
          Overdue by {Math.abs(daysUntilEnd)} days
        </Badge>
      );
    }
    if (daysUntilEnd <= 7) {
      return (
        <Badge variant="outline" className="border-red-500 text-red-600 dark:text-red-400 gap-1">
          <Clock className="h-3 w-3" />
          {daysUntilEnd} days left
        </Badge>
      );
    }
    if (daysUntilEnd <= 14) {
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 gap-1">
          <Clock className="h-3 w-3" />
          {daysUntilEnd} days left
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" />
        {daysUntilEnd} days left
      </Badge>
    );
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-l-4 border-l-cyan-500 bg-cyan-500/5">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle>Probation Status</CardTitle>
                  <CardDescription>Probation period and review status</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {getStatusBadge()}
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Start Date</p>
                <p className="font-medium" data-testid="text-start-date">
                  {startDate ? formatDate(startDate) : "Not set"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Probation Period</p>
                <p className="font-medium" data-testid="text-probation-days">
                  {probationDays ? `${probationDays} days` : "Company default"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Probation End Date</p>
                <p className="font-medium" data-testid="text-probation-end">
                  {probationEndDate ? formatDate(probationEndDate) : "Not calculated"}
                </p>
              </div>
              <div className="space-y-1 md:col-span-2">
                <p className="text-sm text-muted-foreground">Review Status</p>
                <div className="flex items-center gap-2" data-testid="status-probation-review">
                  {getStatusBadge()}
                  {reviewCompleted && (
                    <span className="text-sm text-muted-foreground">
                      on {formatDate(reviewCompleted)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {!reviewCompleted && probationEndDate && (
              <div className="flex justify-end pt-4 border-t">
                <Button
                  onClick={() => completeProbationMutation.mutate()}
                  disabled={completeProbationMutation.isPending}
                  data-testid="button-complete-probation"
                >
                  {completeProbationMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="mr-2 h-4 w-4" />
                  )}
                  Mark Review Completed
                </Button>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// Days Off Section for showing comprehensive employee leave balances
interface AllLeaveBalances {
  employeeId: string;
  year: number;
  monthsWorkedThisYear: number;
  totalMonthsEmployed: number;
  annual: {
    total: number;
    earned: number;
    used: number;
    balance: number;
    canClaim: boolean;
    waitingMonths: number;
  };
  business: {
    total: number;
    earned: number;
    used: number;
    balance: number;
  };
  sick: {
    used: number;
    paidDaysRemaining: number;
    maxPaidDays: number;
  };
  publicHolidays: {
    total: number;
    remaining: number;
  };
}

function DaysOffSection({ employee }: { employee: Employee }) {
  const [isOpen, setIsOpen] = useState(false);

  const { data: balances, isLoading } = useQuery<AllLeaveBalances>({
    queryKey: [`/api/employees/${employee.id}/all-leave-balances`],
    enabled: !!employee.id,
  });

  const getTotalBalance = () => {
    if (!balances) return 0;
    return balances.annual.balance + balances.business.balance;
  };

  const getBalanceBadge = () => {
    if (isLoading) {
      return <Badge variant="secondary">Loading...</Badge>;
    }
    if (!balances) {
      return <Badge variant="secondary">N/A</Badge>;
    }
    const total = getTotalBalance();
    if (total <= 0) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="h-3 w-3" />
          {total} days
        </Badge>
      );
    }
    if (total <= 2) {
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 gap-1">
          {total} days left
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="gap-1">
        {total} days left
      </Badge>
    );
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-l-4 border-l-teal-500 bg-teal-500/5">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle>Leave Balance</CardTitle>
                  <CardDescription>All leave types for {balances?.year || new Date().getFullYear()}</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {getBalanceBadge()}
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : balances ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 rounded-md border bg-green-50 dark:bg-green-950/30">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <h4 className="font-medium text-green-800 dark:text-green-200">Annual Leave</h4>
                      <Badge variant="secondary" className="text-xs">
                        {balances.annual.total} days/year
                      </Badge>
                    </div>
                    {!balances.annual.canClaim ? (
                      <div className="text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 inline mr-1" />
                        Available after {balances.annual.waitingMonths} months ({Math.max(0, balances.annual.waitingMonths - balances.totalMonthsEmployed)} months remaining)
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-xs text-muted-foreground">Earned</p>
                          <p className="font-semibold text-green-700 dark:text-green-300" data-testid="text-annual-earned">{balances.annual.earned}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Used</p>
                          <p className="font-semibold text-amber-600 dark:text-amber-400" data-testid="text-annual-used">{balances.annual.used}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Balance</p>
                          <p className={`font-semibold ${balances.annual.balance <= 0 ? "text-red-600 dark:text-red-400" : ""}`} data-testid="text-annual-balance">{balances.annual.balance}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="p-4 rounded-md border bg-blue-50 dark:bg-blue-950/30">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <h4 className="font-medium text-blue-800 dark:text-blue-200">Business Days</h4>
                      <Badge variant="secondary" className="text-xs">
                        {balances.business.total} days/year
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Earned</p>
                        <p className="font-semibold text-blue-700 dark:text-blue-300" data-testid="text-business-earned">{balances.business.earned}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Used</p>
                        <p className="font-semibold text-amber-600 dark:text-amber-400" data-testid="text-business-used">{balances.business.used}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Balance</p>
                        <p className={`font-semibold ${balances.business.balance <= 0 ? "text-red-600 dark:text-red-400" : ""}`} data-testid="text-business-balance">{balances.business.balance}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-md border bg-red-50 dark:bg-red-950/30">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <h4 className="font-medium text-red-800 dark:text-red-200">Sick Leave</h4>
                      <Badge variant="secondary" className="text-xs">
                        {balances.sick.maxPaidDays} paid days/year
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Used</p>
                        <p className="font-semibold text-red-700 dark:text-red-300" data-testid="text-sick-used">{balances.sick.used}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Paid Remaining</p>
                        <p className={`font-semibold ${balances.sick.paidDaysRemaining <= 0 ? "text-red-600 dark:text-red-400" : ""}`} data-testid="text-sick-remaining">{balances.sick.paidDaysRemaining}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-md border bg-purple-50 dark:bg-purple-950/30">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <h4 className="font-medium text-purple-800 dark:text-purple-200">Public Holidays</h4>
                      <Badge variant="secondary" className="text-xs">
                        {balances.publicHolidays.total} total
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Total</p>
                        <p className="font-semibold text-purple-700 dark:text-purple-300" data-testid="text-ph-total">{balances.publicHolidays.total}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Remaining</p>
                        <p className="font-semibold" data-testid="text-ph-remaining">{balances.publicHolidays.remaining}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground pt-2 border-t">
                  <p>Employed for {balances.totalMonthsEmployed} month{balances.totalMonthsEmployed !== 1 ? 's' : ''} ({balances.monthsWorkedThisYear} month{balances.monthsWorkedThisYear !== 1 ? 's' : ''} this year). Leave earned pro-rata based on months worked.</p>
                </div>
              </>
            ) : (
              <div className="text-center py-6">
                <Calendar className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                <p className="text-muted-foreground">Unable to load leave balances</p>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// Collapsible section wrapper for the employee editor
function CollapsibleSection({ 
  title, 
  description, 
  icon: Icon, 
  defaultOpen = false,
  forceOpen,
  sectionId,
  children,
  showFormActions = false,
  canEdit = true,
  isPending = false,
  isNew = false,
  onCancel,
  colorClass = "",
}: { 
  title: string; 
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  sectionId?: string;
  children: React.ReactNode;
  showFormActions?: boolean;
  canEdit?: boolean;
  isPending?: boolean;
  isNew?: boolean;
  onCancel?: () => void;
  colorClass?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  useEffect(() => {
    if (forceOpen) {
      setIsOpen(true);
    }
  }, [forceOpen]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card data-section-id={sectionId} className={colorClass}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
                <div>
                  <CardTitle>{title}</CardTitle>
                  {description && <CardDescription>{description}</CardDescription>}
                </div>
              </div>
              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            {children}
            {showFormActions && isOpen && (
              <div className="flex items-center justify-end gap-4 pt-4 border-t">
                {onCancel ? (
                  <Button variant="outline" type="button" onClick={onCancel} data-testid="button-section-cancel">
                    Cancel
                  </Button>
                ) : (
                  <Link href="/employees">
                    <Button variant="outline" type="button" data-testid="button-section-cancel">
                      Cancel
                    </Button>
                  </Link>
                )}
                {canEdit && (
                  <Button type="submit" disabled={isPending} data-testid="button-section-save">
                    {isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        {isNew ? "Add Employee" : "Save Changes"}
                      </>
                    )}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function TimekeepingSection({ employeeId, canEdit, forceOpen }: { employeeId: string; canEdit: boolean; forceOpen?: boolean }) {
  const { toast } = useToast();
  const [pinValue, setPinValue] = useState("");
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<{
    faceEnrollmentStatus: string;
    faceEnrolledAt: string | null;
    hasPinSet: boolean;
    pinSetAt: string | null;
    pinUsageCount30d: number;
    lastClockEvent: { eventType: string; eventTime: string; authMethod: string } | null;
  }>({
    queryKey: ["/api/employees", employeeId, "timekeeping-status"],
  });

  const { data: timeEvents } = useQuery<{
    events: Array<{
      id: string;
      eventType: string;
      eventTime: string;
      authMethod: string;
    }>;
    total: number;
  }>({
    queryKey: ["/api/employees", employeeId, "time-events"],
  });

  const { data: faceEnrollmentLogs } = useQuery<{
    logs: Array<{
      id: string;
      createdAt: string;
      metadataJson: string | null;
    }>;
  }>({
    queryKey: ["/api/activity-logs", employeeId, "face_enrolled"],
    queryFn: async () => {
      const res = await fetch(
        `/api/activity-logs?employeeId=${encodeURIComponent(employeeId)}&types=face_enrolled`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch enrollment logs");
      return res.json();
    },
  });

  const setPinMutation = useMutation({
    mutationFn: async (pin: string) => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/pin`, { pin });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId, "timekeeping-status"] });
      toast({ title: "PIN set", description: "Timeclock PIN has been set successfully." });
      setPinValue("");
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to set PIN.", variant: "destructive" });
    },
  });

  const resetPinMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/employees/${employeeId}/pin`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId, "timekeeping-status"] });
      toast({ title: "PIN reset", description: "Timeclock PIN has been cleared." });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to reset PIN.", variant: "destructive" });
    },
  });

  const generateEnrollmentMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/enrollment-session`);
      return res.json();
    },
    onSuccess: (data) => {
      setEnrollmentToken(data.token);
      setQrDialogOpen(true);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to generate enrollment QR.", variant: "destructive" });
    },
  });

  const resetFaceEnrollmentMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/reset-face-enrollment`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Face enrollment has been reset. You can now re-enroll." });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId, "timekeeping-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId, "onboarding-status"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to reset face enrollment.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5" />
            Enroll Face
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <CollapsibleSection
        title="Enroll Face"
        description="Face enrollment, PIN settings, and clock events"
        icon={Fingerprint}
        defaultOpen={false}
        forceOpen={forceOpen}
        colorClass="border-l-4 border-l-pink-500 bg-pink-500/5"
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Face Enrollment</h4>
              <div className="flex items-center gap-3">
                <Badge 
                  variant={status?.faceEnrollmentStatus === "ENROLLED" ? "default" : "secondary"}
                  data-testid="badge-face-status"
                >
                  {status?.faceEnrollmentStatus === "ENROLLED" ? (
                    <><CheckCircle className="mr-1 h-3 w-3" /> Enrolled</>
                  ) : status?.faceEnrollmentStatus === "PENDING" ? (
                    <><Clock className="mr-1 h-3 w-3" /> Pending</>
                  ) : (
                    <><XCircle className="mr-1 h-3 w-3" /> Not enrolled</>
                  )}
                </Badge>
                {status?.faceEnrolledAt && (
                  <span className="text-xs text-muted-foreground">
                    Enrolled {formatDate(status.faceEnrolledAt)}
                  </span>
                )}
              </div>
              {canEdit && status?.faceEnrollmentStatus !== "ENROLLED" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => generateEnrollmentMutation.mutate()}
                  disabled={generateEnrollmentMutation.isPending}
                  data-testid="button-generate-enrollment-qr"
                >
                  <QrCode className="mr-2 h-4 w-4" />
                  {generateEnrollmentMutation.isPending ? "Generating..." : "Generate Enrollment QR"}
                </Button>
              )}
              {canEdit && status?.faceEnrollmentStatus === "ENROLLED" && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => resetFaceEnrollmentMutation.mutate()}
                    disabled={resetFaceEnrollmentMutation.isPending}
                    data-testid="button-reset-face-enrollment"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {resetFaceEnrollmentMutation.isPending ? "Resetting..." : "Reset Face"}
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-medium">Timeclock PIN</h4>
              <div className="flex items-center gap-3">
                <Badge 
                  variant={status?.hasPinSet ? "default" : "secondary"}
                  data-testid="badge-pin-status"
                >
                  {status?.hasPinSet ? (
                    <><CheckCircle className="mr-1 h-3 w-3" /> PIN set</>
                  ) : (
                    <><XCircle className="mr-1 h-3 w-3" /> No PIN</>
                  )}
                </Badge>
                {status?.pinUsageCount30d && status.pinUsageCount30d > 10 && (
                  <Badge variant="outline" className="text-amber-600 border-amber-500/50">
                    {status.pinUsageCount30d} PIN uses (30d)
                  </Badge>
                )}
              </div>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="4-8 digit PIN"
                    value={pinValue}
                    onChange={(e) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    className="w-32"
                    data-testid="input-new-pin"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPinMutation.mutate(pinValue)}
                    disabled={pinValue.length < 4 || setPinMutation.isPending}
                    data-testid="button-set-pin"
                  >
                    Set PIN
                  </Button>
                  {status?.hasPinSet && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => resetPinMutation.mutate()}
                      disabled={resetPinMutation.isPending}
                      data-testid="button-reset-pin"
                    >
                      Reset
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {status?.lastClockEvent && (
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium mb-2">Last Clock Event</h4>
              <div className="flex items-center gap-3">
                <Badge variant={status.lastClockEvent.eventType === "IN" ? "default" : "secondary"}>
                  {status.lastClockEvent.eventType}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {formatDate(status.lastClockEvent.eventTime)} at{" "}
                  {new Date(status.lastClockEvent.eventTime).toLocaleTimeString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  via {status.lastClockEvent.authMethod}
                </span>
              </div>
            </div>
          )}

          {timeEvents && timeEvents.events.length > 0 && (
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium mb-3">Recent Time Events ({timeEvents.total} total)</h4>
              <div className="space-y-2">
                {timeEvents.events.slice(0, 5).map(event => (
                  <div key={event.id} className="flex items-center gap-3 text-sm">
                    <Badge variant={event.eventType === "IN" ? "default" : "outline"}>
                      {event.eventType}
                    </Badge>
                    <span>{formatDate(event.eventTime)}</span>
                    <span className="text-muted-foreground">
                      {new Date(event.eventTime).toLocaleTimeString()}
                    </span>
                    <span className="text-xs text-muted-foreground">{event.authMethod}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {faceEnrollmentLogs && faceEnrollmentLogs.logs.length > 0 && (
            <div className="border-t pt-4" data-testid="section-face-enrollment-history">
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <History className="h-4 w-4" />
                Face Enrollment History
              </h4>
              <div className="space-y-2">
                {faceEnrollmentLogs.logs.map(log => {
                  let meta: { faceId?: string; externalImageId?: string } = {};
                  let parseError = false;
                  try {
                    if (log.metadataJson) meta = JSON.parse(log.metadataJson);
                  } catch {
                    parseError = true;
                  }
                  const isAnomaly = !parseError && meta.externalImageId && meta.externalImageId !== employeeId;
                  return (
                    <div
                      key={log.id}
                      data-testid={`row-face-enrollment-${log.id}`}
                      className={`rounded-md border px-3 py-2 text-sm ${isAnomaly ? "border-amber-400 bg-amber-50 dark:bg-amber-950/20" : parseError ? "border-red-300 bg-red-50 dark:bg-red-950/20" : "border-border"}`}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-muted-foreground shrink-0">
                          {formatDate(log.createdAt)} {new Date(log.createdAt).toLocaleTimeString()}
                        </span>
                        {parseError ? (
                          <span className="text-xs text-red-600 dark:text-red-400" data-testid={`text-metadata-error-${log.id}`}>
                            Metadata unreadable
                          </span>
                        ) : (
                          <>
                            {meta.faceId && (
                              <span className="font-mono text-xs text-muted-foreground" data-testid={`text-face-id-${log.id}`}>
                                FaceId: {meta.faceId}
                              </span>
                            )}
                            {meta.externalImageId && (
                              <span className="font-mono text-xs text-muted-foreground" data-testid={`text-external-image-id-${log.id}`}>
                                ExtId: {meta.externalImageId}
                              </span>
                            )}
                            {isAnomaly && (
                              <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400 gap-1" data-testid={`badge-anomaly-${log.id}`}>
                                <AlertTriangle className="h-3 w-3" />
                                ID mismatch
                              </Badge>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {qrDialogOpen && enrollmentToken && (
        <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50 p-6">
          <div className="text-center space-y-6 max-w-sm">
            <h2 className="text-xl font-semibold">Enrollment QR Code</h2>
            <p className="text-sm text-muted-foreground">
              Scan this at the kiosk to enroll
            </p>
            <div className="bg-white p-6 rounded-lg shadow-lg inline-block">
              <QRCodeSVG
                id="enrollment-qr-svg"
                value={enrollmentToken}
                size={250}
                level="H"
                includeMargin
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Valid for 24 hours
            </p>
            <Button
              type="button"
              className="w-full"
              onClick={async () => {
                const svg = document.getElementById("enrollment-qr-svg");
                if (!svg) return;
                
                const svgData = new XMLSerializer().serializeToString(svg);
                const canvas = document.createElement("canvas");
                canvas.width = 300;
                canvas.height = 300;
                const ctx = canvas.getContext("2d");
                const img = new Image();
                
                img.onload = async () => {
                  ctx?.drawImage(img, 0, 0, 300, 300);
                  
                  // Try Web Share API first (works on mobile)
                  if (navigator.share && navigator.canShare) {
                    try {
                      const blob = await new Promise<Blob>((resolve) => 
                        canvas.toBlob((b) => resolve(b!), "image/png")
                      );
                      const file = new File([blob], "enrollment-qr.png", { type: "image/png" });
                      
                      if (navigator.canShare({ files: [file] })) {
                        await navigator.share({
                          files: [file],
                          title: "Enrollment QR Code",
                        });
                        return;
                      }
                    } catch (err) {
                      // Fall through to download approach
                    }
                  }
                  
                  // Fallback: trigger download
                  const pngUrl = canvas.toDataURL("image/png");
                  const link = document.createElement("a");
                  link.href = pngUrl;
                  link.download = "enrollment-qr.png";
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };
                
                img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
              }}
            >
              Save QR Code
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setQrDialogOpen(false)}
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// Cost Allocation Section - for splitting employee costs across branches
interface CostAllocationData {
  id: string;
  branchId: string;
  allocationPercent: number;
  branchName: string | null;
}

function CostAllocationSection({ employeeId, primaryBranchId, canEdit }: { employeeId: string; primaryBranchId: string | null; canEdit: boolean }) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [allocations, setAllocations] = useState<Array<{ branchId: string; allocationPercent: number }>>([]);

  // Fetch cost allocations
  const { data: costAllocations = [], isLoading } = useQuery<CostAllocationData[]>({
    queryKey: ["/api/employees", employeeId, "cost-allocations"],
  });

  // Fetch branches for selection
  const { data: branchesData } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });
  const branchesList = branchesData || [];

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (newAllocations: Array<{ branchId: string; allocationPercent: number }>) => {
      const res = await apiRequest("PUT", `/api/employees/${employeeId}/cost-allocations`, { allocations: newAllocations });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId, "cost-allocations"] });
      toast({ title: "Saved", description: "Cost allocations have been updated." });
      setIsEditing(false);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to update allocations.", variant: "destructive" });
    },
  });

  // Initialize allocations when starting edit or when data loads
  useEffect(() => {
    if (isEditing && costAllocations.length > 0) {
      setAllocations(costAllocations.map(a => ({ branchId: a.branchId, allocationPercent: a.allocationPercent })));
    } else if (isEditing && costAllocations.length === 0 && primaryBranchId) {
      // Default to 100% at primary branch
      setAllocations([{ branchId: primaryBranchId, allocationPercent: 100 }]);
    }
  }, [isEditing, costAllocations, primaryBranchId]);

  const totalPercent = allocations.reduce((sum, a) => sum + a.allocationPercent, 0);
  const isValidTotal = Math.abs(totalPercent - 100) < 0.01;

  const addAllocation = () => {
    const usedBranchIds = new Set(allocations.map(a => a.branchId));
    const availableBranch = branchesList.find(b => !usedBranchIds.has(b.id));
    if (availableBranch) {
      setAllocations([...allocations, { branchId: availableBranch.id, allocationPercent: 0 }]);
    }
  };

  const removeAllocation = (index: number) => {
    setAllocations(allocations.filter((_, i) => i !== index));
  };

  const updateAllocation = (index: number, field: 'branchId' | 'allocationPercent', value: string | number) => {
    const updated = [...allocations];
    if (field === 'branchId') {
      updated[index].branchId = value as string;
    } else {
      updated[index].allocationPercent = value as number;
    }
    setAllocations(updated);
  };

  const handleSave = () => {
    if (!isValidTotal) {
      toast({ title: "Invalid Total", description: "Allocations must total 100%.", variant: "destructive" });
      return;
    }
    updateMutation.mutate(allocations);
  };

  const handleCancel = () => {
    setIsEditing(false);
    // Reset to current saved data
    if (costAllocations.length > 0) {
      setAllocations(costAllocations.map(a => ({ branchId: a.branchId, allocationPercent: a.allocationPercent })));
    } else {
      setAllocations([]);
    }
  };

  const startEditing = () => {
    if (costAllocations.length > 0) {
      setAllocations(costAllocations.map(a => ({ branchId: a.branchId, allocationPercent: a.allocationPercent })));
    } else if (primaryBranchId) {
      setAllocations([{ branchId: primaryBranchId, allocationPercent: 100 }]);
    }
    setIsEditing(true);
  };

  // Get available branches for dropdown (exclude already selected)
  const getAvailableBranches = (currentBranchId: string) => {
    const usedBranchIds = new Set(allocations.map(a => a.branchId).filter(id => id !== currentBranchId));
    return branchesList.filter(b => !usedBranchIds.has(b.id));
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card data-section-id="cost-allocation" className="border-l-4 border-l-emerald-500 bg-emerald-500/5">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <PieChart className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle>Cost Allocation</CardTitle>
                  <CardDescription>Split payroll cost across multiple branches</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {costAllocations.length > 1 && (
                  <Badge variant="secondary" className="text-xs">
                    {costAllocations.length} branches
                  </Badge>
                )}
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : isEditing ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  {allocations.map((allocation, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Select
                        value={allocation.branchId}
                        onValueChange={(value) => updateAllocation(index, 'branchId', value)}
                      >
                        <SelectTrigger className="flex-1" data-testid={`select-allocation-branch-${index}`}>
                          <SelectValue placeholder="Select branch" />
                        </SelectTrigger>
                        <SelectContent>
                          {getAvailableBranches(allocation.branchId).map((branch) => (
                            <SelectItem key={branch.id} value={branch.id}>
                              {branch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="relative w-24">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={0.01}
                          value={allocation.allocationPercent}
                          onChange={(e) => updateAllocation(index, 'allocationPercent', parseFloat(e.target.value) || 0)}
                          className="pr-6"
                          data-testid={`input-allocation-percent-${index}`}
                        />
                        <Percent className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      </div>
                      {allocations.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeAllocation(index)}
                          data-testid={`button-remove-allocation-${index}`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-sm">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addAllocation}
                    disabled={allocations.length >= branchesList.length}
                    data-testid="button-add-allocation"
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add Branch
                  </Button>
                  <div className={`font-medium ${isValidTotal ? 'text-green-600' : 'text-destructive'}`}>
                    Total: {totalPercent.toFixed(1)}%
                    {!isValidTotal && <span className="ml-1 text-xs">(must be 100%)</span>}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t">
                  <Button type="button" variant="outline" size="sm" onClick={handleCancel} data-testid="button-cancel-allocation">
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSave}
                    disabled={!isValidTotal || updateMutation.isPending}
                    data-testid="button-save-allocation"
                  >
                    {updateMutation.isPending ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-1 h-3 w-3" />
                        Save
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {costAllocations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No allocations set. Cost defaults to primary branch.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {costAllocations.map((allocation) => (
                      <div key={allocation.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-md">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{allocation.branchName || 'Unknown Branch'}</span>
                        </div>
                        <Badge variant="secondary">{allocation.allocationPercent}%</Badge>
                      </div>
                    ))}
                  </div>
                )}
                {canEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={startEditing}
                    data-testid="button-edit-allocation"
                  >
                    {costAllocations.length === 0 ? "Set Allocations" : "Edit Allocations"}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

const employeeFormSchema = insertEmployeeSchema
  .omit({
    tenantId: true,
    personId: true,
  })
  .extend({
    fullName: z.string().min(2, "Full name must be at least 2 characters"),
    thaiName: z.string().optional().nullable(),
    nickname: z.string().min(1, "Nickname is required"),
    email: z.string().email("Please enter a valid email address"),
    phone: z.string().min(1, "Phone number is required"),
    address: z.string().optional(),
    branchId: z.string().min(1, "Please select a branch"),
    primaryDepartmentId: z.string().optional().nullable(),
    nationality: z.string().optional().nullable(),
    isForeignStaff: z.boolean().optional().nullable(),
    visaExpiryDate: z.string().optional().nullable(),
    workPermitExpiryDate: z.string().optional().nullable(),
    visaWpCompanyHandles: z.boolean().optional().nullable(),
    visaWpCompanyPays: z.boolean().optional().nullable(),
    visaWpCostThb: z.number().optional().nullable(),
    visaWpRepaymentIfFailProbation: z.boolean().optional().nullable(),
    visaWpRepaymentIfLeaveBefore1y: z.boolean().optional().nullable(),
    visaWpRepaymentTermsText: z.string().optional().nullable(),
    visaWpNotes: z.string().optional().nullable(),
    ssoNumber: z.string().optional().nullable(),
    taxIdNumber: z.string().optional().nullable(),
    incentiveClauseText: z.string().optional().nullable(),
    foodAllowancePerDay: z.number().optional().nullable(),
    // Employment basis - full-time vs part-time
    employmentBasis: z.enum(["FULL_TIME", "PART_TIME"]).default("FULL_TIME"),
    dailyRate: z.number().optional().nullable(),
    // Offboarding fields
    status: z.enum(employeeStatuses).default("active"),
    endReason: z.string().optional().nullable(),
    lastWorkingDay: z.string().optional().nullable(),
    defaultMergeData: z.object({
      positionTitle: z.string().min(1, "Position title is required"),
      salaryThb: z.number().optional().nullable(), // Required for full-time, validated in superRefine
      startDate: z.string().min(1, "Start date is required"),
      // workLocation is now derived from branch, not stored in employee defaults
      customClauses: z.array(z.object({
        title: z.string(),
        body: z.string(),
      })).optional(),
      // Legacy fields for backward compatibility
      extraClause1Title: z.string().optional(),
      extraClause1Body: z.string().optional(),
      extraClause2Title: z.string().optional(),
      extraClause2Body: z.string().optional(),
    }),
  }).superRefine((data, ctx) => {
    // Conditional validation: require salary for full-time, daily rate for part-time
    if (data.employmentBasis === "FULL_TIME") {
      if (!data.defaultMergeData?.salaryThb || data.defaultMergeData.salaryThb <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Monthly salary is required for full-time employees",
          path: ["defaultMergeData", "salaryThb"],
        });
      }
    } else if (data.employmentBasis === "PART_TIME") {
      if (!data.dailyRate || data.dailyRate <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Daily rate is required for part-time employees",
          path: ["dailyRate"],
        });
      }
    }
  });

type EmployeeFormData = z.infer<typeof employeeFormSchema>;

export default function EmployeeEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isNew = id === "new";
  
  // Staff role has read-only access
  const canEdit = user?.role !== "staff";
  const [updateTermsOpen, setUpdateTermsOpen] = useState(false);
  const [offboardingOpen, setOffboardingOpen] = useState(false);
  const [editingLastDay, setEditingLastDay] = useState(false);
  const [editLastDayValue, setEditLastDayValue] = useState("");
  const [warningOpen, setWarningOpen] = useState(false);
  const [contractSectionOpen, setContractSectionOpen] = useState(false);
  const [forceOpenAccessSection, setForceOpenAccessSection] = useState(false);
  const [forceOpenPersonalSection, setForceOpenPersonalSection] = useState(false);
  const [forceOpenPropertySection, setForceOpenPropertySection] = useState(false);
  const [forceOpenTimekeepingSection, setForceOpenTimekeepingSection] = useState(false);

  // Handler for navigating to specific sections from onboarding stepper
  const handleGoToStep = (stepNum: number) => {
    // Map step numbers to sections
    // 1: Essential Info -> Personal Information
    // 2, 3, 4: Contract -> Contracts section
    // 5, 6: Login/Face -> Access & Login section
    // 7: Property -> Company Property section
    
    const scrollToSection = (sectionId: string) => {
      setTimeout(() => {
        const section = document.querySelector(`[data-section-id="${sectionId}"]`);
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    };
    
    switch (stepNum) {
      case 1:
        setForceOpenPersonalSection(true);
        scrollToSection('personal-info');
        break;
      case 2:
      case 3:
      case 4:
        setContractSectionOpen(true);
        setTimeout(() => {
          const contractSection = document.querySelector('[data-section-id="contracts"]');
          if (contractSection) {
            contractSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 100);
        break;
      case 5:
        setForceOpenAccessSection(true);
        setTimeout(() => {
          const accessSection = document.querySelector('[data-testid="collapsible-access-login"]');
          if (accessSection) {
            accessSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 100);
        break;
      case 6:
        setForceOpenTimekeepingSection(true);
        setTimeout(() => {
          const timekeepingSection = document.querySelector('[data-testid="section-timekeeping"]');
          if (timekeepingSection) {
            timekeepingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 100);
        break;
      case 7:
        setForceOpenPropertySection(true);
        scrollToSection('company-property');
        break;
    }
  };

  const { data: employee, isLoading } = useQuery<Employee>({
    queryKey: ["/api/employees", id],
    enabled: !isNew,
  });

  const { data: editorAvatarStatus } = useAvatarWorkStatus(
    employee ? [employee.id] : [],
    { branchId: employee?.branchId || undefined, scope: "BRANCH" }
  );

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const { data: roles } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
  });

  interface EmployeeRoleEntry {
    id: string;
    roleId: string;
    proficiency?: string | null;
  }

  const { data: employeeRolesData } = useQuery<EmployeeRoleEntry[]>({
    queryKey: ["/api/employees", id, "roles"],
    enabled: !isNew,
  });

  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  useEffect(() => {
    if (employeeRolesData) {
      setSelectedRoleIds(employeeRolesData.map(er => er.roleId));
    }
  }, [employeeRolesData]);

  const { data: contracts } = useQuery<ContractInstance[]>({
    queryKey: ["/api/employees", id, "contracts"],
    enabled: !isNew,
  });

  const { data: changes } = useQuery<EmployeeChange[]>({
    queryKey: ["/api/employees", id, "changes"],
    enabled: !isNew,
  });

  interface EmployeeLetter {
    id: string;
    letterType: "resignation" | "termination";
    status: string;
    signingToken: string | null;
    signedAt: string | null;
    employeeSignedName: string | null;
    createdAt: string;
  }

  const { data: letters } = useQuery<EmployeeLetter[]>({
    queryKey: ["/api/employees", id, "letters"],
    enabled: !isNew && (employee?.status === "resigned" || employee?.status === "terminated"),
  });

  const { data: assets, refetch: refetchAssets } = useQuery<EmployeeAsset[]>({
    queryKey: ["/api/employees", id, "assets"],
    enabled: !isNew,
  });

  const activeContract = contracts?.find(c => c.status === "active");
  const contractHistory = contracts?.filter(c => c.status !== "active") || [];

  const form = useForm<EmployeeFormData>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: {
      fullName: "",
      thaiName: "",
      nickname: "",
      email: "",
      phone: "",
      address: "",
      branchId: "",
      primaryDepartmentId: "",
      nationality: null,
      isForeignStaff: false,
      visaExpiryDate: null,
      workPermitExpiryDate: null,
      visaWpCompanyHandles: null,
      visaWpCompanyPays: null,
      visaWpCostThb: null,
      visaWpRepaymentIfFailProbation: null,
      visaWpRepaymentIfLeaveBefore1y: null,
      visaWpRepaymentTermsText: null,
      visaWpNotes: null,
      ssoNumber: null,
      taxIdNumber: null,
      incentiveClauseText: null,
      foodAllowancePerDay: null,
      employmentBasis: "FULL_TIME" as const,
      dailyRate: null,
      status: "active",
      endReason: null,
      lastWorkingDay: null,
      jobDescription: null,
      defaultMergeData: {
        positionTitle: "",
        salaryThb: undefined,
        startDate: "",
        customClauses: [],
        extraClause1Title: "",
        extraClause1Body: "",
        extraClause2Title: "",
        extraClause2Body: "",
      },
    },
  });

  const isForeignStaff = form.watch("isForeignStaff");
  const employeeStatus = form.watch("status");
  const employmentBasis = form.watch("employmentBasis");
  const selectedBranchId = form.watch("branchId");

  // Filter roles by the selected branch - only show roles assigned to that branch
  const filteredRoles = useMemo(() => {
    if (!roles || !selectedBranchId) return [];
    return roles.filter((role: any) => {
      // If role has no branch assignments, show it (backwards compatibility)
      if (!role.branches || role.branches.length === 0) return true;
      // Otherwise, check if this role is assigned to the selected branch
      return role.branches.some((b: any) => b.id === selectedBranchId || b.branchId === selectedBranchId);
    });
  }, [roles, selectedBranchId]);
  
  // Clear offboarding fields when status is changed back to active
  useEffect(() => {
    if (employeeStatus === "active") {
      form.setValue("endReason", null);
      form.setValue("lastWorkingDay", null);
    }
  }, [employeeStatus, form]);

  // Helper to detect if employee is offboarding (resigned/terminated via status or legacy endReason)
  const endReason = form.watch("endReason");
  const isOffboarding = employeeStatus === "resigned" || employeeStatus === "terminated" || 
    endReason?.toLowerCase().includes("resign") || endReason?.toLowerCase().includes("terminat");
  const isResigning = employeeStatus === "resigned" || endReason?.toLowerCase().includes("resign");
  const isTerminating = employeeStatus === "terminated" || endReason?.toLowerCase().includes("terminat");

  // Track initial employee status to detect user-initiated changes
  const [initialStatus, setInitialStatus] = useState<string | null>(null);
  
  // Store the initial status when employee data loads
  useEffect(() => {
    if (employee && initialStatus === null) {
      setInitialStatus(employee.status || "active");
    }
  }, [employee, initialStatus]);

  // Auto-expand contract & offboarding section only when user changes status (not on initial load)
  useEffect(() => {
    // Only auto-expand if user changed status from active to offboarding
    if (initialStatus === "active" && isOffboarding) {
      setContractSectionOpen(true);
    }
    // For new employees, expand when they select offboarding status
    if (isNew && isOffboarding) {
      setContractSectionOpen(true);
    }
  }, [isOffboarding, initialStatus, isNew]);

  useEffect(() => {
    if (employee) {
      const mergeData = employee.defaultMergeData as any;
      // Migrate legacy extraClause fields to customClauses if needed
      let customClauses = mergeData?.customClauses || [];
      if (customClauses.length === 0) {
        // Convert legacy fields to custom clauses
        if (mergeData?.extraClause1Title || mergeData?.extraClause1Body) {
          customClauses.push({
            title: mergeData.extraClause1Title || "",
            body: mergeData.extraClause1Body || "",
          });
        }
        if (mergeData?.extraClause2Title || mergeData?.extraClause2Body) {
          customClauses.push({
            title: mergeData.extraClause2Title || "",
            body: mergeData.extraClause2Body || "",
          });
        }
      }
      form.reset({
        fullName: employee.fullName,
        thaiName: employee.thaiName || "",
        nickname: employee.nickname || "",
        email: employee.email,
        phone: employee.phone || "",
        address: employee.address || "",
        branchId: employee.branchId || "",
        primaryDepartmentId: employee.primaryDepartmentId || "",
        nationality: employee.nationality || null,
        isForeignStaff: employee.isForeignStaff || false,
        visaExpiryDate: employee.visaExpiryDate ? new Date(employee.visaExpiryDate).toISOString().split('T')[0] : null,
        workPermitExpiryDate: employee.workPermitExpiryDate ? new Date(employee.workPermitExpiryDate).toISOString().split('T')[0] : null,
        visaWpCompanyHandles: employee.visaWpCompanyHandles ?? null,
        visaWpCompanyPays: employee.visaWpCompanyPays ?? null,
        visaWpCostThb: employee.visaWpCostThb ?? null,
        visaWpRepaymentIfFailProbation: employee.visaWpRepaymentIfFailProbation ?? null,
        visaWpRepaymentIfLeaveBefore1y: employee.visaWpRepaymentIfLeaveBefore1y ?? null,
        visaWpRepaymentTermsText: employee.visaWpRepaymentTermsText ?? null,
        visaWpNotes: employee.visaWpNotes ?? null,
        ssoNumber: employee.ssoNumber || null,
        taxIdNumber: employee.taxIdNumber || null,
        incentiveClauseText: employee.incentiveClauseText || null,
        foodAllowancePerDay: employee.foodAllowancePerDay ?? null,
        employmentBasis: (employee.employmentBasis as "FULL_TIME" | "PART_TIME") || "FULL_TIME",
        dailyRate: employee.dailyRate ?? null,
        status: employee.status || "active",
        endReason: employee.endReason || null,
        lastWorkingDay: employee.lastWorkingDay ? new Date(employee.lastWorkingDay).toISOString().split('T')[0] : null,
        jobDescription: employee.jobDescription || null,
        defaultMergeData: {
          positionTitle: mergeData?.positionTitle || "",
          salaryThb: mergeData?.salaryThb || undefined,
          startDate: mergeData?.startDate || "",
          customClauses,
          extraClause1Title: mergeData?.extraClause1Title || "",
          extraClause1Body: mergeData?.extraClause1Body || "",
          extraClause2Title: mergeData?.extraClause2Title || "",
          extraClause2Body: mergeData?.extraClause2Body || "",
        },
      });
    }
  }, [employee, form]);

  const createMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) => {
      const cleanedData = {
        ...data,
        visaExpiryDate: data.visaExpiryDate ? new Date(data.visaExpiryDate) : null,
        workPermitExpiryDate: data.workPermitExpiryDate ? new Date(data.workPermitExpiryDate) : null,
        lastWorkingDay: data.lastWorkingDay ? new Date(data.lastWorkingDay) : null,
        startDate: data.defaultMergeData?.startDate ? new Date(data.defaultMergeData.startDate) : null,
        defaultMergeData: data.defaultMergeData && Object.values(data.defaultMergeData).some(v => v !== "" && v !== undefined)
          ? data.defaultMergeData
          : null,
      };
      const res = await apiRequest("POST", "/api/employees", cleanedData);
      const newEmployee = await res.json();
      
      if (selectedRoleIds.length > 0) {
        await apiRequest("PATCH", `/api/employees/${newEmployee.id}/roles`, { roleIds: selectedRoleIds });
      }
      
      return newEmployee;
    },
    onSuccess: (newEmployee: Employee) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", newEmployee.id, "roles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      toast({
        title: "Employee added",
        description: `${newEmployee.fullName} has been added to the directory.`,
      });
      setLocation("/employees");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) => {
      const cleanedData = {
        ...data,
        visaExpiryDate: data.visaExpiryDate ? new Date(data.visaExpiryDate) : null,
        workPermitExpiryDate: data.workPermitExpiryDate ? new Date(data.workPermitExpiryDate) : null,
        lastWorkingDay: data.lastWorkingDay ? new Date(data.lastWorkingDay) : null,
        startDate: data.defaultMergeData?.startDate ? new Date(data.defaultMergeData.startDate) : null,
        defaultMergeData: data.defaultMergeData && Object.values(data.defaultMergeData).some(v => v !== "" && v !== undefined)
          ? data.defaultMergeData
          : null,
      };
      const res = await apiRequest("PATCH", `/api/employees/${id}`, cleanedData);
      const updatedEmployee = await res.json();
      
      await apiRequest("PATCH", `/api/employees/${id}/roles`, { roleIds: selectedRoleIds });
      
      return updatedEmployee;
    },
    onSuccess: (updatedEmployee: Employee) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", id, "roles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      toast({
        title: "Employee updated",
        description: `${updatedEmployee.fullName}'s information has been updated.`,
      });
      setLocation("/employees");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateOffboardingMutation = useMutation({
    mutationFn: async (data: { lastWorkingDay?: string; reasonCode?: string; reasonText?: string; noticeDate?: string | null; notes?: string }) => {
      const res = await apiRequest("PATCH", `/api/employees/${id}/offboarding`, data);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setEditingLastDay(false);
      toast({
        title: "Offboarding updated",
        description: "Last working day has been updated. Any schedule assignments after the new date have been removed.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: EmployeeFormData) => {
    console.log("Form submitted successfully with data:", data);
    if (isNew) {
      createMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  // Debug: Log form errors when they occur
  const handleFormSubmit = form.handleSubmit(onSubmit, (errors) => {
    console.log("Form validation failed with errors:", errors);
    toast({
      title: "Validation Error",
      description: "Please check required fields and fix any errors.",
      variant: "destructive",
    });
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const { data: documents, refetch: refetchDocuments } = useQuery<EmployeeDocument[]>({
    queryKey: ["/api/employees", id, "documents"],
    enabled: !isNew,
  });

  const uploadDocumentMutation = useMutation({
    mutationFn: async ({ file, documentType, pageNumber }: { file: File; documentType: string; pageNumber: number }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("documentType", documentType);
      formData.append("pageNumber", pageNumber.toString());
      
      const res = await fetch(`/api/employees/${id}/documents`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Upload failed");
      }
      
      return res.json();
    },
    onSuccess: () => {
      refetchDocuments();
      toast({
        title: "Document uploaded",
        description: "The document has been saved successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/employees/${id}/documents/${docId}`);
    },
    onSuccess: () => {
      refetchDocuments();
      toast({
        title: "Document deleted",
        description: "The document has been removed.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Delete failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetSerial, setNewAssetSerial] = useState("");
  const [addAssetDialogOpen, setAddAssetDialogOpen] = useState(false);

  const addAssetMutation = useMutation({
    mutationFn: async (data: { assetNameSnapshot: string; serialNumber?: string }) => {
      const res = await apiRequest("POST", `/api/employees/${id}/assets`, data);
      return res.json();
    },
    onSuccess: () => {
      refetchAssets();
      setNewAssetName("");
      setNewAssetSerial("");
      setAddAssetDialogOpen(false);
      toast({
        title: "Asset assigned",
        description: "The asset has been assigned to this employee.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to assign asset",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const returnAssetMutation = useMutation({
    mutationFn: async (assetId: string) => {
      const res = await apiRequest("POST", `/api/assets/${assetId}/return`, {});
      return res.json();
    },
    onSuccess: () => {
      refetchAssets();
      toast({
        title: "Asset returned",
        description: "The asset has been marked as returned.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to return asset",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = (documentType: "id_card" | "passport" | "resignation_form" | "termination_letter" | "warning_letter" | "other", pageNumber: number = 1) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/gif,application/pdf";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        uploadDocumentMutation.mutate({ file, documentType, pageNumber });
      }
    };
    input.click();
  };

  if (!isNew && isLoading) {
    return (
      <div className="p-6 pb-40 max-w-2xl mx-auto space-y-6 bg-background">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 pb-40 max-w-2xl mx-auto space-y-6 bg-background">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link href="/employees">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          {!isNew && employee && (
            <ClickableEmployeeAvatar
              employeeId={employee.id}
              fullName={employee.fullName}
              profilePhotoPath={employee.profilePhotoPath}
              size="lg"
              workStatus={editorAvatarStatus?.[employee.id]?.status as any}
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-medium" data-testid="text-employee-editor-title">
                {isNew ? "Add Employee" : employee?.fullName || "Edit Employee"}
              </h1>
              {!isNew && employee && (() => {
                const isInProbation = employee.status === "active" && 
                  employee.probationEndDate && 
                  new Date(employee.probationEndDate) > new Date() &&
                  !employee.probationReviewCompletedAt;
                
                let displayLabel: string = employee.status;
                let badgeColor = "bg-green-600";
                
                if (employee.employmentState === "LEAVING") {
                  displayLabel = "Leaving";
                  badgeColor = "bg-amber-500";
                } else if (employee.employmentState === "LEFT") {
                  displayLabel = "Left";
                  badgeColor = "bg-gray-500";
                } else if (isInProbation) {
                  displayLabel = "Probation";
                  badgeColor = "bg-blue-600";
                } else if (employee.status === "active") {
                  displayLabel = "Active";
                  badgeColor = "bg-green-600";
                } else if (employee.status === "resigned") {
                  displayLabel = "Resigned";
                  badgeColor = "bg-amber-600";
                } else if (employee.status === "terminated") {
                  displayLabel = "Terminated";
                  badgeColor = "bg-red-600";
                }
                
                return (
                  <Badge 
                    variant="default"
                    className={badgeColor}
                    data-testid="badge-employee-status"
                  >
                    {displayLabel}
                  </Badge>
                );
              })()}
            </div>
            <p className="text-muted-foreground">
              {isNew ? "Add a new employee to your directory" : "Update employee information"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          
          {!isNew && employee?.status === "active" && canEdit && (
            <>
              <Link href={`/contracts/new?employeeId=${id}`}>
                <Button variant="outline" data-testid="button-create-contract">
                  <FileSignature className="mr-2 h-4 w-4" />
                  Create Contract
                </Button>
              </Link>
              <Button 
                variant="outline" 
                onClick={() => setUpdateTermsOpen(true)}
                data-testid="button-update-terms"
              >
                <DollarSign className="mr-2 h-4 w-4" />
                Update Terms
              </Button>
              <Button 
                variant="outline"
                className="border-orange-500 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950"
                onClick={() => setWarningOpen(true)}
                data-testid="button-issue-warning"
              >
                <AlertTriangle className="mr-2 h-4 w-4" />
                Issue Warning
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => setOffboardingOpen(true)}
                data-testid="button-offboard-employee"
              >
                <UserX className="mr-2 h-4 w-4" />
                Offboard
              </Button>
            </>
          )}
        </div>
      </div>

      {/* No Signed Contract Warning Banner */}
      {!isNew && employee && contracts && !contracts.some(c => c.signingStatus === "signed" && !c.archivedAt) && (
        <div className="flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg" data-testid="banner-no-signed-contract">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-amber-800 dark:text-amber-200">No Signed Contract</p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              This employee does not have a signed contract on file. Create and send a contract for them to sign.
            </p>
          </div>
          {canEdit && (
            <Link href={`/contracts/new?employeeId=${id}`}>
              <Button size="sm" variant="outline" className="border-amber-500 text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900" data-testid="button-create-contract-banner">
                <FileSignature className="mr-2 h-4 w-4" />
                Create Contract
              </Button>
            </Link>
          )}
        </div>
      )}

      {/* Onboarding Progress Tracker */}
      {!isNew && employee && (
        <EmployeeOnboardingStepper
          employeeId={employee.id}
          variant="inline"
          showActions={canEdit}
          onGenerateContract={() => setLocation(`/contracts/new?employeeId=${id}`)}
          onCreateLogin={() => {
            setForceOpenAccessSection(true);
            setTimeout(() => {
              const accessSection = document.querySelector('[data-testid="collapsible-access-login"]');
              if (accessSection) {
                accessSection.scrollIntoView({ behavior: 'smooth' });
              }
            }, 100);
          }}
          onGoToStep={handleGoToStep}
        />
      )}

      <Form {...form}>
        <form onSubmit={handleFormSubmit} className="space-y-6">
          <CollapsibleSection 
            title="Personal Information" 
            description="Basic details about the employee"
            icon={User}
            defaultOpen={isNew}
            forceOpen={forceOpenPersonalSection}
            sectionId="personal-info"
            showFormActions={true}
            canEdit={canEdit}
            isPending={isPending}
            isNew={isNew}
            colorClass="border-l-4 border-l-blue-500 bg-blue-500/5"
          >
              <FormField
                control={form.control}
                name="fullName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Name <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          className="pl-10"
                          placeholder="John Doe"
                          data-testid="input-employee-name"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="thaiName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Thai Name</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          className="pl-10"
                          placeholder="ชื่อภาษาไทย"
                          data-testid="input-employee-thai-name"
                          {...field}
                          value={field.value || ""}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="nickname"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nickname <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          className="pl-10"
                          placeholder="Preferred name"
                          data-testid="input-employee-nickname"
                          {...field}
                          value={field.value || ""}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email Address <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          type="email"
                          className="pl-10"
                          placeholder="john@company.com"
                          data-testid="input-employee-email"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center gap-2 flex-wrap">
                      <FormLabel>Phone Number <span className="text-red-500">*</span></FormLabel>
                      {!isNew && employee && (employee as any).phoneVerificationInfo ? (
                        (employee as any).phoneVerificationInfo.phoneVerified ? (
                          <Badge variant="outline" className="text-xs text-green-600 border-green-600 gap-0.5" data-testid="badge-phone-verified">
                            <CheckCircle className="h-3 w-3" />
                            Verified
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground gap-0.5" data-testid="badge-phone-not-verified">
                            <XCircle className="h-3 w-3" />
                            Not verified
                          </Badge>
                        )
                      ) : null}
                    </div>
                    <FormControl>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          className="pl-10"
                          placeholder="+66 123 456 789"
                          data-testid="input-employee-phone"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    {!isNew && employee && (employee as any).phoneVerificationInfo?.phoneVerified && (employee as any).phoneVerificationInfo?.phoneE164 && (
                      <FormDescription className="text-xs">
                        Verified as {(employee as any).phoneVerificationInfo.phoneE164}
                        {(employee as any).phoneVerificationInfo.phoneVerifiedAt && (
                          <> on {formatDate((employee as any).phoneVerificationInfo.phoneVerifiedAt)}</>
                        )}
                      </FormDescription>
                    )}
                    {!isNew && employee && !(employee as any).phoneVerificationInfo && employee.userId && (
                      <FormDescription className="text-xs text-muted-foreground">
                        Employee can verify their phone via My Account
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <MapPin className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <Textarea
                          className="pl-10 min-h-[100px]"
                          placeholder="123 Main Street, Bangkok 10110"
                          data-testid="input-employee-address"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
          </CollapsibleSection>

          <CollapsibleSection 
            title="Employment Details" 
            description="Position, department, roles, and salary"
            icon={Briefcase}
            defaultOpen={isNew}
            showFormActions={true}
            canEdit={canEdit}
            isPending={isPending}
            isNew={isNew}
            colorClass="border-l-4 border-l-indigo-500 bg-indigo-500/5"
          >
              <FormField
                control={form.control}
                name="defaultMergeData.positionTitle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Position Title <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          className="pl-10"
                          placeholder="e.g., Software Engineer"
                          data-testid="input-position-title"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="branchId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Branch <span className="text-red-500">*</span></FormLabel>
                    <Select
                      value={field.value || ""}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-employee-branch">
                          <Building2 className="h-4 w-4 mr-2 text-muted-foreground" />
                          <SelectValue placeholder="Select a branch" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {branches?.map((branch) => (
                          <SelectItem key={branch.id} value={branch.id}>
                            {branch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Every employee must be assigned to a branch
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="primaryDepartmentId"
                render={({ field }) => {
                  const selectedBranchId = form.watch("branchId");
                  // Filter departments that have the selected branch in their branches array (multi-branch architecture)
                  const branchDepartments = departments?.filter(d => 
                    (d as any).branches?.some((b: { id: string }) => b.id === selectedBranchId)
                  ) || [];
                  return (
                    <FormItem>
                      <FormLabel>Department</FormLabel>
                      <Select
                        value={field.value || ""}
                        onValueChange={field.onChange}
                        disabled={!selectedBranchId || branchDepartments.length === 0}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-employee-department">
                            <Building2 className="h-4 w-4 mr-2 text-muted-foreground" />
                            <SelectValue placeholder={!selectedBranchId ? "Select a branch first" : branchDepartments.length === 0 ? "No departments in this branch - create one first" : "Select a department"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {branchDepartments.map((dept) => (
                            <SelectItem key={dept.id} value={dept.id}>
                              {dept.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Required for scheduling and organization
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              <div className="space-y-2">
                <Label>Roles</Label>
                <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto" data-testid="role-selection">
                  {!selectedBranchId && (
                    <p className="text-sm text-muted-foreground">Please select a branch first to see available roles</p>
                  )}
                  {selectedBranchId && filteredRoles.length === 0 && (
                    <p className="text-sm text-muted-foreground">No roles available for this branch - an admin must assign roles to this branch first</p>
                  )}
                  {filteredRoles.map((role) => (
                    <div key={role.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`role-${role.id}`}
                        checked={selectedRoleIds.includes(role.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedRoleIds([...selectedRoleIds, role.id]);
                          } else {
                            setSelectedRoleIds(selectedRoleIds.filter(id => id !== role.id));
                          }
                        }}
                        disabled={!canEdit}
                        data-testid={`checkbox-role-${role.id}`}
                      />
                      <label
                        htmlFor={`role-${role.id}`}
                        className="text-sm cursor-pointer"
                      >
                        {role.name}
                        {role.description && (
                          <span className="text-muted-foreground ml-1">- {role.description}</span>
                        )}
                      </label>
                    </div>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  Optionally assign roles for scheduling and organization
                </p>
              </div>

              <FormField
                control={form.control}
                name="jobDescription"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Job Description</FormLabel>
                    <FormControl>
                      <Textarea
                        className="min-h-[150px]"
                        placeholder="Enter the job description, responsibilities, requirements, and qualifications for this position..."
                        data-testid="input-job-description"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value || null)}
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormDescription>
                      {canEdit 
                        ? "Describe the position's duties, responsibilities, and requirements."
                        : "Only managers and admins can edit job descriptions."
                      }
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="employmentBasis"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employment Type</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-employment-basis">
                          <SelectValue placeholder="Select employment type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="FULL_TIME">Full-time (Monthly Salary)</SelectItem>
                        <SelectItem value="PART_TIME">Part-time (Daily Rate)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Full-time employees receive monthly salary with leave benefits. Part-time employees are paid a daily rate.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {employmentBasis === "FULL_TIME" ? (
                <FormField
                  control={form.control}
                  name="defaultMergeData.salaryThb"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Monthly Salary (THB) <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">฿</span>
                          <CurrencyInput
                            className="pl-10"
                            placeholder="e.g., 50,000"
                            data-testid="input-salary"
                            value={field.value ?? undefined}
                            onChange={field.onChange}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <FormField
                  control={form.control}
                  name="dailyRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Daily Rate (THB) <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">฿</span>
                          <CurrencyInput
                            className="pl-10"
                            placeholder="e.g., 500"
                            data-testid="input-daily-rate"
                            value={field.value ?? undefined}
                            onChange={field.onChange}
                          />
                        </div>
                      </FormControl>
                      <FormDescription>
                        Amount paid per day worked. Part-time employees do not receive leave benefits.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="incentiveClauseText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Incentive / Commission Clause (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        className="min-h-[100px]"
                        placeholder="e.g., Monthly commission of 2% on sales exceeding THB 100,000. Performance bonus up to 2 months salary based on annual review."
                        data-testid="input-incentive-clause"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormDescription>
                      Standard incentive, commission, or bonus terms for this employee. Will appear under salary in contracts.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="foodAllowancePerDay"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Food Allowance Per Day (THB)</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">฿</span>
                        <CurrencyInput
                          className="pl-10"
                          placeholder="e.g., 60"
                          data-testid="input-food-allowance"
                          value={field.value ?? undefined}
                          onChange={field.onChange}
                        />
                      </div>
                    </FormControl>
                    <FormDescription>
                      Daily food allowance amount. Available as a contract variable.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="defaultMergeData.startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <DatePicker
                        value={field.value || ""}
                        onChange={field.onChange}
                        data-testid="input-start-date"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-3">
                <FormLabel>Extra Clause 1 (Optional)</FormLabel>
                <FormField
                  control={form.control}
                  name="defaultMergeData.extraClause1Title"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input
                          placeholder="Clause title"
                          data-testid="input-extra-clause-1-title"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="defaultMergeData.extraClause1Body"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          className="min-h-[80px]"
                          placeholder="Clause content"
                          data-testid="input-extra-clause-1-body"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-3">
                <FormLabel>Extra Clause 2 (Optional)</FormLabel>
                <FormField
                  control={form.control}
                  name="defaultMergeData.extraClause2Title"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input
                          placeholder="Clause title"
                          data-testid="input-extra-clause-2-title"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="defaultMergeData.extraClause2Body"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          className="min-h-[80px]"
                          placeholder="Clause content"
                          data-testid="input-extra-clause-2-body"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
          </CollapsibleSection>

          {/* Login Setup Info - only shown when creating new employees */}
          {isNew && (
            <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
              <CardContent className="flex items-start gap-3 p-4">
                <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200">Login Created After Contract Signing</p>
                  <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                    System login access will be set up as part of the onboarding workflow, after the employment contract is signed.
                    This ensures proper documentation is in place before granting system access.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <CollapsibleSection 
            title="Documents & Records" 
            description="Tax, social security, ID documents, and foreign staff documentation"
            icon={CreditCard}
            defaultOpen={isNew}
            showFormActions={true}
            canEdit={canEdit}
            isPending={isPending}
            isNew={isNew}
            colorClass="border-l-4 border-l-amber-500 bg-amber-500/5"
          >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="ssoNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SSO Number</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <CreditCard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            className="pl-10"
                            placeholder="Social Security number"
                            data-testid="input-sso-number"
                            value={field.value || ""}
                            onChange={(e) => field.onChange(e.target.value || null)}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="taxIdNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tax ID Number</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <FileText className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            className="pl-10"
                            placeholder="Tax identification number"
                            data-testid="input-tax-id"
                            value={field.value || ""}
                            onChange={(e) => field.onChange(e.target.value || null)}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="isForeignStaff"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Foreign Staff</FormLabel>
                      <FormDescription>
                        Enable this if the employee requires visa and work permit tracking
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value || false}
                        onCheckedChange={field.onChange}
                        data-testid="switch-foreign-staff"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {isForeignStaff && (
                <div className="space-y-4 pl-4 border-l-2 border-muted">
                  <FormField
                    control={form.control}
                    name="nationality"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nationality</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                              className="pl-10"
                              placeholder="e.g., Japanese, British"
                              data-testid="input-nationality"
                              value={field.value || ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="visaExpiryDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Visa Expiry Date</FormLabel>
                          <FormControl>
                            <DatePicker
                              value={field.value || ""}
                              onChange={(date) => field.onChange(date || null)}
                              data-testid="input-visa-expiry"
                            />
                          </FormControl>
                          <FormDescription>
                            Alert will trigger 90 days before expiry
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="workPermitExpiryDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Work Permit Expiry Date</FormLabel>
                          <FormControl>
                            <DatePicker
                              value={field.value || ""}
                              onChange={(date) => field.onChange(date || null)}
                              data-testid="input-work-permit-expiry"
                            />
                          </FormControl>
                          <FormDescription>
                            Alert will trigger 90 days before expiry
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="border rounded-md p-4 space-y-4 mt-4">
                    <h4 className="text-sm font-medium">Visa/Work Permit Policy</h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="visaWpCompanyHandles"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                            <div className="space-y-0.5">
                              <FormLabel className="text-sm">Company Handles</FormLabel>
                              <FormDescription className="text-xs">
                                Company arranges visa/work permit
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value || false}
                                onCheckedChange={field.onChange}
                                data-testid="switch-visa-wp-company-handles"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="visaWpCompanyPays"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                            <div className="space-y-0.5">
                              <FormLabel className="text-sm">Company Pays</FormLabel>
                              <FormDescription className="text-xs">
                                Company covers visa/work permit costs
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value || false}
                                onCheckedChange={field.onChange}
                                data-testid="switch-visa-wp-company-pays"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="visaWpCostThb"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Estimated Cost (THB)</FormLabel>
                          <FormControl>
                            <CurrencyInput
                              placeholder="e.g., 50,000"
                              data-testid="input-visa-wp-cost"
                              value={field.value ?? undefined}
                              onChange={(val) => field.onChange(val ?? null)}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="visaWpRepaymentIfFailProbation"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                          <div className="space-y-0.5">
                            <FormLabel className="text-sm">Repayment Clause</FormLabel>
                            <FormDescription className="text-xs">
                              Employee agrees to repay visa/work permit costs if they do not complete the required service period
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value || false}
                              onCheckedChange={(checked) => {
                                field.onChange(checked);
                                form.setValue("visaWpRepaymentIfLeaveBefore1y", checked);
                              }}
                              data-testid="switch-repayment-clause"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="visaWpRepaymentTermsText"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Repayment Terms</FormLabel>
                          <FormControl>
                            <Textarea
                              className="min-h-[60px]"
                              placeholder="Details of repayment terms..."
                              data-testid="input-repayment-terms"
                              value={field.value || ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="visaWpNotes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Additional Notes</FormLabel>
                          <FormControl>
                            <Textarea
                              className="min-h-[60px]"
                              placeholder="Any additional visa/work permit notes..."
                              data-testid="input-visa-wp-notes"
                              value={field.value || ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              )}

              {/* ID Documents Section - only for existing employees */}
              {!isNew && id && (
                <>
                  <Separator className="my-4" />
                  <h3 className="text-base font-semibold">ID Documents</h3>
                  <p className="text-sm text-muted-foreground mb-4">Upload ID card and passport copies</p>
                  
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <h4 className="text-sm font-medium">ID Card</h4>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleFileUpload("id_card", 1)}
                          disabled={uploadDocumentMutation.isPending}
                          data-testid="button-upload-id-front"
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Front Side
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleFileUpload("id_card", 2)}
                          disabled={uploadDocumentMutation.isPending}
                          data-testid="button-upload-id-back"
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Back Side
                        </Button>
                      </div>
                    </div>
                    {documents?.filter(d => d.documentType === "id_card").length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {documents
                          ?.filter(d => d.documentType === "id_card")
                          .sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime())
                          .map(doc => (
                            <div key={doc.id} className="relative group border rounded-md p-3 flex items-center gap-3">
                              <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{doc.fileName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {doc.mimeType.includes("pdf") ? "PDF" : "Image"}
                                </p>
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  asChild
                                >
                                  <a
                                    href={`/api/employees/${id}/documents/${doc.id}/file`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-testid={`button-view-doc-${doc.id}`}
                                  >
                                    <FileText className="h-4 w-4" />
                                  </a>
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => deleteDocumentMutation.mutate(doc.id)}
                                  disabled={deleteDocumentMutation.isPending}
                                  data-testid={`button-delete-doc-${doc.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No ID card documents uploaded</p>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <h4 className="text-sm font-medium">Passport</h4>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleFileUpload("passport", 1)}
                          disabled={uploadDocumentMutation.isPending}
                          data-testid="button-upload-passport"
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Upload Page
                        </Button>
                      </div>
                    </div>
                    {documents?.filter(d => d.documentType === "passport").length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {documents
                          ?.filter(d => d.documentType === "passport")
                          .sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime())
                          .map(doc => (
                            <div key={doc.id} className="relative group border rounded-md p-3 flex items-center gap-3">
                              <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{doc.fileName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {doc.mimeType.includes("pdf") ? "PDF" : "Image"}
                                </p>
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  asChild
                                >
                                  <a
                                    href={`/api/employees/${id}/documents/${doc.id}/file`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-testid={`button-view-passport-${doc.id}`}
                                  >
                                    <FileText className="h-4 w-4" />
                                  </a>
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => deleteDocumentMutation.mutate(doc.id)}
                                  disabled={deleteDocumentMutation.isPending}
                                  data-testid={`button-delete-passport-${doc.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No passport documents uploaded</p>
                    )}
                  </div>
                </>
              )}
          </CollapsibleSection>
        </form>
      </Form>

      {!isNew && employee && (
        <>
          <CollapsibleSection
            title="Current Employment Terms"
            description="Current salary, position, and incentive terms"
            icon={DollarSign}
            defaultOpen={false}
            colorClass="border-l-4 border-l-green-500 bg-green-500/5"
          >
            <div className="flex justify-end mb-4">
              {canEdit && (
                <Button onClick={() => setUpdateTermsOpen(true)} data-testid="button-update-terms">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Update Terms
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Position</p>
                <p className="font-medium" data-testid="text-current-position">
                  {(employee.defaultMergeData as any)?.positionTitle || "Not set"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Employment Type</p>
                <p className="font-medium" data-testid="text-employment-type">
                  {employee.employmentBasis === "PART_TIME" ? "Part-time" : "Full-time"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  {employee.employmentBasis === "PART_TIME" ? "Daily Rate" : "Monthly Salary"}
                </p>
                <p className="font-medium" data-testid="text-current-salary">
                  {employee.employmentBasis === "PART_TIME"
                    ? employee.dailyRate
                      ? `฿${employee.dailyRate.toLocaleString()}/day`
                      : "Not set"
                    : (employee.defaultMergeData as any)?.salaryThb
                      ? `฿${(employee.defaultMergeData as any).salaryThb.toLocaleString()}/month`
                      : "Not set"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Branch</p>
                <p className="font-medium" data-testid="text-current-branch">
                  {branches?.find(b => b.id === employee.branchId)?.name || "Not assigned"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Incentive Clause</p>
                <p className="font-medium text-sm" data-testid="text-current-incentive">
                  {employee.incentiveClauseText || "None"}
                </p>
              </div>
            </div>
          </CollapsibleSection>

          <ProbationStatusSection employee={employee} />

          <CostAllocationSection employeeId={employee.id} primaryBranchId={employee.branchId} canEdit={canEdit} />

          <DaysOffSection employee={employee} />

          <AccessStatusSection employeeId={employee.id} personId={employee.personId} employee={employee} forceOpen={forceOpenAccessSection} />

          <div data-testid="section-timekeeping">
            <TimekeepingSection employeeId={employee.id} canEdit={canEdit} forceOpen={forceOpenTimekeepingSection} />
          </div>

          <EmployeeVouchersSection employeeId={employee.id} />

          <Collapsible open={contractSectionOpen} onOpenChange={setContractSectionOpen} data-section-id="contracts">
            <Card className="mt-6 border-l-4 border-l-purple-500 bg-purple-500/5">
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover-elevate rounded-t-lg">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <FileSignature className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <CardTitle className="text-lg">Contracts & Updated Terms</CardTitle>
                        <CardDescription>Active contract and employment changes</CardDescription>
                      </div>
                    </div>
                    <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${contractSectionOpen ? "rotate-180" : ""}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-6">
                  {/* Active Contract Section */}
                  <div>
                    <h4 className="text-sm font-medium mb-3">Active Contract</h4>
                    {activeContract ? (
                      <div className="flex items-center justify-between gap-4 p-3 border rounded-md">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium">Contract signed {activeContract.signedAt ? formatDate(activeContract.signedAt) : "Pending"}</p>
                            <Badge variant="default">Active</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            Template version {activeContract.templateSnapshotVersion}
                          </p>
                        </div>
                        <Link href={`/contracts/${activeContract.id}`}>
                          <Button variant="outline" size="sm" data-testid="button-view-active-contract">
                            <Eye className="mr-2 h-4 w-4" />
                            View
                          </Button>
                        </Link>
                      </div>
                    ) : (
                      <div className="text-center py-6 border rounded-md">
                        <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                        <p className="text-muted-foreground mb-3">No active contract</p>
                        <Link href={`/contracts/new?employeeId=${employee.id}`}>
                          <Button variant="outline" size="sm" data-testid="button-create-contract">
                            <Plus className="mr-2 h-4 w-4" />
                            Create Contract
                          </Button>
                        </Link>
                      </div>
                    )}
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {contractHistory.length > 0 && (
            <CollapsibleSection
              title="Contract History"
              description="Previous contracts for this employee"
              icon={History}
              defaultOpen={false}
              colorClass="border-l-4 border-l-slate-500 bg-slate-500/5"
            >
                <div className="space-y-3">
                  {contractHistory.map(contract => (
                    <div key={contract.id} className="flex items-center justify-between gap-4 p-3 border rounded-md">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium">
                            {contract.signedAt ? formatDate(contract.signedAt) : "Draft"}
                          </p>
                          <Badge variant={contract.status === "superseded" ? "secondary" : "outline"}>
                            {contract.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">Version {contract.templateSnapshotVersion}</p>
                      </div>
                      <Link href={`/contracts/${contract.id}`}>
                        <Button variant="ghost" size="sm" data-testid={`button-view-contract-${contract.id}`}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
            </CollapsibleSection>
          )}

          {changes && changes.length > 0 && (
            <CollapsibleSection
              title="Change History"
              description="Record of employment term changes"
              icon={History}
              defaultOpen={false}
              colorClass="border-l-4 border-l-gray-500 bg-gray-500/5"
            >
                <div className="space-y-3">
                  {changes.map(change => (
                    <div key={change.id} className="p-3 border rounded-md">
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          {change.changeType === "salary_adjustment" && <DollarSign className="h-4 w-4 text-muted-foreground" />}
                          {change.changeType === "title_change" && <Briefcase className="h-4 w-4 text-muted-foreground" />}
                          {change.changeType === "branch_transfer" && <Building2 className="h-4 w-4 text-muted-foreground" />}
                          {change.changeType === "incentive_change" && <FileText className="h-4 w-4 text-muted-foreground" />}
                          <span className="font-medium capitalize">{change.changeType.replace("_", " ")}</span>
                          <Badge variant={change.contractGenerated ? "default" : "secondary"} className="text-xs">
                            {change.contractGenerated ? "Contract generated" : "No contract"}
                          </Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          Effective {formatDate(change.effectiveDate)}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {change.changeType === "salary_adjustment" && (
                          <>฿{change.oldSalary?.toLocaleString() || 0} → ฿{change.newSalary?.toLocaleString() || 0}</>
                        )}
                        {change.changeType === "title_change" && (
                          <>{change.oldTitle || "N/A"} → {change.newTitle}</>
                        )}
                        {change.changeType === "branch_transfer" && (
                          <>Transferred to {branches?.find(b => b.id === change.newBranchId)?.name || "new branch"}</>
                        )}
                        {change.changeType === "incentive_change" && (
                          <>Incentive clause updated</>
                        )}
                      </div>
                      {change.note && (
                        <p className="mt-2 text-sm italic text-muted-foreground">{change.note}</p>
                      )}
                    </div>
                  ))}
                </div>
            </CollapsibleSection>
          )}

          <UpdateTermsModal
            open={updateTermsOpen}
            onOpenChange={setUpdateTermsOpen}
            employee={employee}
          />
          
          <OffboardingModal
            open={offboardingOpen}
            onOpenChange={setOffboardingOpen}
            employee={employee}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/employees", id] });
            }}
          />
          
          <IssueWarningModal
            open={warningOpen}
            onOpenChange={setWarningOpen}
            employee={employee}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/employees", id] });
              queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
            }}
          />
        </>
      )}

      {!isNew && isOffboarding && employee && (
        <CollapsibleSection
          title="Offboarding"
          description={`${isResigning ? "Resignation" : "Termination"} details and letters`}
          icon={UserX}
          defaultOpen={false}
          colorClass="border-l-4 border-l-red-500 bg-red-500/5"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Status</p>
                <Badge 
                  variant="secondary"
                  className={isResigning ? "bg-amber-600" : "bg-red-600"}
                  data-testid="text-offboarding-status"
                >
                  {isResigning ? "Resigned" : "Terminated"}
                </Badge>
              </div>
              {employee.endReason && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Reason</p>
                  <p className="font-medium" data-testid="text-end-reason">{employee.endReason}</p>
                </div>
              )}
              {employee.lastWorkingDay && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Last Working Day</p>
                  {editingLastDay ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="date"
                        value={editLastDayValue}
                        onChange={(e) => setEditLastDayValue(e.target.value)}
                        className="w-44"
                        data-testid="input-edit-last-working-day"
                      />
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={updateOffboardingMutation.isPending || !editLastDayValue}
                        onClick={() => updateOffboardingMutation.mutate({ lastWorkingDay: editLastDayValue })}
                        data-testid="button-save-last-working-day"
                      >
                        {updateOffboardingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingLastDay(false)}
                        data-testid="button-cancel-edit-last-working-day"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="font-medium" data-testid="text-last-working-day">{formatDate(employee.lastWorkingDay)}</p>
                      {canEdit && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEditLastDayValue(new Date(employee.lastWorkingDay!).toISOString().split('T')[0]);
                            setEditingLastDay(true);
                          }}
                          data-testid="button-edit-last-working-day"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h4 className="text-sm font-medium">Letters</h4>
                {canEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOffboardingOpen(true)}
                    data-testid="button-generate-letter"
                  >
                    <FileSignature className="mr-2 h-4 w-4" />
                    Generate Letter
                  </Button>
                )}
              </div>
              
              {letters && letters.length > 0 ? (
                <div className="space-y-2">
                  {letters.map(letter => (
                    <div key={letter.id} className="flex items-center justify-between gap-4 p-3 rounded-md border">
                      <div className="flex items-center gap-3">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium capitalize">{letter.letterType} Letter</p>
                          <p className="text-xs text-muted-foreground">
                            Created {formatDate(letter.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={letter.status === "signed" ? "default" : "secondary"}>
                          {letter.status === "signed" ? (
                            <><CheckCircle className="mr-1 h-3 w-3" /> Signed</>
                          ) : (
                            <><Clock className="mr-1 h-3 w-3" /> Awaiting signature</>
                          )}
                        </Badge>
                        {letter.status === "signed" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              window.open(`/api/employees/${id}/letters/${letter.id}/download`, '_blank');
                            }}
                            data-testid={`button-download-letter-${letter.id}`}
                          >
                            <Download className="mr-1 h-4 w-4" />
                            Download
                          </Button>
                        )}
                        {letter.signingToken && letter.status !== "signed" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(`${window.location.origin}/letter-sign/${letter.signingToken}`);
                              toast({
                                title: "Link copied",
                                description: "Signing link has been copied to clipboard.",
                              });
                            }}
                            data-testid={`button-copy-signing-link-${letter.id}`}
                          >
                            Copy Link
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No letters have been generated yet.</p>
              )}
            </div>

            <Separator />

            {/* Uploaded Documents Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Upload className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-medium">Uploaded Documents</h4>
              </div>
              
              {/* Upload buttons */}
              {canEdit && (
                <div className="flex gap-2 flex-wrap">
                  {isResigning && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleFileUpload("resignation_form")}
                      disabled={uploadDocumentMutation.isPending}
                      data-testid="button-upload-resignation-form"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Resignation Form
                    </Button>
                  )}
                  {isTerminating && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleFileUpload("termination_letter")}
                      disabled={uploadDocumentMutation.isPending}
                      data-testid="button-upload-termination-letter"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Termination Letter
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleFileUpload("warning_letter")}
                    disabled={uploadDocumentMutation.isPending}
                    data-testid="button-upload-warning-letter"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Warning Letter
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleFileUpload("other")}
                    disabled={uploadDocumentMutation.isPending}
                    data-testid="button-upload-other-doc"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Other
                  </Button>
                </div>
              )}

              {/* Document requirement notice */}
              {!documents?.some(d => 
                (isResigning && d.documentType === "resignation_form") ||
                (isTerminating && d.documentType === "termination_letter")
              ) && (
                <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    {isResigning 
                      ? "Please upload a resignation form for this employee."
                      : "Please upload a termination letter for this employee."}
                  </p>
                </div>
              )}

              {/* Uploaded documents list */}
              {documents?.filter(d => ["resignation_form", "termination_letter", "warning_letter", "other"].includes(d.documentType)).length ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {documents
                    ?.filter(d => ["resignation_form", "termination_letter", "warning_letter", "other"].includes(d.documentType))
                    .map(doc => (
                      <div key={doc.id} className="relative group border rounded-md p-3 flex items-center gap-3">
                        <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{doc.fileName}</p>
                          <p className="text-xs text-muted-foreground">
                            {doc.documentType === "resignation_form" && "Resignation Form"}
                            {doc.documentType === "termination_letter" && "Termination Letter"}
                            {doc.documentType === "warning_letter" && "Warning Letter"}
                            {doc.documentType === "other" && "Other Document"}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            asChild
                          >
                            <a
                              href={`/api/employees/${id}/documents/${doc.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`button-view-offboard-doc-${doc.id}`}
                            >
                              <FileText className="h-4 w-4" />
                            </a>
                          </Button>
                          {canEdit && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteDocumentMutation.mutate(doc.id)}
                              disabled={deleteDocumentMutation.isPending}
                              data-testid={`button-delete-offboard-doc-${doc.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No offboarding documents uploaded yet.</p>
              )}
            </div>
          </div>
        </CollapsibleSection>
      )}

      {!isNew && (
        <CollapsibleSection
          title="Company Property"
          description="Track assets assigned to this employee"
          icon={Package}
          defaultOpen={false}
          forceOpen={forceOpenPropertySection}
          sectionId="company-property"
          colorClass="border-l-4 border-l-orange-500 bg-orange-500/5"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <h4 className="text-sm font-medium">Assigned Assets</h4>
              {canEdit && (
                <Popover open={addAssetDialogOpen} onOpenChange={setAddAssetDialogOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm" data-testid="button-add-asset">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Asset
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <div className="space-y-4">
                      <h4 className="font-medium">Assign Asset</h4>
                      <div className="space-y-2">
                        <Label htmlFor="asset-name">Asset Name</Label>
                        <Input
                          id="asset-name"
                          placeholder="e.g., Laptop, Uniform, Access Card"
                          value={newAssetName}
                          onChange={(e) => setNewAssetName(e.target.value)}
                          data-testid="input-asset-name"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="asset-serial">Serial Number (Optional)</Label>
                        <Input
                          id="asset-serial"
                          placeholder="e.g., SN12345"
                          value={newAssetSerial}
                          onChange={(e) => setNewAssetSerial(e.target.value)}
                          data-testid="input-asset-serial"
                        />
                      </div>
                      <Button
                        type="button"
                        className="w-full"
                        disabled={!newAssetName.trim() || addAssetMutation.isPending}
                        onClick={() => addAssetMutation.mutate({
                          assetNameSnapshot: newAssetName.trim(),
                          serialNumber: newAssetSerial.trim() || undefined,
                        })}
                        data-testid="button-confirm-add-asset"
                      >
                        {addAssetMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Assign Asset
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            
            {assets && assets.length > 0 ? (
              <div className="space-y-2">
                {assets.map(asset => (
                  <div 
                    key={asset.id} 
                    className={`flex items-center justify-between gap-4 p-3 rounded-md border ${asset.returnedAt ? 'bg-muted/50' : ''}`}
                    data-testid={`asset-row-${asset.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <Package className={`h-5 w-5 ${asset.returnedAt ? 'text-muted-foreground' : 'text-primary'}`} />
                      <div>
                        <p className={`text-sm font-medium ${asset.returnedAt ? 'line-through text-muted-foreground' : ''}`}>
                          {asset.assetNameSnapshot}
                        </p>
                        <div className="text-xs text-muted-foreground">
                          {asset.serialNumber && <span>SN: {asset.serialNumber} • </span>}
                          <span>Assigned {formatDate(asset.assignedAt)}</span>
                          {asset.returnedAt && <span> • Returned {formatDate(asset.returnedAt)}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {asset.returnRequired && !asset.returnedAt ? (
                        <>
                          <Badge variant="outline" className="text-amber-600 border-amber-500/50">
                            Pending return
                          </Badge>
                          {canEdit && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => returnAssetMutation.mutate(asset.id)}
                              disabled={returnAssetMutation.isPending}
                              data-testid={`button-return-asset-${asset.id}`}
                            >
                              <RotateCcw className="mr-2 h-4 w-4" />
                              Return
                            </Button>
                          )}
                        </>
                      ) : asset.returnedAt ? (
                        <Badge variant="secondary" className="text-green-600">
                          <CheckCircle className="mr-1 h-3 w-3" />
                          Returned
                        </Badge>
                      ) : (
                        <Badge variant="secondary">No return required</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No assets assigned to this employee.</p>
            )}
          </div>
        </CollapsibleSection>
      )}

    </div>
  );
}
