import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Wrench, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export function FixDepartmentSection() {
  const { toast } = useToast();
  const [draftDepartment, setDraftDepartment] = useState<string | null>(null);

  const { data: allDepts = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/departments"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/departments");
      return res.json();
    },
  });

  const { data: currentSetting, isLoading } = useQuery<{ departmentId: string | null; department: { id: string; name: string } | null }>({
    queryKey: ["/api/settings/fix-department"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings/fix-department");
      return res.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (departmentId: string | null) => {
      const res = await apiRequest("POST", "/api/settings/fix-department", { departmentId: departmentId || "" });
      return res.json();
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["/api/settings/fix-department"], saved);
      setDraftDepartment(null);
      toast({ title: "Fix Department saved" });
    },
    onError: () => {
      toast({ title: "Failed to save Fix Department", variant: "destructive" });
    },
  });

  const savedValue = currentSetting?.departmentId || "none";
  const currentValue = draftDepartment ?? savedValue;
  const { data: preview, isFetching: previewLoading, isError: previewFailed, refetch: retryPreview } = useQuery<{
    department: { id: string; name: string } | null;
    members: { id: string; name: string; initials: string }[];
    count: number;
  }>({
    queryKey: ["/api/settings/fix-department/recipients", currentValue],
    enabled: !!currentSetting,
    queryFn: async () => {
      const departmentId = currentValue === "none" ? "" : currentValue;
      const res = await apiRequest("GET", `/api/settings/fix-department/recipients?departmentId=${encodeURIComponent(departmentId)}`);
      return res.json();
    },
  });

  return (
    <Card data-testid="card-fix-department">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="h-4 w-4" />
          Fix Department
        </CardTitle>
        <CardDescription>
          Designate the department that handles Fix reports. All members with a login will see reports in their My Queue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={currentValue}
              onValueChange={setDraftDepartment}
              disabled={saveMutation.isPending}
            >
              <SelectTrigger className="flex-1" data-testid="select-fix-department">
                <SelectValue placeholder="Select department..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No department —</SelectItem>
                {allDepts.map((dept) => (
                  <SelectItem key={dept.id} value={dept.id} data-testid={`select-fix-dept-${dept.id}`}>
                    {dept.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => saveMutation.mutate(currentValue === "none" ? null : currentValue)}
              disabled={saveMutation.isPending || currentValue === savedValue || previewLoading || previewFailed || !preview}
              data-testid="button-save-fix-department"
            >
              Save
            </Button>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        )}
        {currentSetting && (
          <div className="mt-3 rounded-md border p-3 text-sm" aria-live="polite" data-testid="fix-recipient-preview">
            {previewLoading ? (
              <p className="text-muted-foreground">Loading staff preview...</p>
            ) : previewFailed ? (
              <div>
                <p>Staff preview could not be loaded.</p>
                <Button variant="outline" size="sm" onClick={() => retryPreview()} className="mt-2">Retry</Button>
              </div>
            ) : preview ? (
              <>
                <p className="font-medium">Staff in this department: {preview.count}</p>
                {preview.members.length ? (
                  <ul className="mt-2 space-y-1">
                    {preview.members.map((member, index) => <li key={`${member.id}-${index}`}>{member.name}</li>)}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    {preview.department ? "No staff with a login are listed in this department." : "No department is selected. Reports will have no department assignment."}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">Preview only. Save to use this department for new Fix reports.</p>
              </>
            ) : null}
          </div>
        )}
        {currentSetting?.department && (
          <p className="text-xs text-muted-foreground mt-2">
            Current: <span className="font-medium text-foreground">{currentSetting.department.name}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
