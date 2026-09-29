import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { normalizeEnrollmentIdentity, type KioskEnrollmentIdentity } from "@/lib/kiosk-enrollment";
import { Camera, QrCode, Clock, CheckCircle, XCircle, User, ArrowLeft, Fingerprint, AlertTriangle, Keyboard, RefreshCw, Loader2 } from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";

type KioskScreen = "home" | "clock" | "enroll-scan" | "enroll-consent" | "enroll-capture" | "phone-photo" | "phone-entry" | "success" | "error" | "missed-clock-in" | "missed-clock-manual" | "unscheduled-work" | "unscheduled-work-confirm";

interface UnscheduledWorkData {
  employee: {
    id: string;
    fullName: string;
  };
  branch: {
    id: string;
    name: string;
  };
  currentTime: string;
  confidenceScore?: number;
  livenessScore?: number;
  kioskDeviceId?: string;
}

interface MissedClockInData {
  employee: {
    id: string;
    fullName: string;
  };
  schedule: {
    branchId: string;
    branchName: string;
    scheduledStart: string;
    scheduledEnd: string;
    shiftDate: string;
  };
  confidenceScore?: number;
  livenessScore?: number;
  kioskDeviceId?: string;
  branchId: string;
}

interface ClockResult {
  eventType: "IN" | "OUT";
  eventTime: string;
  employee: {
    id: string;
    fullName: string;
  };
  identityType?: "EMPLOYEE" | "ADVISOR";
  lateArrival?: {
    isLate: boolean;
    lateMinutes: number;
    scheduledStart: string;
  };
}

interface KioskPageProps {
  branchId?: string;
}

export default function KioskPage({ branchId }: KioskPageProps) {
  const { toast } = useToast();
  const [screen, setScreen] = useState<KioskScreen>("home");
  
  // Fetch branch info from public endpoint (no auth required for kiosk)
  const { data: branch, isLoading: branchLoading, error: branchError } = useQuery<{ id: string; name: string; logoUrl: string | null }>({
    queryKey: [`/api/public/branches/${branchId}`],
    enabled: !!branchId,
  });
  
  const branchName = branch?.name || "Loading...";
  const [enrollmentToken, setEnrollmentToken] = useState("");
  const [enrollmentData, setEnrollmentData] = useState<KioskEnrollmentIdentity | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [faceAttempts, setFaceAttempts] = useState(0);
  const [phoneValue, setPhoneValue] = useState("");
  const [clockResult, setClockResult] = useState<ClockResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [qrScannerActive, setQrScannerActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const [qrCameraFacing, setQrCameraFacing] = useState<"user" | "environment">("environment");
  const [failedPhotoData, setFailedPhotoData] = useState<string | null>(null);
  const [failedPhotoFile, setFailedPhotoFile] = useState<File | null>(null);
  const [missedClockInData, setMissedClockInData] = useState<MissedClockInData | null>(null);
  const [manualClockInTime, setManualClockInTime] = useState("");
  const [missedClockReason, setMissedClockReason] = useState<string>("FORGOT_TO_CLOCK_IN");
  const [missedClockNote, setMissedClockNote] = useState("");
  const [unscheduledWorkData, setUnscheduledWorkData] = useState<UnscheduledWorkData | null>(null);
  const [unscheduledReason, setUnscheduledReason] = useState<string>("MANAGER_INSTRUCTED");
  const [unscheduledNote, setUnscheduledNote] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  const enrollmentVerificationRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);

  const stopQrScanner = useCallback(async () => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
        qrScannerRef.current.clear();
      } catch (e) {
        // Scanner may not be running
      }
      qrScannerRef.current = null;
    }
    setQrScannerActive(false);
  }, []);

  const resetToHome = useCallback(() => {
    stopQrScanner();
    stopCamera();
    setScreen("home");
    setEnrollmentToken("");
    setEnrollmentData(null);
    enrollmentVerificationRef.current = false;
    setConsentGiven(false);
    setFaceAttempts(0);
    setPhoneValue("");
    setClockResult(null);
    setErrorMessage("");
    setIsProcessing(false);
    setShowManualEntry(false);
    setCameraFacing("user");
    setFailedPhotoData(null);
    setFailedPhotoFile(null);
    setMissedClockInData(null);
    setManualClockInTime("");
    setMissedClockReason("FORGOT_TO_CLOCK_IN");
    setMissedClockNote("");
    setUnscheduledWorkData(null);
    setUnscheduledReason("MANAGER_INSTRUCTED");
    setUnscheduledNote("");
  }, [stopQrScanner]);

  const showSuccessScreen = (result: ClockResult) => {
    setClockResult(result);
    setScreen("success");
    setTimeout(resetToHome, 5000);
  };

  const showErrorScreen = (message: string) => {
    setErrorMessage(message);
    setScreen("error");
    setTimeout(resetToHome, 5000);
  };

  const startCamera = async (facing?: "user" | "environment") => {
    const facingMode = facing || cameraFacing;
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } } 
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      console.error("Camera access denied:", err);
      toast({ title: "Camera Error", description: "Unable to access camera", variant: "destructive" });
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    if (streamRef.current && videoRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [screen]);

  const toggleCamera = async () => {
    const newFacing = cameraFacing === "user" ? "environment" : "user";
    setCameraFacing(newFacing);
    await startCamera(newFacing);
  };

  const capturePhoto = (): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.8);
    }
    return null;
  };

  const handleClockStart = async () => {
    setScreen("clock");
    setFaceAttempts(0);
    await startCamera();
  };

  const captureMultipleFrames = async (frameCount: number, intervalMs: number): Promise<string[]> => {
    const frames: string[] = [];
    for (let i = 0; i < frameCount; i++) {
      const frame = capturePhoto();
      if (frame) {
        frames.push(frame);
      }
      if (i < frameCount - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    return frames;
  };

  const handleFaceAttempt = async () => {
    setIsProcessing(true);
    const newAttempts = faceAttempts + 1;
    setFaceAttempts(newAttempts);

    // Capture multiple frames for liveness detection (5 frames over ~1 second)
    const faceFramesBase64 = await captureMultipleFrames(5, 200);
    
    if (faceFramesBase64.length < 3) {
      toast({ title: "Failed to capture sufficient frames", variant: "destructive" });
      setIsProcessing(false);
      return;
    }

    // Use the last frame as the primary image for face matching
    const faceImageBase64 = faceFramesBase64[faceFramesBase64.length - 1];

    try {
      // Call face-first identification API with multi-frame liveness data
      const res = await apiRequest("POST", "/api/kiosk/identify-face", {
        faceImageBase64,
        faceFramesBase64,
        deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
      });
      const result = await res.json();

      if (result.success && result.matched && (result.employee || result.advisor)) {
        // Face matched - now clock in/out
        const isAdvisor = result.identityType === "ADVISOR";
        const clockRes = await apiRequest("POST", isAdvisor ? "/api/kiosk/advisor-clock" : "/api/kiosk/clock", isAdvisor ? {
          identificationProof: result.identificationProof,
          confidenceScore: result.confidence,
          livenessScore: result.livenessScore,
          deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
        } : {
          employeeId: result.employee.id,
          confidenceScore: result.confidence,
          livenessScore: result.livenessScore,
          deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
        });
        const clockData = await clockRes.json();
        
        // Check for missed clock-in scenario
        if (clockData.success && clockData.missedClockIn) {
          stopCamera();
          setMissedClockInData({
            employee: clockData.employee,
            schedule: clockData.schedule,
            confidenceScore: result.confidence,
            livenessScore: clockData.livenessScore,
            kioskDeviceId: clockData.kioskDeviceId,
            branchId: clockData.branchId,
          });
          // Set default manual time to scheduled start
          const scheduledStart = new Date(clockData.schedule.scheduledStart);
          setManualClockInTime(scheduledStart.toTimeString().slice(0, 5));
          setScreen("missed-clock-in");
          setIsProcessing(false);
          return;
        }

        // Check for unscheduled work scenario (no shift scheduled today)
        if (clockData.success && clockData.unscheduledWork) {
          stopCamera();
          setUnscheduledWorkData({
            employee: clockData.employee,
            branch: clockData.branch,
            currentTime: clockData.currentTime,
            confidenceScore: result.confidence,
            livenessScore: clockData.livenessScore,
            kioskDeviceId: clockData.kioskDeviceId,
          });
          setScreen("unscheduled-work");
          setIsProcessing(false);
          return;
        }
        
        stopCamera();
        showSuccessScreen({
          eventType: clockData.eventType,
          eventTime: clockData.eventTime,
          employee: {
            id: isAdvisor ? result.advisor.id : result.employee.id,
            fullName: isAdvisor ? result.advisor.fullName : result.employee.fullName,
          },
          identityType: isAdvisor ? "ADVISOR" : "EMPLOYEE",
          lateArrival: clockData.lateArrival,
        });
      } else if (result.livenessFailed) {
        // Liveness check failed - show specific message and allow retry
        toast({
          title: "Verification Failed",
          description: result.message || "Please face the camera directly and stay still.",
          variant: "destructive",
        });
        // Don't count liveness failures toward the 3-attempt limit
        setFaceAttempts(newAttempts - 1);
      } else {
        // Face not matched
        if (newAttempts >= 3) {
          setFailedPhotoData(faceImageBase64);
          setScreen("phone-photo");
          toast({
            title: "Face recognition failed",
            description: "Photo required for phone verification",
          });
        } else {
          toast({
            title: `Try again (${newAttempts}/3)`,
            description: result.message || "Face not recognized",
            variant: "destructive",
          });
        }
      }
    } catch (error: any) {
      if (newAttempts >= 3) {
        setFailedPhotoData(faceImageBase64);
        setScreen("phone-photo");
        toast({
          title: "Face recognition failed",
          description: "Photo required for phone verification",
        });
      } else {
        toast({
          title: `Try again (${newAttempts}/3)`,
          description: error.message || "Face not recognized",
          variant: "destructive",
        });
      }
    }
    setIsProcessing(false);
  };

  const handlePhonePhotoCapture = () => {
    if (!videoRef.current || !canvasRef.current) {
      toast({ title: "Photo capture failed", variant: "destructive" });
      return;
    }
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      toast({ title: "Photo capture failed", variant: "destructive" });
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `fallback-photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setFailedPhotoFile(file);
        setFailedPhotoData(URL.createObjectURL(blob));
        stopCamera();
        setScreen("phone-entry");
      } else {
        toast({ title: "Photo capture failed", variant: "destructive" });
      }
    }, "image/jpeg", 0.8);
  };

  const handlePhoneSubmit = async () => {
    if (phoneValue.length < 9) {
      toast({ title: "Enter a valid phone number", variant: "destructive" });
      return;
    }

    setIsProcessing(true);
    try {
      let photoEvidenceUrl = "";
      if (failedPhotoFile) {
        try {
          const formData = new FormData();
          formData.append("photo", failedPhotoFile);
          const uploadRes = await fetch("/api/kiosk/upload-pin-photo", {
            method: "POST",
            headers: { "x-kiosk-device-secret": localStorage.getItem("kiosk_device_secret") || "" },
            body: formData,
          });
          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            if (uploadData.success) {
              photoEvidenceUrl = uploadData.photoUrl;
            }
          }
        } catch (uploadError) {
          console.error("Failed to upload phone fallback photo:", uploadError);
        }
      } else if (failedPhotoData && failedPhotoData.startsWith("data:")) {
        try {
          const uploadRes = await fetch("/api/kiosk/upload-pin-photo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-kiosk-device-secret": localStorage.getItem("kiosk_device_secret") || "",
            },
            body: JSON.stringify({ photoData: failedPhotoData }),
          });
          const uploadData = await uploadRes.json();
          if (uploadData.success) {
            photoEvidenceUrl = uploadData.photoUrl;
          }
        } catch (uploadError) {
          console.error("Failed to upload phone fallback photo:", uploadError);
        }
      }
      
      const res = await apiRequest("POST", "/api/kiosk/clock-phone", {
        phone: phoneValue,
        photoEvidenceUrl,
        deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
      });
      const data = await res.json();
      if (data.success) {
        showSuccessScreen({
          eventType: data.eventType,
          eventTime: data.eventTime,
          employee: data.advisor || data.employee,
          identityType: data.identityType,
        });
      } else {
        showErrorScreen(data.message || "Phone verification failed");
      }
    } catch (error: any) {
      showErrorScreen(error.message || "Phone verification failed");
    }
    setIsProcessing(false);
  };

  // Handle missed clock-in auto-fix (Option A)
  const handleMissedClockAutoFix = async () => {
    if (!missedClockInData) return;
    
    setIsProcessing(true);
    try {
      const res = await apiRequest("POST", "/api/kiosk/missed-clock/auto-fix", {
        employeeId: missedClockInData.employee.id,
        branchId: missedClockInData.branchId,
        scheduledStart: missedClockInData.schedule.scheduledStart,
        scheduledEnd: missedClockInData.schedule.scheduledEnd,
        shiftDate: missedClockInData.schedule.shiftDate,
        confidenceScore: missedClockInData.confidenceScore,
        livenessScore: missedClockInData.livenessScore,
        kioskDeviceId: missedClockInData.kioskDeviceId,
        deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
      });
      const data = await res.json();
      
      if (data.success) {
        setClockResult({
          eventType: data.eventType,
          eventTime: data.clockOutAt,
          employee: data.employee,
        });
        setScreen("success");
        toast({
          title: "Clock-out recorded",
          description: "Missing clock-in was auto-fixed from your schedule.",
        });
        setTimeout(resetToHome, 5000);
      } else {
        showErrorScreen(data.message || "Failed to process");
      }
    } catch (error: any) {
      showErrorScreen(error.message || "Failed to process");
    }
    setIsProcessing(false);
  };

  // Handle missed clock-in manual (Option B)
  const handleMissedClockManual = async () => {
    if (!missedClockInData) return;
    
    setIsProcessing(true);
    try {
      // Convert time input (HH:MM) to full datetime using shift date
      // Use Thailand timezone (+07:00) since that's the local time the user entered
      const shiftDate = missedClockInData.schedule.shiftDate;
      const userClockInAt = new Date(`${shiftDate}T${manualClockInTime}:00+07:00`);
      
      const res = await apiRequest("POST", "/api/kiosk/missed-clock/manual", {
        employeeId: missedClockInData.employee.id,
        branchId: missedClockInData.branchId,
        scheduledStart: missedClockInData.schedule.scheduledStart,
        scheduledEnd: missedClockInData.schedule.scheduledEnd,
        shiftDate: missedClockInData.schedule.shiftDate,
        userClockInAt: userClockInAt.toISOString(),
        reasonCode: missedClockReason,
        note: missedClockNote || undefined,
        confidenceScore: missedClockInData.confidenceScore,
        livenessScore: missedClockInData.livenessScore,
        kioskDeviceId: missedClockInData.kioskDeviceId,
        deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
      });
      const data = await res.json();
      
      if (data.success) {
        setClockResult({
          eventType: data.eventType,
          eventTime: data.clockOutAt,
          employee: data.employee,
        });
        setScreen("success");
        toast({
          title: "Clock-out recorded",
          description: "Your start time change needs manager approval.",
        });
        setTimeout(resetToHome, 5000);
      } else {
        showErrorScreen(data.message || "Failed to process");
      }
    } catch (error: any) {
      showErrorScreen(error.message || "Failed to process");
    }
    setIsProcessing(false);
  };

  // Handle unscheduled work clock-in confirmation
  const handleUnscheduledWorkSubmit = async () => {
    if (!unscheduledWorkData) return;
    
    setIsProcessing(true);
    try {
      const res = await apiRequest("POST", "/api/kiosk/unscheduled-clock-in", {
        employeeId: unscheduledWorkData.employee.id,
        branchId: unscheduledWorkData.branch.id,
        reasonCode: unscheduledReason,
        note: unscheduledNote || undefined,
        confidenceScore: unscheduledWorkData.confidenceScore,
        livenessScore: unscheduledWorkData.livenessScore,
        kioskDeviceId: unscheduledWorkData.kioskDeviceId,
        deviceSecret: localStorage.getItem("kiosk_device_secret") || undefined,
      });
      const data = await res.json();
      
      if (data.success) {
        setClockResult({
          eventType: 'IN',
          eventTime: data.eventTime,
          employee: data.employee,
        });
        setScreen("success");
        toast({
          title: "Clock-in recorded",
          description: "Your unscheduled work has been sent for manager review.",
        });
        setTimeout(resetToHome, 5000);
      } else {
        showErrorScreen(data.message || "Failed to process");
      }
    } catch (error: any) {
      showErrorScreen(error.message || "Failed to process");
    }
    setIsProcessing(false);
  };

  const handleEnrollScan = () => {
    setScreen("enroll-scan");
  };

  const handleEnrollTokenSubmit = async (token?: string) => {
    const tokenToUse = token || enrollmentToken;
    if (!tokenToUse.trim()) {
      toast({ title: "Please enter enrollment token", variant: "destructive" });
      return;
    }

    if (enrollmentVerificationRef.current) return;
    enrollmentVerificationRef.current = true;
    setIsProcessing(true);
    try {
      await stopQrScanner();
      const res = await apiRequest("POST", "/api/kiosk/verify-enrollment-token", {
        token: tokenToUse,
      });
      const data = normalizeEnrollmentIdentity(await res.json(), tokenToUse);
      setEnrollmentData(data);
      setScreen("enroll-consent");
    } catch (error: any) {
      setEnrollmentData(null);
      toast({ title: "Invalid token", description: error.message, variant: "destructive" });
      if (!showManualEntry) {
        await startQrScanner(qrCameraFacing);
      }
    } finally {
      enrollmentVerificationRef.current = false;
      setIsProcessing(false);
    }
  };

  const startQrScanner = useCallback(async (facingMode: "user" | "environment" = "environment") => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
        qrScannerRef.current.clear();
      } catch (e) {
        // Scanner may not be running
      }
      qrScannerRef.current = null;
    }
    
    try {
      const html5QrCode = new Html5Qrcode("qr-reader");
      qrScannerRef.current = html5QrCode;
      
      await html5QrCode.start(
        { facingMode },
        {
          fps: 10,
          qrbox: { width: 220, height: 220 },
          aspectRatio: 1.0,
        },
        async (decodedText) => {
          // QR code scanned successfully
          setEnrollmentToken(decodedText);
          await handleEnrollTokenSubmit(decodedText);
        },
        () => {
          // Scan error - ignore, just keep scanning
        }
      );
      setQrScannerActive(true);
    } catch (err) {
      console.error("Failed to start QR scanner:", err);
      toast({ 
        title: "Camera access required", 
        description: "Please allow camera access to scan QR codes, or enter the token manually.",
        variant: "destructive" 
      });
      setShowManualEntry(true);
    }
  }, [toast]);

  const toggleQrCamera = useCallback(async () => {
    const newFacing = qrCameraFacing === "user" ? "environment" : "user";
    setQrCameraFacing(newFacing);
    await startQrScanner(newFacing);
  }, [qrCameraFacing, startQrScanner]);

  useEffect(() => {
    if (screen === "enroll-scan" && !showManualEntry) {
      startQrScanner(qrCameraFacing);
    }
    return () => {
      if (screen !== "enroll-scan") {
        stopQrScanner();
      }
    };
  }, [screen, showManualEntry, startQrScanner, stopQrScanner]);

  const handleEnrollConsent = async () => {
    if (!consentGiven) {
      toast({ title: "Consent required", description: "Please check the consent box", variant: "destructive" });
      return;
    }
    setScreen("enroll-capture");
    await startCamera();
  };

  const handleEnrollCapture = async () => {
    setIsProcessing(true);
    try {
      // Capture face image before stopping camera
      const faceImageBase64 = capturePhoto();
      if (!faceImageBase64) {
        toast({ title: "Failed to capture face", variant: "destructive" });
        setIsProcessing(false);
        return;
      }
      
      stopCamera();
      await apiRequest("POST", "/api/kiosk/complete-enrollment", {
        sessionId: enrollmentData?.sessionId,
        enrollmentToken: enrollmentData?.token,
        faceImageBase64,
        consentGiven: true,
      });
      setClockResult(null);
      setScreen("success");
      setErrorMessage("");
      setTimeout(resetToHome, 5000);
    } catch (error: any) {
      showErrorScreen(error.message || "Enrollment failed");
    }
    setIsProcessing(false);
  };

  const handlePhoneDigit = (digit: string) => {
    if (phoneValue.length < 15) {
      setPhoneValue(prev => prev + digit);
    }
  };

  const handlePhoneBackspace = () => {
    setPhoneValue(prev => prev.slice(0, -1));
  };

  // Show error if no branchId provided
  if (!branchId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 to-indigo-900 flex flex-col items-center justify-center p-4">
        <Card className="p-8 max-w-md">
          <CardContent className="text-center space-y-4 pt-6">
            <AlertTriangle className="h-16 w-16 mx-auto text-destructive" />
            <h1 className="text-2xl font-bold">Invalid Kiosk URL</h1>
            <p className="text-muted-foreground">
              This kiosk requires a valid branch ID. Please contact your administrator for the correct kiosk URL.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show loading while fetching branch
  if (branchLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 to-indigo-900 flex flex-col items-center justify-center p-4">
        <Card className="p-8 max-w-md">
          <CardContent className="text-center space-y-4 pt-6">
            <Loader2 className="h-16 w-16 mx-auto animate-spin text-primary" />
            <h1 className="text-2xl font-bold">Loading Kiosk...</h1>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show error if branch not found
  if (branchError || !branch) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 to-indigo-900 flex flex-col items-center justify-center p-4">
        <Card className="p-8 max-w-md">
          <CardContent className="text-center space-y-4 pt-6">
            <XCircle className="h-16 w-16 mx-auto text-destructive" />
            <h1 className="text-2xl font-bold">Branch Not Found</h1>
            <p className="text-muted-foreground">
              The specified branch could not be found. Please check the URL or contact your administrator.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 to-indigo-900 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-6">
          <Badge variant="secondary" className="text-lg px-4 py-2">
            {branchName}
          </Badge>
        </div>

        {screen === "home" && (
          <Card className="p-8">
            <CardContent className="space-y-6 pt-6">
              <h1 className="text-4xl font-bold text-center mb-8">Time Clock</h1>
              <Button 
                size="lg" 
                className="w-full h-24 text-2xl"
                onClick={handleClockStart}
                data-testid="button-clock-in-out"
              >
                <Clock className="mr-4 h-10 w-10" />
                Clock In / Out
              </Button>
              <Button 
                variant="outline" 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleEnrollScan}
                data-testid="button-enroll-face"
              >
                <QrCode className="mr-3 h-8 w-8" />
                Enroll Face (Scan QR)
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "clock" && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Face Recognition</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="relative aspect-[3/4] bg-black rounded-lg overflow-hidden">
                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                {/* Oval face guide overlay */}
                <div className="absolute inset-0 pointer-events-none">
                  <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                      <mask id="face-mask-clock">
                        <rect x="0" y="0" width="100" height="100" fill="white"/>
                        <ellipse cx="50" cy="45" rx="28" ry="35" fill="black"/>
                      </mask>
                    </defs>
                    <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0.5)" mask="url(#face-mask-clock)"/>
                    <ellipse cx="50" cy="45" rx="28" ry="35" fill="none" stroke="white" strokeWidth="0.5" strokeDasharray="2,1"/>
                  </svg>
                </div>
                <div className="absolute top-4 right-4 flex gap-2">
                  <Button 
                    variant="secondary" 
                    size="icon" 
                    onClick={toggleCamera}
                    className="bg-black/50 hover:bg-black/70"
                    data-testid="button-toggle-camera"
                  >
                    <RefreshCw className="h-5 w-5 text-white" />
                  </Button>
                  <Badge variant={faceAttempts === 0 ? "secondary" : faceAttempts >= 3 ? "destructive" : "outline"}>
                    Attempt {faceAttempts}/3
                  </Badge>
                </div>
                <p className="absolute bottom-4 left-0 right-0 text-center text-white text-sm drop-shadow-lg">
                  Position your face in the oval
                </p>
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleFaceAttempt}
                disabled={isProcessing}
                data-testid="button-capture-face"
              >
                <Camera className="mr-3 h-6 w-6" />
                {isProcessing ? "Processing..." : "Capture Face"}
              </Button>
              {faceAttempts > 0 && faceAttempts < 3 && (
                <p className="text-center text-muted-foreground">
                  Face not recognized. Try again or enter phone number after 3 attempts.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {screen === "phone-photo" && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl flex items-center gap-2">
                <AlertTriangle className="h-6 w-6 text-amber-500" />
                Photo Required
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-lg text-center">
                Face recognition failed 3 times. A photo is required before phone entry.
              </p>
              <div className="relative aspect-[3/4] bg-black rounded-lg overflow-hidden">
                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                <div className="absolute inset-0 pointer-events-none">
                  <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                      <mask id="face-mask-phone">
                        <rect x="0" y="0" width="100" height="100" fill="white"/>
                        <ellipse cx="50" cy="45" rx="28" ry="35" fill="black"/>
                      </mask>
                    </defs>
                    <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0.5)" mask="url(#face-mask-phone)"/>
                    <ellipse cx="50" cy="45" rx="28" ry="35" fill="none" stroke="white" strokeWidth="0.5" strokeDasharray="2,1"/>
                  </svg>
                </div>
                <div className="absolute top-4 right-4">
                  <Button 
                    variant="secondary" 
                    size="icon" 
                    onClick={toggleCamera}
                    className="bg-black/50 hover:bg-black/70"
                    data-testid="button-toggle-camera-phone"
                  >
                    <RefreshCw className="h-5 w-5 text-white" />
                  </Button>
                </div>
                <p className="absolute bottom-4 left-0 right-0 text-center text-white text-sm drop-shadow-lg">
                  Position your face in the oval
                </p>
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handlePhonePhotoCapture}
                data-testid="button-capture-photo"
              >
                <Camera className="mr-3 h-6 w-6" />
                Capture Photo & Enter Phone Number
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "phone-entry" && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Keyboard className="h-6 w-6" />
                Enter Phone Number
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-muted-foreground text-center">
                Enter your registered phone number (e.g. 0812345678)
              </p>
              <div className="text-center">
                <Input 
                  type="tel" 
                  value={phoneValue} 
                  readOnly 
                  className="text-3xl text-center tracking-widest h-16 font-mono"
                  placeholder="0XX-XXX-XXXX"
                  data-testid="input-phone"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"].map((digit, idx) => (
                  <Button
                    key={idx}
                    variant={digit === "⌫" ? "outline" : "secondary"}
                    size="lg"
                    className="h-16 text-2xl"
                    onClick={() => digit === "⌫" ? handlePhoneBackspace() : handlePhoneDigit(digit)}
                    data-testid={`button-phone-${digit === "+" ? "plus" : digit === "⌫" ? "backspace" : digit}`}
                  >
                    {digit}
                  </Button>
                ))}
              </div>
              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handlePhoneSubmit}
                disabled={isProcessing || phoneValue.length < 9}
                data-testid="button-submit-phone"
              >
                {isProcessing ? "Verifying..." : "Clock In / Out"}
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "enroll-scan" && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Scan Enrollment QR</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {!showManualEntry ? (
                <>
                  <p className="text-lg text-center text-muted-foreground">
                    Point your camera at the enrollment QR code
                  </p>
                  <div className="relative aspect-square bg-black rounded-lg overflow-hidden mx-auto max-w-sm">
                    <div id="qr-reader" className={`w-full h-full [&_video]:object-cover [&_video]:w-full [&_video]:h-full${qrCameraFacing === "user" ? " [&_video]:[transform:scaleX(-1)]" : ""}`} />
                    {!qrScannerActive && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Camera className="h-16 w-16 text-muted-foreground animate-pulse" />
                      </div>
                    )}
                    <div className="absolute top-4 right-4">
                      <Button 
                        variant="secondary" 
                        size="icon" 
                        onClick={toggleQrCamera}
                        className="bg-black/50 hover:bg-black/70"
                        data-testid="button-toggle-qr-camera"
                      >
                        <RefreshCw className="h-5 w-5 text-white" />
                      </Button>
                    </div>
                  </div>
                  <Button 
                    variant="outline"
                    size="lg" 
                    className="w-full h-14"
                    onClick={() => {
                      stopQrScanner();
                      setShowManualEntry(true);
                    }}
                    data-testid="button-manual-entry"
                  >
                    <Keyboard className="mr-2 h-5 w-5" />
                    Enter Token Manually
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-lg text-center text-muted-foreground">
                    Enter the enrollment token from your QR code
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="token">Enrollment Token</Label>
                    <Input 
                      id="token"
                      value={enrollmentToken}
                      onChange={(e) => setEnrollmentToken(e.target.value)}
                      placeholder="Enter token..."
                      className="text-lg h-14"
                      data-testid="input-enrollment-token"
                    />
                  </div>
                  <Button 
                    size="lg" 
                    className="w-full h-16 text-xl"
                    onClick={() => handleEnrollTokenSubmit()}
                    disabled={isProcessing}
                    data-testid="button-verify-token"
                  >
                    {isProcessing ? "Verifying..." : "Verify Token"}
                  </Button>
                  <Button 
                    variant="outline"
                    size="lg" 
                    className="w-full h-14"
                    onClick={() => {
                      setShowManualEntry(false);
                      startQrScanner();
                    }}
                    data-testid="button-scan-qr"
                  >
                    <Camera className="mr-2 h-5 w-5" />
                    Scan QR Code Instead
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {screen === "enroll-consent" && enrollmentData && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Confirm Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="bg-muted p-6 rounded-lg text-center">
                <User className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-2xl font-bold" data-testid="text-employee-name">
                  {enrollmentData.person.fullName}
                </h3>
              </div>
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Face Enrollment Consent</h4>
                <p className="text-sm text-muted-foreground mb-4">
                  By proceeding, you consent to having your face scanned and stored for time clock purposes. 
                  Your face data will be used solely for employee identification at company kiosks.
                </p>
                <div className="flex items-center space-x-2">
                  <Checkbox 
                    id="consent" 
                    checked={consentGiven}
                    onCheckedChange={(checked) => setConsentGiven(checked === true)}
                    data-testid="checkbox-consent"
                  />
                  <Label htmlFor="consent" className="text-base cursor-pointer">
                    I understand and consent to face enrollment
                  </Label>
                </div>
              </div>
              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleEnrollConsent}
                disabled={!consentGiven}
                data-testid="button-proceed-enrollment"
              >
                Proceed to Face Capture
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "enroll-capture" && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Face Enrollment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="relative aspect-[3/4] bg-black rounded-lg overflow-hidden">
                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                {/* Oval face guide overlay */}
                <div className="absolute inset-0 pointer-events-none">
                  <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                      <mask id="face-mask-enroll">
                        <rect x="0" y="0" width="100" height="100" fill="white"/>
                        <ellipse cx="50" cy="45" rx="28" ry="35" fill="black"/>
                      </mask>
                    </defs>
                    <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0.5)" mask="url(#face-mask-enroll)"/>
                    <ellipse cx="50" cy="45" rx="28" ry="35" fill="none" stroke="white" strokeWidth="0.5" strokeDasharray="2,1"/>
                  </svg>
                </div>
                <div className="absolute top-4 right-4">
                  <Button 
                    variant="secondary" 
                    size="icon" 
                    onClick={toggleCamera}
                    className="bg-black/50 hover:bg-black/70"
                    data-testid="button-toggle-camera-enroll"
                  >
                    <RefreshCw className="h-5 w-5 text-white" />
                  </Button>
                </div>
                <p className="absolute bottom-4 left-0 right-0 text-center text-white text-sm drop-shadow-lg">
                  Position your face in the oval
                </p>
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleEnrollCapture}
                disabled={isProcessing}
                data-testid="button-enroll-capture"
              >
                <Camera className="mr-3 h-6 w-6" />
                {isProcessing ? "Enrolling..." : "Capture & Enroll"}
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "missed-clock-in" && missedClockInData && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={resetToHome} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Missing Clock-In</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-6 w-6 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-amber-800 dark:text-amber-200">
                      Hi {missedClockInData.employee.fullName}
                    </h4>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                      You're clocking out, but we don't have a clock-in record for today.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-muted p-4 rounded-lg">
                <p className="text-sm text-muted-foreground mb-1">Your scheduled shift today:</p>
                <p className="text-lg font-mono">
                  {new Date(missedClockInData.schedule.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {" - "}
                  {new Date(missedClockInData.schedule.scheduledEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>

              <div className="space-y-4">
                <Button 
                  size="lg" 
                  className="w-full h-16 text-lg"
                  onClick={handleMissedClockAutoFix}
                  disabled={isProcessing}
                  data-testid="button-auto-fix"
                >
                  {isProcessing ? (
                    <Loader2 className="h-6 w-6 animate-spin mr-2" />
                  ) : (
                    <Clock className="h-6 w-6 mr-2" />
                  )}
                  Use scheduled start time ({new Date(missedClockInData.schedule.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                </Button>

                <Button 
                  variant="outline"
                  size="lg" 
                  className="w-full h-14"
                  onClick={() => setScreen("missed-clock-manual")}
                  disabled={isProcessing}
                  data-testid="button-manual-time"
                >
                  Enter a different start time
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {screen === "missed-clock-manual" && missedClockInData && (
          <Card className="p-6">
            <CardHeader className="flex flex-row items-center gap-2">
              <Button variant="ghost" size="icon" onClick={() => setScreen("missed-clock-in")} data-testid="button-back">
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <CardTitle className="text-2xl">Enter Start Time</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="clock-in-time" className="text-base">What time did you actually start?</Label>
                <Input 
                  id="clock-in-time"
                  type="time"
                  value={manualClockInTime}
                  onChange={(e) => setManualClockInTime(e.target.value)}
                  className="text-xl h-14 text-center font-mono"
                  data-testid="input-clock-in-time"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reason" className="text-base">Why did you miss clocking in?</Label>
                <select
                  id="reason"
                  value={missedClockReason}
                  onChange={(e) => setMissedClockReason(e.target.value)}
                  className="w-full h-12 px-3 rounded-md border border-input bg-background text-base"
                  data-testid="select-reason"
                >
                  <option value="FORGOT_TO_CLOCK_IN">I forgot to clock in</option>
                  <option value="DEVICE_ISSUE">Device was not working</option>
                  <option value="MANAGER_INSTRUCTED">Manager instructed me</option>
                  <option value="LATE_ARRIVAL">I arrived late</option>
                  <option value="OTHER">Other reason</option>
                </select>
              </div>

              {missedClockReason === "OTHER" && (
                <div className="space-y-2">
                  <Label htmlFor="note" className="text-base">Please explain</Label>
                  <Input 
                    id="note"
                    value={missedClockNote}
                    onChange={(e) => setMissedClockNote(e.target.value)}
                    placeholder="Enter reason..."
                    className="h-12"
                    data-testid="input-note"
                  />
                </div>
              )}

              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 rounded-lg">
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  This will need manager approval before your timesheet is updated.
                </p>
              </div>

              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleMissedClockManual}
                disabled={isProcessing || !manualClockInTime}
                data-testid="button-submit-manual"
              >
                {isProcessing ? (
                  <Loader2 className="h-6 w-6 animate-spin mr-2" />
                ) : (
                  <CheckCircle className="h-6 w-6 mr-2" />
                )}
                Submit for Approval
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "unscheduled-work" && unscheduledWorkData && (
          <Card className="p-4 border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-amber-600" />
                <CardTitle className="text-xl text-amber-800 dark:text-amber-200" data-testid="text-unscheduled-title">
                  No scheduled shift today
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-background p-4 rounded-lg space-y-2">
                <p className="text-lg font-medium" data-testid="text-employee-name-unscheduled">
                  Hi {unscheduledWorkData.employee.fullName}
                </p>
                <p className="text-muted-foreground">
                  You are not scheduled to work today at <span className="font-medium">{unscheduledWorkData.branch.name}</span>.
                </p>
                <p className="text-muted-foreground">
                  Current time: <span className="font-mono">{new Date(unscheduledWorkData.currentTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </p>
              </div>

              <p className="text-center text-lg font-medium text-amber-800 dark:text-amber-200">
                Do you want to clock in anyway?
              </p>

              <div className="grid grid-cols-2 gap-4">
                <Button 
                  variant="outline"
                  size="lg" 
                  className="h-16 text-lg"
                  onClick={resetToHome}
                  data-testid="button-unscheduled-cancel"
                >
                  <ArrowLeft className="h-5 w-5 mr-2" />
                  Cancel
                </Button>
                <Button 
                  size="lg" 
                  className="h-16 text-lg bg-amber-600 hover:bg-amber-700"
                  onClick={() => setScreen("unscheduled-work-confirm")}
                  data-testid="button-unscheduled-proceed"
                >
                  <Clock className="h-5 w-5 mr-2" />
                  Clock in anyway
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {screen === "unscheduled-work-confirm" && unscheduledWorkData && (
          <Card className="p-4">
            <CardHeader className="pb-2">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setScreen("unscheduled-work")}
                className="w-fit -ml-2 mb-2"
                data-testid="button-back-unscheduled"
              >
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              <CardTitle className="text-lg" data-testid="text-reason-title">
                Why are you working today?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted/50 p-3 rounded-lg">
                <p className="text-sm text-muted-foreground">
                  {unscheduledWorkData.employee.fullName} at {unscheduledWorkData.branch.name}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="unscheduled-reason" className="text-base font-medium">Select a reason</Label>
                <select
                  id="unscheduled-reason"
                  value={unscheduledReason}
                  onChange={(e) => setUnscheduledReason(e.target.value)}
                  className="w-full h-12 px-3 border rounded-md bg-background text-base"
                  data-testid="select-unscheduled-reason"
                >
                  <option value="MANAGER_INSTRUCTED">Manager asked me to come in</option>
                  <option value="COVERING_ABSENT_STAFF">Covering absent staff</option>
                  <option value="EMERGENCY_TASK">Emergency / urgent task</option>
                  <option value="TRAINING">Training</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="unscheduled-note" className="text-base">Note (optional)</Label>
                <Input 
                  id="unscheduled-note"
                  value={unscheduledNote}
                  onChange={(e) => setUnscheduledNote(e.target.value.slice(0, 500))}
                  placeholder="Add any additional details..."
                  className="h-12"
                  data-testid="input-unscheduled-note"
                />
                <p className="text-xs text-muted-foreground text-right">{unscheduledNote.length}/500</p>
              </div>

              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 rounded-lg">
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  Your clock-in will be recorded and sent for manager review.
                </p>
              </div>

              <Button 
                size="lg" 
                className="w-full h-16 text-xl"
                onClick={handleUnscheduledWorkSubmit}
                disabled={isProcessing}
                data-testid="button-submit-unscheduled"
              >
                {isProcessing ? (
                  <Loader2 className="h-6 w-6 animate-spin mr-2" />
                ) : (
                  <CheckCircle className="h-6 w-6 mr-2" />
                )}
                Submit Clock-in
              </Button>
            </CardContent>
          </Card>
        )}

        {screen === "success" && (
          <Card className={cn(
            "p-8 border-2",
            clockResult?.lateArrival?.isLate 
              ? "bg-amber-50 dark:bg-amber-950/30 border-amber-400 dark:border-amber-700" 
              : "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800"
          )}>
            <CardContent className="text-center py-12">
              {clockResult?.lateArrival?.isLate ? (
                <AlertTriangle className="h-24 w-24 mx-auto mb-6 text-amber-500" />
              ) : (
                <CheckCircle className="h-24 w-24 mx-auto mb-6 text-green-600" />
              )}
              {clockResult ? (
                <>
                  <h2 className="text-3xl font-bold mb-2" data-testid="text-success-title">
                    Clocked {clockResult.eventType}
                  </h2>
                  <p className="text-xl text-muted-foreground mb-4" data-testid="text-employee-clocked">
                    {clockResult.employee.fullName}
                  </p>
                  <p className="text-2xl font-mono" data-testid="text-clock-time">
                    {new Date(clockResult.eventTime).toLocaleTimeString()}
                  </p>
                  {clockResult.lateArrival?.isLate && (
                    <div className="mt-6 p-4 bg-amber-100 dark:bg-amber-900/40 rounded-lg" data-testid="late-arrival-warning">
                      <p className="text-lg font-semibold text-amber-800 dark:text-amber-200">
                        Late Arrival: {clockResult.lateArrival.lateMinutes} minutes
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        Scheduled start: {clockResult.lateArrival.scheduledStart}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-3xl font-bold mb-2" data-testid="text-enrollment-success">
                    Enrollment Complete
                  </h2>
                  <p className="text-xl text-muted-foreground">
                    Your face has been enrolled successfully
                  </p>
                </>
              )}
              <p className="text-sm text-muted-foreground mt-6">
                Returning to home in 5 seconds...
              </p>
            </CardContent>
          </Card>
        )}

        {screen === "error" && (
          <Card className="p-8 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800">
            <CardContent className="text-center py-12">
              <XCircle className="h-24 w-24 mx-auto mb-6 text-red-600" />
              <h2 className="text-3xl font-bold mb-4" data-testid="text-error-title">
                Error
              </h2>
              <p className="text-xl text-muted-foreground" data-testid="text-error-message">
                {errorMessage || "An error occurred. Please try again."}
              </p>
              <p className="text-sm text-muted-foreground mt-6">
                Returning to home in 5 seconds...
              </p>
              <Button 
                variant="outline" 
                size="lg" 
                className="mt-6"
                onClick={resetToHome}
                data-testid="button-back-home"
              >
                Back to Home
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
