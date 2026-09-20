import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserCheck, UserX } from "lucide-react";

interface RoleInfo {
  roleId: string;
  roleName: string;
  isPrimary: boolean;
}

interface AvailabilityData {
  employeeId: string;
  roles: RoleInfo[];
  unavailableRoles: string[];
  date: string;
}

export default function MyAvailabilityPage() {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];

  const { data, isLoading } = useQuery<AvailabilityData>({
    queryKey: ["/api/core/my-role-availability", today],
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ roleId, roleName, unavailable }: { roleId: string; roleName: string; unavailable: boolean }) => {
      const res = await apiRequest("POST", "/api/core/my-role-availability", { roleId, roleName, unavailable, date: today });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Availability updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/my-role-availability"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/nanny-schedule"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleToggle = (role: RoleInfo, currentlyUnavailable: boolean) => {
    toggleMutation.mutate({
      roleId: role.roleId,
      roleName: role.roleName,
      unavailable: !currentlyUnavailable,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const roles = data?.roles || [];
  const unavailableRoles = data?.unavailableRoles || [];

  if (roles.length === 0) {
    return (
      <div className="p-4 max-w-lg mx-auto">
        <h1 className="text-xl font-bold mb-4">My Availability</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <UserCheck className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No roles assigned to your profile.</p>
            <p className="text-sm mt-2">Contact your manager to assign roles.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">
      <h1 className="text-xl font-bold">My Availability</h1>
      <p className="text-sm text-muted-foreground">
        Toggle your availability for today ({new Date(today).toLocaleDateString()}). 
        When unavailable, you won't appear in the schedule for that role.
      </p>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Today's Availability</CardTitle>
          <CardDescription>Switch off roles you're not available for</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {roles.map((role) => {
            const isUnavailable = unavailableRoles.includes(role.roleId);
            return (
              <div 
                key={role.roleId} 
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div className="flex items-center gap-3">
                  {isUnavailable ? (
                    <UserX className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <UserCheck className="h-5 w-5 text-green-600" />
                  )}
                  <div>
                    <div className="font-medium">{role.roleName}</div>
                    <div className="text-xs text-muted-foreground">
                      {isUnavailable ? "Unavailable today" : "Available today"}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={!isUnavailable}
                  onCheckedChange={() => handleToggle(role, isUnavailable)}
                  disabled={toggleMutation.isPending}
                  data-testid={`toggle-availability-${role.roleId}`}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Your availability resets each day. Toggle off if you need to be unavailable for specific roles today.
      </p>
    </div>
  );
}
