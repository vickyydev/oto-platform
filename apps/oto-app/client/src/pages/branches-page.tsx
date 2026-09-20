import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Branch } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Pencil, Trash2, Loader2, Building2, MapPin, Image, X, Upload, Copy, Check, Monitor, Globe, QrCode, Download } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/format-utils";

const TIMEZONE_OPTIONS = [
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok (UTC+7)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+9)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong Kong (UTC+8)' },
  { value: 'Asia/Manila', label: 'Asia/Manila (UTC+8)' },
  { value: 'Asia/Kuala_Lumpur', label: 'Asia/Kuala Lumpur (UTC+8)' },
  { value: 'Asia/Jakarta', label: 'Asia/Jakarta (UTC+7)' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Asia/Ho Chi Minh (UTC+7)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (UTC+5:30)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (UTC+4)' },
  { value: 'Europe/London', label: 'Europe/London (UTC+0/+1)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (UTC+1/+2)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (UTC+1/+2)' },
  { value: 'America/New_York', label: 'America/New York (UTC-5/-4)' },
  { value: 'America/Los_Angeles', label: 'America/Los Angeles (UTC-8/-7)' },
  { value: 'America/Chicago', label: 'America/Chicago (UTC-6/-5)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (UTC+10/+11)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (UTC+12/+13)' },
  { value: 'UTC', label: 'UTC (UTC+0)' },
];

const branchFormSchema = z.object({
  name: z.string().min(1, "Branch name is required"),
  address: z.string().min(1, "Address is required"),
  timezone: z.string().optional(),
  googleDriveFolder: z.string().optional(),
  googleDriveFolderName: z.string().optional(),
});

type BranchFormData = z.infer<typeof branchFormSchema>;

function BranchLogo({ logoUrl, name, className = "h-10 w-10", iconClassName = "h-5 w-5" }: { logoUrl: string | null | undefined; name: string; className?: string; iconClassName?: string }) {
  const [imageError, setImageError] = useState(false);
  
  if (!logoUrl || imageError) {
    return (
      <Avatar className={className}>
        <AvatarFallback>
          <Building2 className={`${iconClassName} text-muted-foreground`} />
        </AvatarFallback>
      </Avatar>
    );
  }
  
  return (
    <Avatar className={className}>
      <img 
        src={logoUrl} 
        alt={name}
        className="aspect-square h-full w-full object-cover"
        onError={() => setImageError(true)}
      />
    </Avatar>
  );
}

export default function BranchesPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [branchToDelete, setBranchToDelete] = useState<Branch | null>(null);
  const [logoDialogOpen, setLogoDialogOpen] = useState(false);
  const [logoBranch, setLogoBranch] = useState<Branch | null>(null);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [copiedBranchId, setCopiedBranchId] = useState<string | null>(null);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [selectedQrBranch, setSelectedQrBranch] = useState<Branch | null>(null);
  const [qrData, setQrData] = useState<{ qrDataUrl: string; formUrl: string } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  
  const [receptionKioskDialogOpen, setReceptionKioskDialogOpen] = useState(false);
  const [receptionKioskBranch, setReceptionKioskBranch] = useState<Branch | null>(null);
  const [receptionKioskCode, setReceptionKioskCode] = useState<{ code: string; expiresAt: string; setupUrl?: string; qrDataUrl?: string } | null>(null);
  const [receptionKioskLoading, setReceptionKioskLoading] = useState(false);
  const [receptionKioskCountdown, setReceptionKioskCountdown] = useState(0);

  const handleShowQR = async (branch: Branch) => {
    setSelectedQrBranch(branch);
    setQrDialogOpen(true);
    setQrLoading(true);
    try {
      const res = await fetch(`/api/admin/branches/${branch.id}/qr`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to generate QR code");
      const data = await res.json();
      setQrData(data);
    } catch (error) {
      toast({ title: "Error", description: "Failed to generate QR code", variant: "destructive" });
    } finally {
      setQrLoading(false);
    }
  };

  const handleDownloadQR = () => {
    if (!qrData || !selectedQrBranch) return;
    const link = document.createElement("a");
    link.download = `checkin-qr-${selectedQrBranch.slug || selectedQrBranch.id}.png`;
    link.href = qrData.qrDataUrl;
    link.click();
  };

  const handleCopyCheckinUrl = () => {
    if (!qrData) return;
    navigator.clipboard.writeText(qrData.formUrl);
    toast({ title: "Copied", description: "Check-in URL copied to clipboard" });
  };

  const copyKioskUrl = async (branchId: string) => {
    const url = `${window.location.origin}/kiosk/${branchId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBranchId(branchId);
      toast({ title: "Copied!", description: "Kiosk URL copied to clipboard" });
      setTimeout(() => setCopiedBranchId(null), 2000);
    } catch (err) {
      toast({ title: "Error", description: "Failed to copy URL", variant: "destructive" });
    }
  };

  const handleReceptionKioskSetup = async (branch: Branch) => {
    setReceptionKioskBranch(branch);
    setReceptionKioskDialogOpen(true);
    setReceptionKioskLoading(true);
    setReceptionKioskCode(null);
    
    try {
      const res = await apiRequest("POST", `/api/branches/${branch.id}/kiosk-code`);
      const data = await res.json();
      setReceptionKioskCode(data);
      
      const expiresAt = new Date(data.expiresAt);
      const updateCountdown = () => {
        const now = new Date();
        const remaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
        setReceptionKioskCountdown(remaining);
        if (remaining > 0) {
          setTimeout(updateCountdown, 1000);
        }
      };
      updateCountdown();
    } catch (error) {
      toast({ title: "Error", description: "Failed to generate kiosk setup code", variant: "destructive" });
    } finally {
      setReceptionKioskLoading(false);
    }
  };

  const copyReceptionKioskUrl = async () => {
    if (!receptionKioskCode) return;
    const url = `${window.location.origin}/kiosk/reception?code=${encodeURIComponent(receptionKioskCode.code)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Copied!", description: "Setup URL copied to clipboard. Use it within 2 minutes." });
    } catch (err) {
      toast({ title: "Error", description: "Failed to copy URL", variant: "destructive" });
    }
  };

  const { data: branches, isLoading } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const form = useForm<BranchFormData>({
    resolver: zodResolver(branchFormSchema),
    defaultValues: {
      name: "",
      address: "",
      timezone: "Asia/Bangkok",
      googleDriveFolder: "",
      googleDriveFolderName: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: BranchFormData) => {
      const res = await apiRequest("POST", "/api/branches", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      setDialogOpen(false);
      form.reset();
      toast({
        title: "Branch created",
        description: "The new branch has been added.",
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

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: BranchFormData }) => {
      const res = await apiRequest("PATCH", `/api/branches/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      setDialogOpen(false);
      setEditingBranch(null);
      form.reset();
      toast({
        title: "Branch updated",
        description: "The branch has been updated.",
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

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/branches/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      setDeleteDialogOpen(false);
      setBranchToDelete(null);
      toast({
        title: "Branch deleted",
        description: "The branch has been removed.",
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

  const deleteLogoMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/branches/${id}/logo`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      setLogoDialogOpen(false);
      setLogoBranch(null);
      toast({
        title: "Logo removed",
        description: "The branch logo has been removed.",
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


  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !logoBranch) return;

    setIsUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append("logo", file);

      const response = await fetch(`/api/branches/${logoBranch.id}/logo`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to upload logo");
      }

      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      setLogoDialogOpen(false);
      setLogoBranch(null);
      toast({
        title: "Logo uploaded",
        description: "The branch logo has been updated.",
      });
    } catch (error) {
      toast({
        title: "Error uploading logo",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsUploadingLogo(false);
      if (logoInputRef.current) {
        logoInputRef.current.value = "";
      }
    }
  };

  const openLogoDialog = (branch: Branch) => {
    setLogoBranch(branch);
    setLogoDialogOpen(true);
  };

  const openCreateDialog = () => {
    setEditingBranch(null);
    form.reset({
      name: "",
      address: "",
      timezone: "Asia/Bangkok",
      googleDriveFolder: "",
      googleDriveFolderName: "",
    });
    setDialogOpen(true);
  };

  const openEditDialog = (branch: Branch) => {
    setEditingBranch(branch);
    form.reset({
      name: branch.name,
      address: branch.address,
      timezone: branch.timezone || "Asia/Bangkok",
      googleDriveFolder: branch.googleDriveFolder || "",
      googleDriveFolderName: (branch as any).googleDriveFolderName || "",
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: BranchFormData) => {
    if (editingBranch) {
      updateMutation.mutate({ id: editingBranch.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-medium" data-testid="text-branches-title">Branches</h1>
          <p className="text-muted-foreground">
            Manage company branches and their settings
          </p>
        </div>
        <div className="flex gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreateDialog} data-testid="button-add-branch">
                <Plus className="mr-2 h-4 w-4" />
                Add Branch
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingBranch ? "Edit Branch" : "Create New Branch"}</DialogTitle>
              <DialogDescription>
                {editingBranch
                  ? "Update the branch details below."
                  : "Add a new company branch with its address and Google Drive folder."}
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Branch Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g., Bangkok Office"
                          data-testid="input-branch-name"
                          {...field}
                        />
                      </FormControl>
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
                        <Input
                          placeholder="123 Main Street, Bangkok"
                          data-testid="input-branch-address"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <Globe className="inline-block mr-1 h-4 w-4" />
                        Timezone
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || "Asia/Bangkok"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-branch-timezone">
                            <SelectValue placeholder="Select timezone" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TIMEZONE_OPTIONS.map((tz) => (
                            <SelectItem key={tz.value} value={tz.value}>
                              {tz.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Timezone used for scheduling and timekeeping at this branch
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createMutation.isPending || updateMutation.isPending}
                    data-testid="button-save-branch"
                  >
                    {(createMutation.isPending || updateMutation.isPending) ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {editingBranch ? "Update Branch" : "Create Branch"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {branches && branches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>All Branches</CardTitle>
            <CardDescription>
              {branches.length} branch{branches.length !== 1 ? "es" : ""} configured
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Logo</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Kiosk URL</TableHead>
                  <TableHead>Check-in Tools</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches.map((branch) => (
                  <TableRow key={branch.id} data-testid={`row-branch-${branch.id}`}>
                    <TableCell>
                      <BranchLogo logoUrl={branch.logoUrl} name={branch.name} />
                    </TableCell>
                    <TableCell className="font-medium">
                      {branch.name}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        {branch.address}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => copyKioskUrl(branch.id)}
                              data-testid={`button-copy-kiosk-${branch.id}`}
                            >
                              {copiedBranchId === branch.id ? (
                                <Check className="h-4 w-4 mr-2 text-green-500" />
                              ) : (
                                <Monitor className="h-4 w-4 mr-2" />
                              )}
                              {copiedBranchId === branch.id ? "Copied!" : "Copy URL"}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-mono text-xs">/kiosk/{branch.id}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => handleShowQR(branch)}
                              data-testid={`button-qr-${branch.id}`}
                            >
                              <QrCode className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Guest Check-in QR</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => handleReceptionKioskSetup(branch)}
                              data-testid={`button-reception-kiosk-${branch.id}`}
                            >
                              <Monitor className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Staff Kiosk Setup</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(branch.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openLogoDialog(branch)}
                          data-testid={`button-logo-branch-${branch.id}`}
                        >
                          <Image className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(branch)}
                          data-testid={`button-edit-branch-${branch.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setBranchToDelete(branch);
                            setDeleteDialogOpen(true);
                          }}
                          data-testid={`button-delete-branch-${branch.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-16">
            <div className="text-center">
              <Building2 className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
              <h3 className="text-lg font-medium mb-2">No branches yet</h3>
              <p className="text-muted-foreground mb-6">
                Create your first branch to organize templates and contracts by location.
              </p>
              <Button onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Add Your First Branch
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Branch</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{branchToDelete?.name}"? This action cannot be undone.
              Templates and contracts associated with this branch will need to be reassigned.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => branchToDelete && deleteMutation.mutate(branchToDelete.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-branch"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Delete Branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={logoDialogOpen} onOpenChange={setLogoDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Branch Logo</DialogTitle>
            <DialogDescription>
              Upload or manage the logo for "{logoBranch?.name}"
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-center">
              <BranchLogo logoUrl={logoBranch?.logoUrl} name={logoBranch?.name || ""} className="h-24 w-24" iconClassName="h-12 w-12" />
            </div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/svg+xml"
              onChange={handleLogoUpload}
              className="hidden"
              data-testid="input-logo-file"
            />
            <div className="flex gap-2 justify-center">
              <Button
                variant="outline"
                onClick={() => logoInputRef.current?.click()}
                disabled={isUploadingLogo}
                data-testid="button-upload-logo"
              >
                {isUploadingLogo ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {logoBranch?.logoUrl ? "Replace Logo" : "Upload Logo"}
              </Button>
              {logoBranch?.logoUrl && (
                <Button
                  variant="destructive"
                  onClick={() => logoBranch && deleteLogoMutation.mutate(logoBranch.id)}
                  disabled={deleteLogoMutation.isPending}
                  data-testid="button-remove-logo"
                >
                  {deleteLogoMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-2 h-4 w-4" />
                  )}
                  Remove Logo
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Supported formats: JPEG, PNG, GIF, SVG. Max size: 2MB
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogoDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">{selectedQrBranch?.name} Check-in QR</DialogTitle>
            <DialogDescription className="text-center">
              Customers scan this code to fill the check-in form
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center space-y-4">
            {qrLoading ? (
              <div className="h-64 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : qrData ? (
              <>
                <div className="bg-white p-4 rounded-lg">
                  <img src={qrData.qrDataUrl} alt="QR Code" className="w-64 h-64" data-testid="img-qr-code" />
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground break-all max-w-[280px]">{qrData.formUrl}</p>
                </div>
                <div className="flex gap-2 w-full">
                  <Button onClick={handleDownloadQR} className="flex-1" data-testid="button-download-qr">
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                  <Button variant="outline" onClick={handleCopyCheckinUrl} className="flex-1" data-testid="button-copy-checkin-url">
                    <Copy className="h-4 w-4 mr-2" />
                    Copy URL
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={receptionKioskDialogOpen} onOpenChange={setReceptionKioskDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-center">Reception Kiosk Setup</DialogTitle>
            <DialogDescription className="text-center">
              {receptionKioskBranch?.name} - Set up a new reception device
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center space-y-4 py-4">
            {receptionKioskLoading ? (
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            ) : receptionKioskCode ? (
              <>
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Scan this QR code on the reception device within:
                  </p>
                  <div className={`text-3xl font-bold ${receptionKioskCountdown < 30 ? 'text-destructive' : 'text-primary'}`}>
                    {Math.floor(receptionKioskCountdown / 60)}:{String(receptionKioskCountdown % 60).padStart(2, '0')}
                  </div>
                </div>
                {receptionKioskCode.qrDataUrl && (
                  <div className="bg-white p-4 rounded-lg">
                    <img 
                      src={receptionKioskCode.qrDataUrl} 
                      alt="Reception Kiosk Setup QR" 
                      className="w-48 h-48" 
                      data-testid="img-kiosk-qr-code"
                    />
                  </div>
                )}
                <div className="flex gap-2 w-full">
                  <Button onClick={copyReceptionKioskUrl} className="flex-1" data-testid="button-copy-kiosk-setup-url">
                    <Copy className="h-4 w-4 mr-2" />
                    Copy URL
                  </Button>
                  {receptionKioskCountdown === 0 && (
                    <Button 
                      variant="outline" 
                      onClick={() => receptionKioskBranch && handleReceptionKioskSetup(receptionKioskBranch)}
                      className="flex-1"
                      data-testid="button-regenerate-kiosk-code"
                    >
                      New Code
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  This code can only be used once and will create a new device session that lasts ~30 days.
                </p>
              </>
            ) : (
              <p className="text-destructive">Failed to generate code. Try again.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
