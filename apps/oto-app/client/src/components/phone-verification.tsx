import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Phone, CheckCircle, XCircle, Shield, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const phoneSchema = z.object({
  phone: z.string().min(8, "Please enter a valid phone number").max(20),
  countryCode: z.string().default("+66"),
});

const otpSchema = z.object({
  code: z.string().length(6, "Please enter the 6-digit code"),
});

type PhoneFormData = z.infer<typeof phoneSchema>;
type OtpFormData = z.infer<typeof otpSchema>;

interface PhoneVerificationProps {
  currentPhone?: string | null;
  isVerified?: boolean;
  verifiedAt?: string | null;
  onVerified?: () => void;
}

export function PhoneVerification({
  currentPhone,
  isVerified = false,
  verifiedAt,
  onVerified,
}: PhoneVerificationProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"view" | "phone" | "otp">("view");
  const [phoneData, setPhoneData] = useState<PhoneFormData | null>(null);
  const [maskedPhone, setMaskedPhone] = useState("");

  const { data: otpStatus } = useQuery({
    queryKey: ["/api/auth/sms-otp/status"],
  });

  const phoneForm = useForm<PhoneFormData>({
    resolver: zodResolver(phoneSchema),
    defaultValues: {
      phone: currentPhone?.replace(/^\+\d+/, "") || "",
      countryCode: "+66",
    },
  });

  const otpForm = useForm<OtpFormData>({
    resolver: zodResolver(otpSchema),
    defaultValues: {
      code: "",
    },
  });

  const requestVerificationMutation = useMutation({
    mutationFn: async (data: PhoneFormData) => {
      const response = await apiRequest("POST", "/api/auth/phone/request-verification", data);
      return response.json();
    },
    onSuccess: (result) => {
      if (result.success) {
        setMaskedPhone(result.maskedPhone);
        setStep("otp");
        toast({
          title: "Code sent",
          description: "A verification code has been sent to your phone.",
        });
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to send verification code",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send verification code",
        variant: "destructive",
      });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (data: OtpFormData) => {
      const response = await apiRequest("POST", "/api/auth/phone/verify", {
        ...phoneData,
        code: data.code,
      });
      return response.json();
    },
    onSuccess: (result) => {
      if (result.success) {
        toast({
          title: "Phone verified",
          description: "Your phone number has been verified successfully.",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/user"] });
        setStep("view");
        onVerified?.();
      } else {
        toast({
          title: "Verification failed",
          description: result.message || "Invalid verification code",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Verification failed",
        variant: "destructive",
      });
    },
  });

  const removePhoneMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", "/api/auth/phone");
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Phone removed",
        description: "Your phone number has been removed from your account.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      setStep("view");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove phone number",
        variant: "destructive",
      });
    },
  });

  const onRequestVerification = async (data: PhoneFormData) => {
    setPhoneData(data);
    requestVerificationMutation.mutate(data);
  };

  const onVerify = async (data: OtpFormData) => {
    verifyMutation.mutate(data);
  };

  if (!otpStatus?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Phone Verification
          </CardTitle>
          <CardDescription>
            SMS verification is not configured. Contact your administrator.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5" />
              Phone Verification
            </CardTitle>
            <CardDescription>
              Verify your phone number to enable password recovery via SMS.
            </CardDescription>
          </div>
          {isVerified && (
            <Badge variant="default" className="bg-green-500 hover:bg-green-600">
              <CheckCircle className="mr-1 h-3 w-3" />
              Verified
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {step === "view" && (
          <div className="space-y-4">
            {currentPhone && isVerified ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Shield className="h-4 w-4 text-green-500" />
                  <span>Phone: {currentPhone}</span>
                </div>
                {verifiedAt && (
                  <p className="text-xs text-muted-foreground">
                    Verified on {new Date(verifiedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setStep("phone")}
                    data-testid="button-change-phone"
                  >
                    Change Number
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid="button-remove-phone">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove Phone Number?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove your verified phone number. You won't be able to reset your password via SMS until you verify a new number.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => removePhoneMutation.mutate()}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ) : currentPhone && !isVerified ? (
              <div className="space-y-3">
                <Alert>
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    Phone {currentPhone} is not verified. Verify it to enable password recovery.
                  </AlertDescription>
                </Alert>
                <Button onClick={() => setStep("phone")} data-testid="button-verify-phone">
                  Verify Phone Number
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  No phone number linked. Add one to enable password recovery via SMS.
                </p>
                <Button onClick={() => setStep("phone")} data-testid="button-add-phone">
                  <Phone className="mr-2 h-4 w-4" />
                  Add Phone Number
                </Button>
              </div>
            )}
          </div>
        )}

        {step === "phone" && (
          <Form {...phoneForm}>
            <form onSubmit={phoneForm.handleSubmit(onRequestVerification)} className="space-y-4">
              <div className="flex gap-2">
                <FormField
                  control={phoneForm.control}
                  name="countryCode"
                  render={({ field }) => (
                    <FormItem className="w-28">
                      <FormLabel>Code</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-phone-country">
                            <SelectValue placeholder="+66" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="+66">+66</SelectItem>
                          <SelectItem value="+1">+1</SelectItem>
                          <SelectItem value="+44">+44</SelectItem>
                          <SelectItem value="+81">+81</SelectItem>
                          <SelectItem value="+65">+65</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={phoneForm.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input
                          type="tel"
                          placeholder="812345678"
                          data-testid="input-phone-number"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("view")}
                  data-testid="button-cancel-phone"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={requestVerificationMutation.isPending}
                  data-testid="button-send-code"
                >
                  {requestVerificationMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Send Verification Code"
                  )}
                </Button>
              </div>
            </form>
          </Form>
        )}

        {step === "otp" && (
          <Form {...otpForm}>
            <form onSubmit={otpForm.handleSubmit(onVerify)} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the 6-digit code sent to {maskedPhone}
              </p>
              <FormField
                control={otpForm.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Verification Code</FormLabel>
                    <FormControl>
                      <InputOTP
                        maxLength={6}
                        value={field.value}
                        onChange={field.onChange}
                        data-testid="input-verification-code"
                      >
                        <InputOTPGroup>
                          <InputOTPSlot index={0} />
                          <InputOTPSlot index={1} />
                          <InputOTPSlot index={2} />
                          <InputOTPSlot index={3} />
                          <InputOTPSlot index={4} />
                          <InputOTPSlot index={5} />
                        </InputOTPGroup>
                      </InputOTP>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("phone")}
                  data-testid="button-back-to-phone"
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={verifyMutation.isPending}
                  data-testid="button-verify-code"
                >
                  {verifyMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => phoneData && requestVerificationMutation.mutate(phoneData)}
                  disabled={requestVerificationMutation.isPending}
                  data-testid="button-resend-code"
                >
                  Resend Code
                </Button>
              </div>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
