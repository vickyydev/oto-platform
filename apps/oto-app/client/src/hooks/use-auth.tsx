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

type AuthContextType = {
  user: UserWithBranchAccess | null;
  isLoading: boolean;
  error: Error | null;
  loginMutation: UseMutationResult<UserWithBranchAccess, Error, LoginData>;
  logoutMutation: UseMutationResult<void, Error, void>;
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
      await apiRequest("POST", "/api/logout");
    },
    onSuccess: () => {
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
