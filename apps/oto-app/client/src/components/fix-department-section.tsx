import { useQuery, useMutation } from "@tanstack/react-query";
import { Wrench, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export function FixDepartmentSection() {
  const { toast } = useToast();

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/fix-department"] });
      toast({ title: "Fix Department saved" });
    },
    onError: () => {
      toast({ title: "Failed to save Fix Department", variant: "destructive" });
    },
  });

  const currentValue = currentSetting?.departmentId || "none";

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
          <div className="flex items-center gap-3">
            <Select
              value={currentValue}
              onValueChange={(val) => saveMutation.mutate(val === "none" ? null : val)}
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
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
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
