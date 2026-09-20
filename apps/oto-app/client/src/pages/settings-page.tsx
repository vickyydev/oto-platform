import { useEffect, useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Setting } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Save, Loader2, PenLine, Eraser, UserCog, AlertCircle, Check, DatabaseZap, RefreshCw, Wrench } from "lucide-react";
import SignatureCanvas from "react-signature-canvas";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { FixDepartmentSection } from "@/components/fix-department-section";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";

const signatoryFormSchema = z.object({
  mdSignatoryName: z.string().min(1, "Signatory name is required"),
  mdSignatoryTitle: z.string().min(1, "Signatory title is required"),
});

type SignatoryFormData = z.infer<typeof signatoryFormSchema>;

function AISettingsSection({ settings }: { settings: Setting[] }) {
  const { toast } = useToast();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const KEY_ORDER = [
    "ai_event_extraction_model",
    "ai_event_extraction_advice",
    "ai_event_extraction_output_format",
    "ai_beo_parsing_advice",
    "ai_beo_parsing_output_format",
  ];
  const aiSettings = settings
    .filter((s) => s.key.startsWith("ai_"))
    .sort((a, b) => {
      const ai = KEY_ORDER.indexOf(a.key);
      const bi = KEY_ORDER.indexOf(b.key);
      const aOrder = ai === -1 ? KEY_ORDER.length : ai;
      const bOrder = bi === -1 ? KEY_ORDER.length : bi;
      return aOrder - bOrder;
    });

  useEffect(() => {
    const loadModels = async () => {
      try {
        setLoadingModels(true);
        const res = await apiRequest("GET", "/api/ai/available-models");
        const data = await res.json();
        setAvailableModels(data.models || []);
      } catch (error) {
        console.error("Failed to load AI models", error);
      } finally {
        setLoadingModels(false);
      }
    };
    loadModels();
  }, []);

  const saveSettingMutation = useMutation({
    mutationFn: async (data: { key: string; value: string }) => {
      await apiRequest("POST", "/api/settings", [data]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      setEditingKey(null);
      setEditingValue("");
      toast({
        title: "Setting saved",
        description: "AI setting has been updated.",
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

  const handleSave = (key: string, value: string) => {
    saveSettingMutation.mutate({ key, value });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Settings</CardTitle>
        <CardDescription>Configure AI models and prompts for event extraction</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {aiSettings.map((setting) => {
          const isModel = setting.key.includes("model");
          const isEditing = editingKey === setting.key;
          const currentValue = isEditing ? editingValue : setting.value;

          return (
            <div key={setting.key} className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-muted-foreground capitalize">
                  {setting.key.replace(/_/g, " ")}
                </label>
                {!isEditing && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingKey(setting.key);
                      setEditingValue(setting.value);
                    }}
                  >
                    <PenLine className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {isEditing ? (
                <div className="space-y-2">
                  {isModel ? (
                    <select
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      className="w-full px-3 py-2 border rounded-md bg-background"
                      disabled={loadingModels}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <textarea
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      className="w-full px-3 py-2 border rounded-md bg-background font-mono text-xs min-h-[200px]"
                    />
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleSave(setting.key, editingValue)}
                      disabled={saveSettingMutation.isPending}
                    >
                      {saveSettingMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Save
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingKey(null);
                        setEditingValue("");
                      }}
                      disabled={saveSettingMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="bg-muted/50 p-3 rounded text-sm">
                  {isModel ? (
                    <Badge variant="secondary">{currentValue}</Badge>
                  ) : (
                    <pre className="text-xs overflow-auto max-h-[150px] whitespace-pre-wrap break-words font-mono">
                      {currentValue}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ProductionSyncSection() {
  const { toast } = useToast();
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [syncStartedThisSession, setSyncStartedThisSession] = useState(false);

  const { data: syncStatus, refetch } = useQuery<{
    status: "idle" | "running" | "completed" | "error";
    currentTable: string;
    tablesCompleted: number;
    totalTables: number;
    rowsCopied: number;
    errors: string[];
    startedAt: string | null;
    completedAt: string | null;
    lastSyncInfo?: { completedAt: string; tablesCompleted: number; rowsCopied: number } | null;
  }>({
    queryKey: ["/api/admin/prod-sync/status"],
    refetchInterval: pollingEnabled ? 2000 : false,
  });

  useEffect(() => {
    if (syncStatus?.status === "running") {
      setPollingEnabled(true);
      setSyncStartedThisSession(true);
    } else if (syncStatus?.status === "completed" || syncStatus?.status === "error") {
      setPollingEnabled(false);
    }
  }, [syncStatus?.status]);

  useEffect(() => {
    if (syncStartedThisSession && syncStatus?.status === "completed") {
      window.location.href = "/auth";
    }
  }, [syncStatus?.status, syncStartedThisSession]);

  const startSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/prod-sync");
      return res.json();
    },
    onSuccess: () => {
      setPollingEnabled(true);
      setSyncStartedThisSession(true);
      toast({ title: "Sync started", description: "Copying production data to development. You'll be redirected to login when done." });
      refetch();
    },
    onError: (error: Error) => {
      toast({ title: "Sync failed to start", description: error.message, variant: "destructive" });
    },
  });

  const isRunning = syncStatus?.status === "running";
  const progressPercent = syncStatus?.totalTables ? Math.round((syncStatus.tablesCompleted / syncStatus.totalTables) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseZap className="h-5 w-5" />
          Production Data Sync
        </CardTitle>
        <CardDescription>
          Copy all data from the production database to this development environment. This replaces all development data with production data. Only available in development mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {syncStatus?.status === "idle" && syncStatus?.lastSyncInfo && (
          <div className="rounded-md border border-muted bg-muted/30 p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Check className="h-4 w-4" />
              Last synced: {new Date(syncStatus.lastSyncInfo.completedAt).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              {syncStatus.lastSyncInfo.tablesCompleted} tables, {syncStatus.lastSyncInfo.rowsCopied.toLocaleString()} rows copied
            </p>
          </div>
        )}
        {syncStatus?.status === "completed" && (
          <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-green-800 dark:text-green-200">
              <Check className="h-4 w-4" />
              Last sync completed
            </div>
            <p className="text-xs text-muted-foreground">
              {syncStatus.tablesCompleted} tables, {syncStatus.rowsCopied.toLocaleString()} rows copied
              {syncStatus.completedAt && ` at ${new Date(syncStatus.completedAt).toLocaleString()}`}
            </p>
            {syncStatus.errors.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {syncStatus.errors.length} warning(s):
                </p>
                {syncStatus.errors.slice(0, 5).map((err, i) => (
                  <p key={i} className="text-xs text-muted-foreground">{err}</p>
                ))}
                {syncStatus.errors.length > 5 && (
                  <p className="text-xs text-muted-foreground">...and {syncStatus.errors.length - 5} more</p>
                )}
              </div>
            )}
          </div>
        )}

        {syncStatus?.status === "error" && (
          <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950 p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-red-800 dark:text-red-200">
              <AlertCircle className="h-4 w-4" />
              Sync failed
            </div>
            {syncStatus.errors.map((err, i) => (
              <p key={i} className="text-xs text-muted-foreground">{err}</p>
            ))}
          </div>
        )}

        {isRunning && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Syncing: <span className="font-mono text-xs">{syncStatus?.currentTable}</span>
              </span>
              <Badge variant="secondary">{progressPercent}%</Badge>
            </div>
            <Progress value={progressPercent} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {syncStatus?.tablesCompleted} / {syncStatus?.totalTables} tables, {syncStatus?.rowsCopied.toLocaleString()} rows copied
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                disabled={isRunning || startSyncMutation.isPending}
                data-testid="button-start-prod-sync"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <DatabaseZap className="mr-2 h-4 w-4" />
                    Sync from Production
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Replace development data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete ALL data in the development database and replace it with a copy of the production data. This cannot be undone. Are you sure?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => startSyncMutation.mutate()}
                  data-testid="button-confirm-prod-sync"
                >
                  Yes, replace development data
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {(syncStatus?.status === "completed" || syncStatus?.status === "error") && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => refetch()}
              data-testid="button-refresh-sync-status"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const { isAllBranches } = useBranchContext();
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const sigCanvasRef = useRef<SignatureCanvas>(null);
  const [tempSignature, setTempSignature] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
  });

  const signatoryForm = useForm<SignatoryFormData>({
    resolver: zodResolver(signatoryFormSchema),
    defaultValues: {
      mdSignatoryName: "Tom Sauer",
      mdSignatoryTitle: "Managing Director",
    },
  });

  const currentSignature = settings?.find((s) => s.key === "md_signature_image")?.value;

  useEffect(() => {
    if (settings) {
      const mdName = settings.find((s) => s.key === "md_signatory_name");
      const mdTitle = settings.find((s) => s.key === "md_signatory_title");

      signatoryForm.reset({
        mdSignatoryName: mdName?.value || signatoryForm.getValues("mdSignatoryName"),
        mdSignatoryTitle: mdTitle?.value || signatoryForm.getValues("mdSignatoryTitle"),
      });
    }
  }, [settings, signatoryForm]);

  const saveSignatoryMutation = useMutation({
    mutationFn: async (data: SignatoryFormData & { signature?: string }) => {
      const settingsToSave = [
        { key: "md_signatory_name", value: data.mdSignatoryName },
        { key: "md_signatory_title", value: data.mdSignatoryTitle },
      ];
      if (data.signature) {
        settingsToSave.push({ key: "md_signature_image", value: data.signature });
      }
      await apiRequest("POST", "/api/settings", settingsToSave);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Signatory settings saved",
        description: "Company signatory information has been updated.",
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

  const onSignatorySubmit = (data: SignatoryFormData) => {
    saveSignatoryMutation.mutate(data);
  };

  const handleCaptureSignature = () => {
    if (sigCanvasRef.current && !sigCanvasRef.current.isEmpty()) {
      const dataUrl = sigCanvasRef.current.toDataURL("image/png");
      setTempSignature(dataUrl);
    }
  };

  const handleSaveSignature = () => {
    if (tempSignature) {
      const formData = signatoryForm.getValues();
      saveSignatoryMutation.mutate({
        ...formData,
        signature: tempSignature,
      });
      setShowSignaturePad(false);
      setTempSignature(null);
    }
  };

  const handleClearSignature = () => {
    sigCanvasRef.current?.clear();
    setTempSignature(null);
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-medium" data-testid="text-settings-title">Settings</h1>
        <p className="text-muted-foreground">
          Configure company signatory settings
        </p>
      </div>

      {isAllBranches ? (
        <>
          <Form {...signatoryForm}>
            <form onSubmit={signatoryForm.handleSubmit(onSignatorySubmit)} className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <UserCog className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle>Company Signatory (Managing Director)</CardTitle>
                      <CardDescription>
                        Configure the authorized signatory for all contracts
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!currentSignature && (
                    <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" />
                      <div className="text-sm text-amber-800 dark:text-amber-200">
                        <p className="font-medium">Signature Required</p>
                        <p className="text-amber-700 dark:text-amber-300">
                          Please capture the Managing Director's signature to enable automatic signing of contracts.
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField
                      control={signatoryForm.control}
                      name="mdSignatoryName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Signatory Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Tom Sauer"
                              data-testid="input-md-signatory-name"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={signatoryForm.control}
                      name="mdSignatoryTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Title</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Managing Director"
                              data-testid="input-md-signatory-title"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm font-medium">Signature</p>
                    {currentSignature ? (
                      <div className="space-y-3">
                        <div className="border rounded-md p-4 bg-white dark:bg-gray-900">
                          <img 
                            src={currentSignature} 
                            alt="Current signature" 
                            className="max-h-24 mx-auto"
                            data-testid="img-current-signature"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-600" />
                          <span className="text-sm text-muted-foreground">Signature captured</span>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowSignaturePad(true)}
                          data-testid="button-recapture-signature"
                        >
                          <PenLine className="mr-2 h-4 w-4" />
                          Re-capture Signature
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowSignaturePad(true)}
                        data-testid="button-capture-signature"
                      >
                        <PenLine className="mr-2 h-4 w-4" />
                        Capture Signature
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={saveSignatoryMutation.isPending}
                  data-testid="button-save-signatory"
                >
                  {saveSignatoryMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" />
                      Save Signatory Settings
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>

        </>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              Select "All Branches" to view and configure company-wide signatory settings.
            </p>
          </CardContent>
        </Card>
      )}

      {settings && settings.some(s => s.key.startsWith("ai_")) && (
        <AISettingsSection settings={settings} />
      )}

      <FixDepartmentSection />

      <ProductionSyncSection />

      <Dialog open={showSignaturePad} onOpenChange={setShowSignaturePad}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Capture MD Signature</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Use the pad below to capture the Managing Director's signature. This will be automatically applied to all contracts.
            </p>
            <div 
              className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-md bg-white"
              style={{ touchAction: "none" }}
            >
              <SignatureCanvas
                ref={sigCanvasRef}
                penColor="#1a1a1a"
                canvasProps={{
                  width: 460,
                  height: 180,
                  className: "w-full rounded-md",
                  style: { backgroundColor: "white" },
                }}
                onEnd={handleCaptureSignature}
              />
            </div>
            {tempSignature && (
              <div className="p-2 bg-green-50 dark:bg-green-950/30 rounded-md border border-green-200 dark:border-green-800">
                <p className="text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
                  <Check className="h-4 w-4" />
                  Signature captured - click Save to confirm
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleClearSignature}
                data-testid="button-clear-md-signature"
              >
                <Eraser className="mr-2 h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowSignaturePad(false);
                setTempSignature(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveSignature}
              disabled={!tempSignature || saveSignatoryMutation.isPending}
              data-testid="button-save-md-signature"
            >
              {saveSignatoryMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Signature
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
