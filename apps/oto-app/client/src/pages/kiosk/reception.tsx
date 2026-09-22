import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, XCircle, Smartphone, QrCode, CheckCircle2, WifiOff } from "lucide-react";
import { CheckinsContent } from "@/pages/core/checkins";

interface KioskSession {
  token: string;
  expiresAt: string;
  // Sent only by the activation exchange, never by a refresh.
  deviceSecret?: string;
  device: {
    id: string;
    name: string | null;
    branchId: string;
  };
}

// The secret this kiosk was handed when its QR code was scanned. It is what a
// silent reconnect proves; the device id travels in responses and is not a
// credential on its own.
const DEVICE_SECRET_KEY = "kiosk_reception_device_secret";

interface BranchInfo {
  id: string;
  name: string;
  logoUrl?: string | null;
}

export default function ReceptionKiosk() {
  const [status, setStatus] = useState<"loading" | "activating" | "active" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [isConnectivityError, setIsConnectivityError] = useState(false);
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [kioskToken, setKioskToken] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");

      if (code) {
        // First-time QR activation flow
        setStatus("activating");
        try {
          const response = await fetch("/api/kiosk/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.message || "Failed to activate kiosk");
          }

          const session: KioskSession = await response.json();
          localStorage.setItem("kiosk_session_token", session.token);
          localStorage.setItem("kiosk_device_id", session.device.id);
          if (session.deviceSecret) {
            localStorage.setItem(DEVICE_SECRET_KEY, session.deviceSecret);
          }
          setKioskToken(session.token);

          const branchResponse = await fetch("/api/kiosk-reception/branch", {
            headers: { "Authorization": `Bearer ${session.token}` },
          });

          if (branchResponse.ok) {
            const branch = await branchResponse.json();
            setBranchInfo(branch);
          }

          window.history.replaceState({}, "", "/kiosk/reception");
          setStatus("active");
        } catch (e) {
          setError(e instanceof Error ? e.message : "Activation failed");
          setStatus("error");
        }
        return;
      }

      // No QR code — try to restore an existing session
      const existingToken = localStorage.getItem("kiosk_session_token");
      if (existingToken) {
        try {
          const response = await fetch("/api/kiosk-reception/session", {
            headers: { "Authorization": `Bearer ${existingToken}` },
          });

          if (response.ok) {
            const session = await response.json();
            setBranchInfo({ id: session.branchId, name: session.branchName });
            setKioskToken(existingToken);
            setStatus("active");
            return;
          }
        } catch (e) {
          // network error — fall through to refresh attempt below
        }
        // Token is invalid or network failed; remove it
        localStorage.removeItem("kiosk_session_token");
      }

      // Session token is missing or invalid — try silent auto-reconnect via device ID
      // A reconnect needs both halves. A kiosk activated before device secrets
      // existed has the id but no secret, and has to be activated again.
      const storedDeviceId = localStorage.getItem("kiosk_device_id");
      const storedDeviceSecret = localStorage.getItem(DEVICE_SECRET_KEY);
      if (storedDeviceId && storedDeviceSecret) {
        try {
          const refreshResponse = await fetch("/api/kiosk/refresh-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: storedDeviceId, deviceSecret: storedDeviceSecret }),
          });

          if (refreshResponse.ok) {
            const refreshed: KioskSession = await refreshResponse.json();
            localStorage.setItem("kiosk_session_token", refreshed.token);
            setKioskToken(refreshed.token);

            const branchResponse = await fetch("/api/kiosk-reception/branch", {
              headers: { "Authorization": `Bearer ${refreshed.token}` },
            });

            if (branchResponse.ok) {
              const branch = await branchResponse.json();
              setBranchInfo(branch);
            } else {
              setBranchInfo({ id: refreshed.device.branchId, name: "Reception Kiosk" });
            }

            setStatus("active");
            return;
          } else if (refreshResponse.status === 401) {
            // Explicit deactivation, device not found, or a secret that did not
            // verify — clear all three keys so staff knows a new QR code is needed
            localStorage.removeItem("kiosk_session_token");
            localStorage.removeItem("kiosk_device_id");
            localStorage.removeItem(DEVICE_SECRET_KEY);
          }
          // For transient server errors (5xx, etc.), preserve kiosk_device_id so
          // the next page load can retry auto-reconnect automatically
        } catch (e) {
          // network error during refresh — preserve device ID for next retry
        }
      }

      // If both halves are still stored, the refresh failed transiently
      // (network/5xx); show a connectivity error instead of asking staff to scan
      // a new QR code. With the secret missing there is nothing to retry with,
      // so fall through to the QR prompt.
      if (localStorage.getItem("kiosk_device_id") && localStorage.getItem(DEVICE_SECRET_KEY)) {
        setIsConnectivityError(true);
        setError("Unable to connect. Please check the network and reload this page.");
      } else {
        setIsConnectivityError(false);
        setError("No activation code provided. Please scan the QR code from the admin panel.");
      }
      setStatus("error");
    };

    init();
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30" data-testid="kiosk-loading">
        <Card className="w-[400px]">
          <CardContent className="pt-6 flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Checking session...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "activating") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30" data-testid="kiosk-activating">
        <Card className="w-[400px]">
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2">
              <Smartphone className="h-5 w-5" />
              Activating Kiosk
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">Please wait while we set up this device...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30" data-testid="kiosk-error">
        <Card className="w-[450px]">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              {isConnectivityError
                ? <WifiOff className="h-12 w-12 text-destructive" />
                : <XCircle className="h-12 w-12 text-destructive" />
              }
            </div>
            <CardTitle>{isConnectivityError ? "Connection Error" : "Activation Failed"}</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          {!isConnectivityError && (
            <CardContent className="flex flex-col items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <QrCode className="h-4 w-4" />
                <span>Please ask your manager to generate a new QR code</span>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background" data-testid="kiosk-active">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <img src="/oto-logo.png" alt="OTO" className="h-8 w-auto flex-shrink-0" />
        <div className="flex-1">
          <span className="font-semibold">{branchInfo?.name || "Reception Kiosk"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-green-600">
          <CheckCircle2 className="h-4 w-4" />
          <span className="text-sm font-medium">Active</span>
        </div>
      </header>
      
      <main className="flex-1 overflow-auto">
        {kioskToken && branchInfo && (
          <CheckinsContent
            kioskMode={true}
            kioskToken={kioskToken}
            kioskBranchId={branchInfo.id}
          />
        )}
      </main>
    </div>
  );
}
