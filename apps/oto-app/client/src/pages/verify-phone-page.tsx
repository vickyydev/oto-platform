import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Phone, Shield, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function VerifyPhonePage() {
  const { user, refetchUser } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<"phone" | "code" | "success">("phone");
  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber || user?.phoneE164 || "");
  const [otpCode, setOtpCode] = useState("");
  const [error, setError] = useState("");

  const sendOtpMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/phone/request-verification", { phone: phoneNumber });
      return res.json();
    },
    onSuccess: () => {
      setStep("code");
      setError("");
      toast({
        title: "Code Sent",
        description: "A verification code has been sent to your phone.",
      });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to send verification code");
    },
  });

  const verifyOtpMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/phone/verify", { 
        phone: phoneNumber, 
        code: otpCode 
      });
      return res.json();
    },
    onSuccess: async () => {
      setStep("success");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      await refetchUser();
      toast({
        title: "Phone Verified",
        description: "Your phone number has been verified successfully.",
      });
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    },
    onError: (err: Error) => {
      setError(err.message || "Invalid verification code");
    },
  });

  const handleSendCode = () => {
    if (!phoneNumber.trim()) {
      setError("Please enter your phone number");
      return;
    }
    setError("");
    sendOtpMutation.mutate();
  };

  const handleVerifyCode = () => {
    if (!otpCode.trim() || otpCode.length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }
    setError("");
    verifyOtpMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            {step === "success" ? (
              <CheckCircle2 className="h-6 w-6 text-primary" />
            ) : (
              <Shield className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle>
            {step === "success" ? "Phone Verified!" : "Verify Your Phone"}
          </CardTitle>
          <CardDescription>
            {step === "phone" && "We need to verify your phone number for account security. This allows you to reset your password via SMS if needed."}
            {step === "code" && "Enter the 6-digit code we sent to your phone."}
            {step === "success" && "Your account is now set up. Redirecting..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "phone" && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Phone Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    placeholder="+66812345678"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="pl-10"
                    data-testid="input-phone-number"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter your phone number in international format (e.g., +66812345678)
                </p>
              </div>
              <Button 
                onClick={handleSendCode} 
                className="w-full"
                disabled={sendOtpMutation.isPending}
                data-testid="button-send-code"
              >
                {sendOtpMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Verification Code
              </Button>
            </>
          )}

          {step === "code" && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Verification Code</label>
                <Input
                  type="text"
                  placeholder="123456"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="text-center text-2xl tracking-widest"
                  maxLength={6}
                  data-testid="input-otp-code"
                />
                <p className="text-xs text-muted-foreground text-center">
                  Code sent to {phoneNumber}
                </p>
              </div>
              <Button 
                onClick={handleVerifyCode} 
                className="w-full"
                disabled={verifyOtpMutation.isPending}
                data-testid="button-verify-code"
              >
                {verifyOtpMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Verify Code
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep("phone");
                  setOtpCode("");
                  setError("");
                }}
                className="w-full"
                data-testid="button-back"
              >
                Use Different Number
              </Button>
            </>
          )}

          {step === "success" && (
            <div className="flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
