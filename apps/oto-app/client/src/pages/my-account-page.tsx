import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PhoneVerification } from "@/components/phone-verification";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, User, Camera, Upload, Loader2, CheckCircle, Building2, Briefcase } from "lucide-react";
import { Link } from "wouter";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLegacyLoginOff } from "@/lib/sign-in-options";
import { LauncherPasswordNote } from "@/components/suite-sign-in";
import { birthdaySchema } from "@shared/birthday";

function ProfilePhotoCapture() {
  const { user } = useAuth();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPhotoUrl, setSavedPhotoUrl] = useState<string | null>(null);

  const currentProfilePhoto = (user as any)?.linkedEmployeeProfilePhoto || null;

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
      });
      streamRef.current = stream;
      setIsCameraActive(true);
      setCapturedPhoto(null);
      setSelectedFile(null);
      setSavedPhotoUrl(null);
    } catch (error) {
      toast({
        title: "Camera access denied",
        description: "Please allow camera access to capture your profile photo.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  }, []);

  useEffect(() => {
    if (isCameraActive && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [isCameraActive]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const capturePhoto = useCallback(() => {
    if (!canvasRef.current || !videoRef.current) return;
    
    setIsCapturing(true);
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], `camera-photo-${Date.now()}.jpg`, { type: "image/jpeg" });
          setSelectedFile(file);
          setCapturedPhoto(URL.createObjectURL(blob));
        }
        stopCamera();
        setIsCapturing(false);
      }, "image/jpeg", 0.85);
    } else {
      setIsCapturing(false);
    }
  }, [stopCamera]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid file",
        description: "Please select an image file (JPEG, PNG, etc.)",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please select an image under 5MB.",
        variant: "destructive",
      });
      return;
    }

    setSelectedFile(file);
    setCapturedPhoto(URL.createObjectURL(file));
    setSavedPhotoUrl(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [toast]);

  const savePhoto = async () => {
    if (!selectedFile) return;
    
    setIsSaving(true);
    try {
      const fileToUpload = selectedFile;

      const formData = new FormData();
      formData.append("photo", fileToUpload);
      const res = await fetch("/api/my-account/profile-photo", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      const result = await res.json();
      setSavedPhotoUrl(result.profilePhotoPath);
      toast({
        title: "Profile photo saved",
        description: "Your profile photo has been updated successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      setCapturedPhoto(null);
      setSelectedFile(null);
    } catch (error: any) {
      toast({
        title: "Failed to save photo",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    }
    setIsSaving(false);
  };

  const retake = () => {
    setCapturedPhoto(null);
    startCamera();
  };

  const clearPhoto = () => {
    if (capturedPhoto && capturedPhoto.startsWith("blob:")) {
      URL.revokeObjectURL(capturedPhoto);
    }
    setCapturedPhoto(null);
    setSelectedFile(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          Update Profile Photo
        </CardTitle>
        <CardDescription>
          Take a photo with your camera or upload one from your device
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <canvas ref={canvasRef} className="hidden" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileUpload}
          data-testid="input-upload-photo"
        />
        
        {!isCameraActive && !capturedPhoto && (
          <div className="space-y-4">
            {(savedPhotoUrl || currentProfilePhoto) && (
              <div className="relative max-w-[160px]">
                <img
                  src={savedPhotoUrl || currentProfilePhoto}
                  alt="Current profile photo"
                  className="w-[160px] h-[160px] rounded-full object-cover border-2 border-green-500"
                  data-testid="img-current-profile-photo"
                />
                <div className="absolute bottom-1 right-1 bg-green-500 text-white rounded-full p-1">
                  <CheckCircle className="h-4 w-4" />
                </div>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <Button onClick={startCamera} data-testid="button-start-camera">
                <Camera className="mr-2 h-4 w-4" />
                {(savedPhotoUrl || currentProfilePhoto) ? "Change Photo" : "Take Photo"}
              </Button>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="button-upload-photo">
                <Upload className="mr-2 h-4 w-4" />
                Upload Photo
              </Button>
            </div>
          </div>
        )}

        {isCameraActive && (
          <div className="space-y-4">
            <div className="relative aspect-[4/3] max-w-sm bg-black rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
                style={{ transform: "scaleX(-1)" }}
              />
              <div className="absolute inset-0 pointer-events-none border-2 border-white/30 rounded-lg" />
            </div>
            <div className="flex gap-2">
              <Button onClick={capturePhoto} disabled={isCapturing} data-testid="button-capture-photo">
                {isCapturing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                Capture
              </Button>
              <Button variant="outline" onClick={stopCamera} data-testid="button-cancel-camera">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {capturedPhoto && (
          <div className="space-y-4">
            <div className="relative aspect-[4/3] max-w-sm bg-muted rounded-lg overflow-hidden">
              <img src={capturedPhoto} alt="Preview" className="w-full h-full object-cover" />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button onClick={savePhoto} disabled={isSaving} data-testid="button-save-photo">
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
                Save Photo
              </Button>
              <Button variant="outline" onClick={retake} data-testid="button-retake-photo">
                Retake
              </Button>
              <Button variant="outline" onClick={clearPhoto} data-testid="button-clear-photo">
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MyAccountPage() {
  const { user } = useAuth();
  // SCRUM-539: the password and its SMS recovery here belong to this app's own
  // sign-in; while that is closed both live at the launcher.
  const { off: legacyOff, launcherUrl } = useLegacyLoginOff();
  const { toast } = useToast();
  const [birthday, setBirthday] = useState<{ month: number | null; day: number | null; year: number | null }>({ month: null, day: null, year: null });
  const [birthdayError, setBirthdayError] = useState("");
  const { data: birthdayData } = useQuery<{ month: number | null; day: number | null; year: number | null }>({
    queryKey: ["/api/my-account/birthday"],
    enabled: !!user,
  });
  useEffect(() => {
    if (birthdayData) setBirthday(birthdayData);
  }, [birthdayData]);
  const birthdayMutation = useMutation({
    mutationFn: async (value: typeof birthday) => {
      const res = await apiRequest("PATCH", "/api/my-account/birthday", value);
      return res.json();
    },
    onSuccess: (value) => {
      setBirthday(value);
      setBirthdayError("");
      queryClient.invalidateQueries({ queryKey: ["/api/my-account/birthday"] });
      queryClient.invalidateQueries({ queryKey: ["/api/birthdays"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({ title: "Birthday saved", description: "Your birthday has been updated." });
    },
    onError: (error: Error) => toast({ title: "Could not save birthday", description: error.message, variant: "destructive" }),
  });

  const saveBirthday = () => {
    const validated = birthdaySchema.safeParse(birthday);
    if (!validated.success) return setBirthdayError(validated.error.issues[0].message);
    setBirthdayError("");
    birthdayMutation.mutate(validated.data);
  };

  type EmployeeInfo = {
    linked: boolean;
    employeeId?: string;
    fullName?: string;
    nickname?: string;
    branchName?: string | null;
    departmentName?: string | null;
    roles?: { name: string; isPrimary: boolean }[];
  };

  const { data: empInfo } = useQuery<EmployeeInfo>({
    queryKey: ["/api/my-account/employee-info"],
    enabled: !!user,
  });

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4 mb-6">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back-home">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">My Account</h1>
            <p className="text-muted-foreground">Manage your account settings</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Account Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-1">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="font-medium">{user.fullName}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-sm text-muted-foreground">Email</span>
              <span className="font-medium">{user.email}</span>
            </div>
            {user.username && (
              <div className="grid gap-1">
                <span className="text-sm text-muted-foreground">Username</span>
                <span className="font-medium">{user.username}</span>
              </div>
            )}
            <div className="grid gap-1">
              <span className="text-sm text-muted-foreground">Role</span>
              <span className="font-medium capitalize">{user.role?.replace("_", " ")}</span>
            </div>
            <div className="border-t pt-3 mt-3 space-y-3">
              <div>
                <span className="text-sm text-muted-foreground">Birthday</span>
                <p className="text-xs text-muted-foreground">Year is private and optional. February 29 is celebrated on February 28 in non-leap years.</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Month
                  <input type="number" min={1} max={12} placeholder="MM" value={birthday.month ?? ""}
                    onChange={e => setBirthday(v => ({ ...v, month: e.target.value === "" ? null : Number(e.target.value) }))}
                    className="h-9 rounded-md border bg-background px-3 text-sm text-foreground" data-testid="input-my-account-birthday-month" />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Day
                  <input type="number" min={1} max={31} placeholder="DD" value={birthday.day ?? ""}
                    onChange={e => setBirthday(v => ({ ...v, day: e.target.value === "" ? null : Number(e.target.value) }))}
                    className="h-9 rounded-md border bg-background px-3 text-sm text-foreground" data-testid="input-my-account-birthday-day" />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Year (optional)
                  <input type="number" min={1} max={9999} placeholder="YYYY" value={birthday.year ?? ""}
                    onChange={e => setBirthday(v => ({ ...v, year: e.target.value === "" ? null : Number(e.target.value) }))}
                    className="h-9 rounded-md border bg-background px-3 text-sm text-foreground" data-testid="input-my-account-birthday-year" />
                </label>
              </div>
              {birthdayError && <p className="text-sm text-destructive">{birthdayError}</p>}
              <div className="flex gap-2">
                <Button type="button" onClick={saveBirthday} disabled={birthdayMutation.isPending} data-testid="button-save-birthday">
                  {birthdayMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Birthday
                </Button>
                <Button type="button" variant="outline" onClick={() => { const empty = { month: null, day: null, year: null }; setBirthday(empty); setBirthdayError(""); birthdayMutation.mutate(empty); }} disabled={birthdayMutation.isPending} data-testid="button-clear-birthday">
                  Clear
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {empInfo?.linked && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Briefcase className="h-5 w-5" />
                Employment Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {empInfo.branchName && (
                <div className="grid gap-1">
                  <span className="text-sm text-muted-foreground">Branch</span>
                  <span className="font-medium flex items-center gap-2" data-testid="text-employee-branch">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    {empInfo.branchName}
                  </span>
                </div>
              )}
              {empInfo.departmentName && (
                <div className="grid gap-1">
                  <span className="text-sm text-muted-foreground">Department</span>
                  <span className="font-medium" data-testid="text-employee-department">{empInfo.departmentName}</span>
                </div>
              )}
              {empInfo.roles && empInfo.roles.length > 0 && (
                <div className="grid gap-1">
                  <span className="text-sm text-muted-foreground">Roles</span>
                  <div className="flex flex-wrap gap-2" data-testid="text-employee-roles">
                    {empInfo.roles.map((r, i) => (
                      <Badge key={i} variant={r.isPrimary ? "default" : "secondary"} className="text-sm">
                        {r.name}{r.isPrimary ? " (Primary)" : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <ProfilePhotoCapture />

        {!legacyOff && (
          <PhoneVerification
            currentPhone={(user as any).phoneNumber || (user as any).phoneE164}
            isVerified={(user as any).phoneVerified}
            verifiedAt={(user as any).phoneVerifiedAt}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage your password and security settings</CardDescription>
          </CardHeader>
          <CardContent>
            {legacyOff ? (
              <LauncherPasswordNote launcherUrl={launcherUrl} />
            ) : (
              <Link href="/change-password">
                <Button variant="outline" data-testid="button-change-password">
                  Change Password
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
