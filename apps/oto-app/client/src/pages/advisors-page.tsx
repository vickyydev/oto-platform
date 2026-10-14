import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Person, Branch, AccessPolicy, Department } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, MoreHorizontal, Pencil, UserCheck, Shield, Briefcase, Search, Loader2, KeyRound, Trash2, QrCode, LogIn } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDate } from "@/lib/format-utils";
import { QRCodeSVG } from "qrcode.react";
import { useLegacyLoginOff } from "@/lib/sign-in-options";
import { SuiteSignInDialog } from "@/components/suite-sign-in";

type PersonWithAccess = Person & { accessPolicy?: AccessPolicy | null };

/** `GET /api/people/:id/suite-sign-in` (SCRUM-539). */
type AdvisorSuiteSignIn = {
  hasLogin: boolean;
  linked: boolean;
  phoneE164: string | null;
  configured: boolean;
  legacyLogin: boolean;
};

type CreateAdvisorFormData = {
  fullName: string;
  preferredName: string | null;
  email: string;
  phoneNumber: string | null;
  departmentId: string | null;
  createLogin: boolean;
  password: string;
  accessLevel: "STAFF" | "MANAGER" | "ADMIN";
  modules: { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean };
  branchScope: "ALL" | "SELECTED";
  branchIds: string[];
};

type AccessPolicyFormData = {
  accessLevel: "STAFF" | "MANAGER" | "ADMIN";
  modules: {
    core: boolean;
    hr: boolean;
    studio: boolean;
    events: boolean;
    ops: boolean;
    setup: boolean;
  };
  branchScope: "ALL" | "SELECTED";
  branchIds: string[];
};

const defaultAccessPolicy: AccessPolicyFormData = {
  accessLevel: "ADMIN",
  modules: { core: true, hr: true, studio: false, events: false, ops: false, setup: false },
  branchScope: "ALL",
  branchIds: [],
};

export default function AdvisorsPage() {
  const { toast } = useToast();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<PersonWithAccess | null>(null);
  const [isAccessDialogOpen, setIsAccessDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [personToDelete, setPersonToDelete] = useState<PersonWithAccess | null>(null);
  const [enrollmentAdvisor, setEnrollmentAdvisor] = useState<PersonWithAccess | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  // SCRUM-539: with this app's own sign-in closed, an initial password opens
  // nothing; the advisor gets a suite sign-in from the Core Account tab.
  const { off: legacyOff } = useLegacyLoginOff();
  const [suiteSignInOpen, setSuiteSignInOpen] = useState(false);

  const [formData, setFormData] = useState<CreateAdvisorFormData>({
    fullName: "",
    preferredName: null,
    email: "",
    phoneNumber: null,
    departmentId: null,
    createLogin: true,
    password: "",
    accessLevel: "ADMIN",
    modules: { core: true, hr: true, studio: false, events: false, ops: false, setup: false },
    branchScope: "ALL",
    branchIds: [],
  });

  const [accessFormData, setAccessFormData] = useState<AccessPolicyFormData>(defaultAccessPolicy);

  const { data: allPeople = [], isLoading: peopleLoading } = useQuery<PersonWithAccess[]>({
    queryKey: ["/api/people"],
  });

  const advisors = allPeople.filter((p) => p.personType === "ADVISOR");

  const suiteSignInKey = ["/api/people", selectedPerson?.id ?? "", "suite-sign-in"];
  const { data: suiteSignIn, isLoading: suiteSignInLoading } = useQuery<AdvisorSuiteSignIn>({
    queryKey: suiteSignInKey,
    enabled: isAccessDialogOpen && !!selectedPerson,
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const createAdvisorMutation = useMutation({
    mutationFn: async (data: CreateAdvisorFormData) => {
      const payload = {
        fullName: data.fullName,
        preferredName: data.preferredName,
        email: data.email,
        phoneNumber: data.phoneNumber,
        departmentId: data.departmentId,
        personType: "ADVISOR" as const,
        ...(data.createLogin && (legacyOff || data.password.length >= 6)
          ? {
              createLogin: true,
              ...(legacyOff ? {} : { password: data.password }),
              accessLevel: data.accessLevel, 
              modules: data.modules,
              branchScope: data.branchScope,
              branchIds: data.branchIds,
            }
          : {}),
      };
      const res = await apiRequest("POST", "/api/people", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      setIsCreateDialogOpen(false);
      resetForm();
      toast({ title: "Advisor created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create advisor", description: error.message, variant: "destructive" });
    },
  });

  const updateAdvisorMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateAdvisorFormData> }) => {
      const res = await apiRequest("PATCH", `/api/people/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      setSelectedPerson(null);
      resetForm();
      toast({ title: "Advisor updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update advisor", description: error.message, variant: "destructive" });
    },
  });

  const saveAccessPolicyMutation = useMutation({
    mutationFn: async ({ personId, data }: { personId: string; data: AccessPolicyFormData }) => {
      const res = await apiRequest("PUT", `/api/people/${personId}/access`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      setIsAccessDialogOpen(false);
      setSelectedPerson(null);
      toast({
        title: "Access policy saved",
        description: "The advisor's session has been signed out. They will see the new role on their next login.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save access policy", description: error.message, variant: "destructive" });
    },
  });



  const deletePersonMutation = useMutation({
    mutationFn: async (personId: string) => {
      const res = await apiRequest("DELETE", `/api/people/${personId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      toast({ title: "Advisor deleted", description: "The advisor and their user account have been removed." });
      setDeleteConfirmOpen(false);
      setPersonToDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete advisor", description: error.message, variant: "destructive" });
    },
  });

  const generateEnrollmentMutation = useMutation({
    mutationFn: async (person: PersonWithAccess) => {
      const res = await apiRequest("POST", `/api/people/${person.id}/advisor-enrollment-session`);
      return { person, data: await res.json() };
    },
    onSuccess: ({ person, data }) => {
      setEnrollmentAdvisor(person);
      setEnrollmentToken(data.token);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to generate enrollment QR", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({
      fullName: "",
      preferredName: null,
      email: "",
      phoneNumber: null,
      departmentId: null,
      createLogin: true,
      password: "",
      accessLevel: "ADMIN",
      modules: { core: true, hr: true, studio: false, events: false, ops: false, setup: false },
      branchScope: "ALL",
      branchIds: [],
    });
  };

  const openEditDialog = (person: PersonWithAccess) => {
    setSelectedPerson(person);
    setFormData({
      fullName: person.fullName,
      preferredName: person.preferredName,
      email: person.email,
      phoneNumber: person.phoneNumber || null,
      departmentId: person.departmentId || null,
      createLogin: false,
      password: "",
      accessLevel: (person.accessPolicy?.accessLevel as "STAFF" | "MANAGER" | "ADMIN") || "ADMIN",
      modules: (person.accessPolicy?.modules as { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean }) || { core: true, hr: true, studio: false, events: false, ops: false, setup: false },
      branchScope: (person.accessPolicy?.branchScope as "ALL" | "SELECTED") || "ALL",
      branchIds: (person.accessPolicy?.branchIds as string[]) || [],
    });
    setIsCreateDialogOpen(true);
  };

  const openAccessDialog = (person: PersonWithAccess) => {
    setSelectedPerson(person);
    if (person.accessPolicy) {
      setAccessFormData({
        accessLevel: person.accessPolicy.accessLevel as "STAFF" | "MANAGER" | "ADMIN",
        modules: person.accessPolicy.modules as { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean },
        branchScope: person.accessPolicy.branchScope as "ALL" | "SELECTED",
        branchIds: (person.accessPolicy.branchIds as string[]) || [],
      });
    } else {
      setAccessFormData(defaultAccessPolicy);
    }
    setIsAccessDialogOpen(true);
  };

  const handleSubmit = () => {
    if (selectedPerson) {
      updateAdvisorMutation.mutate({ id: selectedPerson.id, data: formData });
    } else {
      createAdvisorMutation.mutate(formData);
    }
  };

  const handleSaveAccessPolicy = () => {
    if (selectedPerson) {
      saveAccessPolicyMutation.mutate({ personId: selectedPerson.id, data: accessFormData });
    }
  };

  const toggleBranchSelection = (branchId: string) => {
    setAccessFormData((prev) => ({
      ...prev,
      branchIds: prev.branchIds.includes(branchId)
        ? prev.branchIds.filter((id) => id !== branchId)
        : [...prev.branchIds, branchId],
    }));
  };

  const filteredAdvisors = advisors.filter((person) => {
    const displayName = person.preferredName || person.fullName;
    return (
      displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      person.email.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const getAccessBadge = (person: PersonWithAccess) => {
    if (!person.accessPolicy) {
      return <Badge variant="outline">No Access</Badge>;
    }
    const modules = person.accessPolicy.modules as { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean };
    const enabledModules = Object.entries(modules).filter(([_, enabled]) => enabled).map(([name]) => name);
    if (enabledModules.length === 0) {
      return <Badge variant="outline">No Modules</Badge>;
    }
    return (
      <div className="flex gap-1 flex-wrap">
        {enabledModules.map((mod) => (
          <Badge key={mod} variant="secondary">{({ core: "Today", ops: "Ops", hr: "HR", studio: "Studio", events: "Events", setup: "Setup" } as Record<string, string>)[mod] || mod}</Badge>
        ))}
      </div>
    );
  };

  const getAccountStatusBadge = (person: PersonWithAccess) => {
    if (!person.accessPolicy) {
      return null;
    }
    if (person.accessPolicy.coreUserId) {
      return <Badge variant="default" className="gap-1"><UserCheck className="h-3 w-3" />Active</Badge>;
    }
    return <Badge variant="outline">Not Provisioned</Badge>;
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-advisors-title">Advisors</h1>
          <p className="text-muted-foreground">External consultants and admin accounts without employment records</p>
        </div>
        <Button onClick={() => { resetForm(); setSelectedPerson(null); setIsCreateDialogOpen(true); }} data-testid="button-add-advisor">
          <Plus className="h-4 w-4 mr-2" />
          Add Advisor
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-advisors"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {peopleLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredAdvisors.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Briefcase className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>{searchQuery ? "No matching advisors found" : "No advisors added yet"}</p>
              <p className="text-sm mt-1">Add external consultants or admin accounts here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Access Level</TableHead>
                  <TableHead>Modules</TableHead>
                  <TableHead>Account</TableHead>
                   <TableHead>Face Enrollment</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAdvisors.map((person) => (
                  <TableRow key={person.id} data-testid={`row-advisor-${person.id}`}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2 flex-wrap">
                        {person.preferredName || person.fullName}
                        {person.isProtected && <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-500">Super Admin</Badge>}
                      </span>
                    </TableCell>
                    <TableCell>{person.email}</TableCell>
                    <TableCell>
                      {person.departmentId ? (
                        <span>{departments.find(d => d.id === person.departmentId)?.name || "-"}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {person.accessPolicy ? (
                        <Badge variant="outline">{person.accessPolicy.accessLevel}</Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>{getAccessBadge(person)}</TableCell>
                    <TableCell>{getAccountStatusBadge(person)}</TableCell>
                     <TableCell>
                       <div className="flex items-center gap-2">
                         <Badge variant={person.faceEnrollmentStatus === "ENROLLED" ? "default" : "secondary"}>
                           {person.faceEnrollmentStatus === "ENROLLED" ? "Enrolled" : "Not enrolled"}
                         </Badge>
                         <Button
                           type="button"
                           variant="outline"
                           size="sm"
                           onClick={() => generateEnrollmentMutation.mutate(person)}
                           disabled={!person.accessPolicy || generateEnrollmentMutation.isPending}
                           data-testid={`button-enroll-advisor-${person.id}`}
                         >
                           <QrCode className="mr-2 h-4 w-4" />
                           {person.faceEnrollmentStatus === "ENROLLED" ? "Re-enroll" : "Enroll Face"}
                         </Button>
                       </div>
                     </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" data-testid={`button-advisor-menu-${person.id}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(person)} data-testid="menu-edit-advisor">
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openAccessDialog(person)} data-testid="menu-manage-access">
                            <Shield className="h-4 w-4 mr-2" />
                            Manage Access
                          </DropdownMenuItem>
                          {!person.isProtected && (
                            <DropdownMenuItem 
                              onClick={() => { setPersonToDelete(person); setDeleteConfirmOpen(true); }}
                              className="text-destructive focus:text-destructive"
                              data-testid="menu-delete-advisor"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!enrollmentToken}
        onOpenChange={(open) => {
          if (!open) {
            setEnrollmentToken(null);
            setEnrollmentAdvisor(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Advisor Kiosk Enrollment</DialogTitle>
            <DialogDescription>
              Have {enrollmentAdvisor?.preferredName || enrollmentAdvisor?.fullName} scan this QR code from the shared kiosk's Enroll Face option. It expires in 24 hours.
            </DialogDescription>
          </DialogHeader>
          {enrollmentToken && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="rounded-lg bg-white p-4">
                <QRCodeSVG value={enrollmentToken} size={240} level="M" />
              </div>
              <p className="max-w-full break-all rounded bg-muted p-2 font-mono text-xs" data-testid="text-advisor-enrollment-token">
                {enrollmentToken}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setEnrollmentToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateDialogOpen} onOpenChange={(open) => { setIsCreateDialogOpen(open); if (!open) setSelectedPerson(null); }}>
        <DialogContent className={selectedPerson ? "max-w-md" : "max-w-3xl"}>
          <DialogHeader>
            <DialogTitle>{selectedPerson ? "Edit Advisor" : "Add New Advisor"}</DialogTitle>
            <DialogDescription>
              {selectedPerson ? "Update the advisor's details" : "Create a new advisor account"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className={selectedPerson ? undefined : "grid gap-6 md:grid-cols-2"}>
            <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fullName">Full Name *</Label>
              <Input
                id="fullName"
                value={formData.fullName}
                onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                placeholder="Legal full name"
                data-testid="input-full-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preferredName">Preferred Name</Label>
              <Input
                id="preferredName"
                value={formData.preferredName || ""}
                onChange={(e) => setFormData({ ...formData, preferredName: e.target.value || null })}
                placeholder="Display name (optional)"
                data-testid="input-preferred-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="email@example.com"
                data-testid="input-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phoneNumber">Phone Number</Label>
              <Input
                id="phoneNumber"
                type="tel"
                value={formData.phoneNumber || ""}
                onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value || null })}
                placeholder="081 234 5678"
                data-testid="input-phone-number"
              />
              <p className="text-xs text-muted-foreground">
                {legacyOff
                  ? "The number they sign in with at the OTO launcher (Thai format accepted)."
                  : "Used for password reset via SMS. Include country code (e.g., +66 for Thailand)"}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="department">Department</Label>
              <Select
                value={formData.departmentId || "none"}
                onValueChange={(v) => setFormData({ ...formData, departmentId: v === "none" ? null : v })}
              >
                <SelectTrigger data-testid="select-department">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Department</SelectItem>
                  {departments.filter(d => d.isActive).map((dept) => (
                    <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Assign this advisor to a department for reporting and filtering
              </p>
            </div>
            </div>

            {!selectedPerson && (
              <div className="space-y-4 border-t pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="createLogin"
                    checked={formData.createLogin}
                    onCheckedChange={(checked) => setFormData({ ...formData, createLogin: !!checked })}
                    data-testid="checkbox-create-login"
                  />
                  <Label htmlFor="createLogin" className="font-medium">Create Login Account</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {legacyOff
                    ? "Creates this advisor's user in the app. They sign in at the OTO launcher once you provision their suite sign-in (Manage Access, Core Account)."
                    : "Creates a user account so this advisor can log into the system"}
                </p>

                {formData.createLogin && (
                  <div className="space-y-4 pl-6 border-l-2 border-muted">
                    {!legacyOff && <div className="space-y-2">
                      <Label htmlFor="password">Initial Password *</Label>
                      <Input
                        id="password"
                        type="text"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        placeholder="At least 6 characters"
                        data-testid="input-password"
                      />
                      <p className="text-xs text-muted-foreground">
                        User will be required to change this password on first login
                      </p>
                    </div>}
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select
                        value={formData.accessLevel}
                        onValueChange={(v) => setFormData({ ...formData, accessLevel: v as "STAFF" | "MANAGER" | "ADMIN" })}
                      >
                        <SelectTrigger data-testid="select-user-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="STAFF">Staff - View only</SelectItem>
                          <SelectItem value="MANAGER">Manager - Edit within branches</SelectItem>
                          <SelectItem value="ADMIN">Admin - Full access</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Modules</Label>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                        {(["core", "ops", "hr", "studio", "events", "setup"] as const).map((mod) => (
                          <div key={mod} className="flex items-center space-x-2">
                            <Checkbox
                              id={`create-module-${mod}`}
                              checked={formData.modules[mod]}
                              onCheckedChange={(checked) => 
                                setFormData({
                                  ...formData,
                                  modules: { ...formData.modules, [mod]: !!checked },
                                })
                              }
                              data-testid={`checkbox-create-module-${mod}`}
                            />
                            <Label htmlFor={`create-module-${mod}`}>{({ core: "Today", ops: "Ops", hr: "HR", studio: "Studio (Legacy)", events: "Events", setup: "Setup" } as Record<string, string>)[mod] || mod}</Label>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Select which areas of the app this advisor can access
                      </p>
                    </div>
                    
                    <div className="space-y-2 pt-2">
                      <Label>Branch Access</Label>
                      <Select
                        value={formData.branchScope}
                        onValueChange={(v) => setFormData({ ...formData, branchScope: v as "ALL" | "SELECTED" })}
                      >
                        <SelectTrigger data-testid="select-branch-scope-create">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">All Branches</SelectItem>
                          <SelectItem value="SELECTED">Selected Branches</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {formData.branchScope === "SELECTED" && (
                      <div className="space-y-2">
                        <Label>Select Branches</Label>
                        <div className="border rounded-md p-3 space-y-2 max-h-[120px] overflow-y-auto">
                          {branches.map((branch) => (
                            <div key={branch.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`create-branch-${branch.id}`}
                                checked={formData.branchIds.includes(branch.id)}
                                onCheckedChange={() => {
                                  const newIds = formData.branchIds.includes(branch.id)
                                    ? formData.branchIds.filter(id => id !== branch.id)
                                    : [...formData.branchIds, branch.id];
                                  setFormData({ ...formData, branchIds: newIds });
                                }}
                                data-testid={`checkbox-create-branch-${branch.id}`}
                              />
                              <Label htmlFor={`create-branch-${branch.id}`}>{branch.name}</Label>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleSubmit} 
              disabled={
                createAdvisorMutation.isPending || 
                updateAdvisorMutation.isPending || 
                !formData.fullName || 
                !formData.email ||
                (formData.createLogin && !legacyOff && formData.password.length < 6)
              }
              data-testid="button-save-advisor"
            >
              {(createAdvisorMutation.isPending || updateAdvisorMutation.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {selectedPerson ? "Save Changes" : "Create Advisor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAccessDialogOpen} onOpenChange={(open) => { setIsAccessDialogOpen(open); if (!open) setSelectedPerson(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Access - {selectedPerson?.preferredName || selectedPerson?.fullName}</DialogTitle>
            <DialogDescription>
              Configure system access and permissions for this advisor
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="policy" className="py-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="policy">Access Policy</TabsTrigger>
              <TabsTrigger value="core">Core Account</TabsTrigger>
            </TabsList>
            <TabsContent value="policy" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Access Level</Label>
                <Select
                  value={accessFormData.accessLevel}
                  onValueChange={(v) => setAccessFormData({ ...accessFormData, accessLevel: v as any })}
                >
                  <SelectTrigger data-testid="select-access-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STAFF">Staff - View only</SelectItem>
                    <SelectItem value="MANAGER">Manager - Edit within branches</SelectItem>
                    <SelectItem value="ADMIN">Admin - Full access</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Modules</Label>
                <div className="flex gap-4">
                  {["core", "ops", "hr", "studio", "events", "setup"].map((mod) => (
                    <div key={mod} className="flex items-center space-x-2">
                      <Checkbox
                        id={`module-${mod}`}
                        checked={accessFormData.modules[mod as keyof typeof accessFormData.modules]}
                        onCheckedChange={(checked) => 
                          setAccessFormData({
                            ...accessFormData,
                            modules: { ...accessFormData.modules, [mod]: !!checked },
                          })
                        }
                        data-testid={`checkbox-module-${mod}`}
                      />
                      <Label htmlFor={`module-${mod}`}>{({ core: "Today", ops: "Ops", hr: "HR", studio: "Studio (Legacy)", events: "Events", setup: "Setup" } as Record<string, string>)[mod] || mod}</Label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Branch Scope</Label>
                <Select
                  value={accessFormData.branchScope}
                  onValueChange={(v) => setAccessFormData({ ...accessFormData, branchScope: v as any })}
                >
                  <SelectTrigger data-testid="select-branch-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Branches</SelectItem>
                    <SelectItem value="SELECTED">Selected Branches</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {accessFormData.branchScope === "SELECTED" && (
                <div className="space-y-2">
                  <Label>Selected Branches</Label>
                  <div className="border rounded-md p-3 space-y-2 max-h-[150px] overflow-y-auto">
                    {branches.map((branch) => (
                      <div key={branch.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`branch-${branch.id}`}
                          checked={accessFormData.branchIds.includes(branch.id)}
                          onCheckedChange={() => toggleBranchSelection(branch.id)}
                          data-testid={`checkbox-branch-${branch.id}`}
                        />
                        <Label htmlFor={`branch-${branch.id}`}>{branch.name}</Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="core" className="space-y-4 pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Suite sign-in</CardTitle>
                  <CardDescription>
                    The advisor signs in at the OTO launcher with their phone number and opens the OTO App from there.
                    What they see stays governed by the access policy.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {suiteSignInLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : suiteSignIn?.linked ? (
                    <div className="space-y-2" data-testid="text-advisor-suite-signin-active">
                      <Badge variant="default" className="gap-1">
                        <UserCheck className="h-3 w-3" />
                        Suite sign-in active
                      </Badge>
                      <p className="text-sm text-muted-foreground">
                        They sign in at the launcher{suiteSignIn.phoneE164 ? ` with ${suiteSignIn.phoneE164}` : ""}. A forgotten
                        password is reset there ("Forgot password?").
                      </p>
                    </div>
                  ) : suiteSignIn && !suiteSignIn.configured ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-advisor-suite-signin-unconfigured">
                      This deployment cannot give suite sign-ins yet (the platform link is not configured).
                    </p>
                  ) : suiteSignIn ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        No suite sign-in yet. One press makes it; the temporary password is shown once.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSuiteSignInOpen(true)}
                        disabled={!selectedPerson?.accessPolicy}
                        data-testid="button-advisor-suite-signin"
                      >
                        <LogIn className="h-4 w-4 mr-2" />
                        Provision suite sign-in
                      </Button>
                      {!selectedPerson?.accessPolicy && (
                        <p className="text-xs text-muted-foreground">Save an access policy first.</p>
                      )}
                    </div>
                  ) : null}
                  {!legacyOff && selectedPerson?.accessPolicy?.coreUserId ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="default" className="gap-1">
                          <UserCheck className="h-3 w-3" />
                          Account Provisioned
                        </Badge>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAccessDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleSaveAccessPolicy} 
              disabled={saveAccessPolicyMutation.isPending}
              data-testid="button-save-access"
            >
              {saveAccessPolicyMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Access Policy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SuiteSignInDialog
        open={suiteSignInOpen}
        onOpenChange={setSuiteSignInOpen}
        personName={selectedPerson?.preferredName || selectedPerson?.fullName || ""}
        initialPhone={selectedPerson?.phoneNumber ?? suiteSignIn?.phoneE164 ?? null}
        endpoint={`/api/people/${selectedPerson?.id}/suite-sign-in`}
        onProvisioned={() => {
          queryClient.invalidateQueries({ queryKey: suiteSignInKey });
          queryClient.invalidateQueries({ queryKey: ["/api/people"] });
        }}
      />

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Advisor</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {personToDelete?.fullName}? This also removes their user account, their access settings and their face enrolment. An advisor with recorded attendance or clock-ins cannot be deleted; deactivate their login on the Users page instead. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => personToDelete && deletePersonMutation.mutate(personToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deletePersonMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
