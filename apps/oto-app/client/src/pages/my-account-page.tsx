import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PhoneVerification } from "@/components/phone-verification";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, User, Camera, Upload, Loader2, CheckCircle, Building2, Briefcase } from "lucide-react";
import { Link } from "wouter";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

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

        <PhoneVerification
          currentPhone={(user as any).phoneNumber || (user as any).phoneE164}
          isVerified={(user as any).phoneVerified}
          verifiedAt={(user as any).phoneVerifiedAt}
        />

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage your password and security settings</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/change-password">
              <Button variant="outline" data-testid="button-change-password">
                Change Password
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
