import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { Redirect, Route } from "wouter";

export function ProtectedRoute({
  path,
  component: Component,
}: {
  path: string;
  component: () => React.JSX.Element;
}) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <Route path={path}>
        <div className="flex items-center justify-center min-h-screen bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-primary" data-testid="loading-spinner" />
        </div>
      </Route>
    );
  }

  if (!user) {
    return (
      <Route path={path}>
        <Redirect to="/auth" />
      </Route>
    );
  }

  // Force password change redirect - except when already on change-password page
  if (user.mustChangePassword && path !== "/change-password") {
    return (
      <Route path={path}>
        <Redirect to="/change-password" />
      </Route>
    );
  }

  // Force phone verification for first-time login - except when already on verify-phone page
  // Only require for staff/manager roles (not admins who may not have phone numbers)
  // Check both phoneE164 and phoneNumber to handle both formats
  const hasPhoneNumber = Boolean(user.phoneE164 || user.phoneNumber);
  const requiresPhoneVerification = 
    !user.phoneVerified && 
    hasPhoneNumber && 
    ["staff", "manager"].includes(user.role) &&
    path !== "/verify-phone" &&
    path !== "/change-password";
    
  if (requiresPhoneVerification) {
    return (
      <Route path={path}>
        <Redirect to="/verify-phone" />
      </Route>
    );
  }

  return <Route path={path} component={Component} />;
}
