import { QueryClient, QueryFunction } from "@tanstack/react-query";

export class ApiError extends Error {
  status: number;
  reasonCode?: string;

  constructor(message: string, status: number, reasonCode?: string) {
    super(message);
    this.status = status;
    this.reasonCode = reasonCode;
    this.name = "ApiError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let message = res.statusText;
    let reasonCode: string | undefined;

    try {
      const body = await res.json();
      message = body.message || body.error || res.statusText;
      reasonCode = body.reasonCode;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }

    throw new ApiError(message, res.status, reasonCode);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;
    console.log(`[auth-diag] fetch ${url}`);
    const res = await fetch(url, {
      credentials: "include",
    });
    console.log(`[auth-diag] fetch ${url} -> ${res.status}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      console.log(`[auth-diag] fetch ${url}: 401, returning null (on401=returnNull)`);
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// When any query returns 401 it means the session has expired or was never
// established (e.g. cookie blocked in Replit iframe).  Clear the cached user
// so the auth context sees null and ProtectedRoute redirects to /auth.  Without
// this the user appears logged in (the login response populated the cache)
// while every data fetch silently fails.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    const err = event.action.error;
    const queryKey = event.query.queryKey;
    console.log(`[auth-diag] query cache error event: key=${JSON.stringify(queryKey)} error=${err instanceof ApiError ? `ApiError(${err.status})` : String(err)}`);
    if (err instanceof ApiError && err.status === 401) {
      console.log(`[auth-diag] 401 from key=${JSON.stringify(queryKey)}, clearing /api/user cache`);
      queryClient.setQueryData(["/api/user"], null);
    }
  }
});
