import { createContext, ReactNode, useContext, useEffect } from "react";
import * as Sentry from "@sentry/react";
import {
  useQuery,
  useMutation,
  UseMutationResult,
} from "@tanstack/react-query";
import { User as SelectUser, InsertUser, UserWithBranchAccess } from "@shared/schema";
import { getQueryFn, apiRequest, queryClient } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { readSignInOptions, withSignOutMarker, type SignInOptions } from "@/lib/sign-in-options";
import { useThemeOptional } from "@/components/theme-provider";

type AuthContextType = {
  user: UserWithBranchAccess | null;
  isLoading: boolean;
  error: Error | null;
  loginMutation: UseMutationResult<UserWithBranchAccess, Error, LoginData>;
  logoutMutation: UseMutationResult<SignInOptions | null, Error, void>;
  registerMutation: UseMutationResult<UserWithBranchAccess, Error, InsertUser>;
};

type LoginData = { identifier: string; password: string };

export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const {
    data: user,
    error,
    isLoading,
  } = useQuery<UserWithBranchAccess | undefined, Error>({
    queryKey: ["/api/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    select: (data) => {
      console.log("[auth-diag] /api/user query select: typeof=", typeof data, "value=", JSON.stringify(data)?.slice(0, 200));
      return data;
    },
  });

  // SCRUM-653 — a session opened from the launcher carries the person's theme
  // from their suite account; the app paints it and its toggles write back.
  const adoptPlatformTheme = useThemeOptional()?.adoptPlatformTheme;
  useEffect(() => {
    if (user && adoptPlatformTheme) adoptPlatformTheme(user);
  }, [user, adoptPlatformTheme]);

  const loginMutation = useMutation({
    mutationFn: async (credentials: LoginData) => {
      console.log("[auth-diag] POST /api/login");
      const res = await apiRequest("POST", "/api/login", { identifier: credentials.identifier, password: credentials.password });
      const data = await res.json();
      console.log("[auth-diag] POST /api/login response:", JSON.stringify({ id: data?.id, role: data?.role, isActive: data?.isActive }));
      return data;
    },
    onSuccess: (user: UserWithBranchAccess) => {
      console.log("[auth-diag] loginMutation onSuccess: writing user to cache", user?.id);
      queryClient.setQueryData(["/api/user"], user);
      console.log("[auth-diag] /api/user cache is now:", JSON.stringify(queryClient.getQueryData(["/api/user"])));
    },
    onError: (error: Error) => {
      toast({
        title: "Login failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (credentials: InsertUser) => {
      const res = await apiRequest("POST", "/api/register", credentials);
      return await res.json() as UserWithBranchAccess;
    },
    onSuccess: (user: UserWithBranchAccess) => {
      queryClient.setQueryData(["/api/user"], user);
    },
    onError: (error: Error) => {
      toast({
        title: "Registration failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/logout");
      return readSignInOptions(await res.json().catch(() => null));
    },
    onSuccess: (options: SignInOptions | null) => {
      // With the old form switched off, the sign-in page here is a dead end:
      // the way back in is the launcher, when this deployment names it
      // (SCRUM-529). With the form on, or no launcher, as before.
      if (options && !options.legacyLogin && options.launcherUrl) {
        window.location.assign(withSignOutMarker(options.launcherUrl));
        return;
      }
      queryClient.clear();
    },
    onError: (error: Error) => {
      toast({
        title: "Logout failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  console.log("[auth-diag] AuthProvider render: isLoading=", isLoading, "user=", user === undefined ? "undefined" : user === null ? "null" : user?.id);

  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email, username: user.fullName });
    } else if (!isLoading) {
      Sentry.setUser(null);
    }
  }, [user, isLoading]);

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        error,
        loginMutation,
        logoutMutation,
        registerMutation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
