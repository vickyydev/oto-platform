import { useState, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { Branch } from "@shared/schema";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Loader2, CheckCircle, Upload, Camera, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import otoLogo from "@assets/IMG_5815_1767489429774-BCpKrIfC_1767700375991.png";

const formSchema = z.object({
  parentFullName: z.string().min(2, "Please enter your full name"),
  whatsappPhone: z.string().min(5, "Please enter a valid phone number"),
  hasAllergiesOrMedical: z.enum(["yes", "no"]),
  allergiesMedicalDetails: z.string().optional(),
  allowStaffOrderFood: z.enum(["yes", "no"]),
  foodNotesRestrictions: z.string().optional(),
  confirmMall15min: z.boolean().refine(val => val === true, "This confirmation is required"),
  confirmEarlyPickupRefund: z.boolean().refine(val => val === true, "This confirmation is required"),
  confirmEvacLoadingBay: z.boolean().refine(val => val === true, "This confirmation is required"),
});

type FormData = z.infer<typeof formSchema>;

export default function DropoffCheckinPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const branchParam = params.get("branch") || "";
  
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [signature, setSignature] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [numberOfChildren, setNumberOfChildren] = useState<number>(1);
  const [children, setChildren] = useState<Array<{ name: string; age: string }>>([{ name: "", age: "" }]);

  const handleNumberOfChildrenChange = (num: number) => {
    const validNum = Math.max(1, Math.min(6, num));
    setNumberOfChildren(validNum);
    setChildren(prev => {
      const newChildren = [...prev];
      while (newChildren.length < validNum) {
        newChildren.push({ name: "", age: "" });
      }
      return newChildren.slice(0, validNum);
    });
  };

  const updateChild = (index: number, field: "name" | "age", value: string) => {
    setChildren(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const { data: branch, isLoading: branchLoading, error: branchError } = useQuery<Branch>({
    queryKey: ["/api/public/branch", branchParam],
    queryFn: async () => {
      const res = await fetch(`/api/public/branch/${branchParam}`);
      if (!res.ok) throw new Error("Branch not found");
      return res.json();
    },
    enabled: !!branchParam,
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      parentFullName: "",
      whatsappPhone: "",
      hasAllergiesOrMedical: "no",
      allergiesMedicalDetails: "",
      allowStaffOrderFood: "no",
      foodNotesRestrictions: "",
      confirmMall15min: false,
      confirmEarlyPickupRefund: false,
      confirmEvacLoadingBay: false,
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (data: FormData) => {
      if (!signature) throw new Error("Please provide your signature");
      if (!photoFile) throw new Error("Please upload a photo");
      if (!branch) throw new Error("Branch not found");
      
      // Validate children
      for (let i = 0; i < children.length; i++) {
        if (!children[i].name.trim()) {
          throw new Error(`Please enter name for Child ${i + 1}`);
        }
        if (!children[i].age) {
          throw new Error(`Please select age for Child ${i + 1}`);
        }
      }

      const formData = new FormData();
      formData.append("branchId", branch.id);
      formData.append("parentFullName", data.parentFullName);
      formData.append("whatsappPhone", data.whatsappPhone);
      formData.append("children", JSON.stringify(children));
      formData.append("hasAllergiesOrMedical", data.hasAllergiesOrMedical === "yes" ? "true" : "false");
      formData.append("allergiesMedicalDetails", data.allergiesMedicalDetails || "");
      formData.append("allowStaffOrderFood", data.allowStaffOrderFood === "yes" ? "true" : "false");
      formData.append("foodNotesRestrictions", data.foodNotesRestrictions || "");
      formData.append("confirmMall15min", String(data.confirmMall15min));
      formData.append("confirmEarlyPickupRefund", String(data.confirmEarlyPickupRefund));
      formData.append("confirmEvacLoadingBay", String(data.confirmEvacLoadingBay));
      formData.append("signature", signature);
      formData.append("photo", photoFile);

      const res = await fetch("/api/public/dropoff-checkin", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Submission failed");
      }

      return res.json();
    },
    onSuccess: () => {
      setIsSubmitted(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Please select a photo under 10MB",
          variant: "destructive",
        });
        return;
      }
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        toast({
          title: "Invalid file type",
          description: "Please select a JPEG, PNG, or WebP image",
          variant: "destructive",
        });
        return;
      }
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  const watchHasAllergies = form.watch("hasAllergiesOrMedical");

  if (!branchParam) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Invalid Link</h2>
            <p className="text-muted-foreground">Please scan the QR code at the park reception.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (branchLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (branchError || !branch) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Branch Not Found</h2>
            <p className="text-muted-foreground">Please scan the QR code at the park reception.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isSubmitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Thank You!</h2>
            <p className="text-muted-foreground mb-4">
              Your drop-off check-in has been submitted successfully.
            </p>
            <div className="bg-muted rounded-lg p-4">
              <p className="font-medium">Please proceed to reception</p>
              <p className="text-sm text-muted-foreground mt-1">
                Staff will verify your check-in and provide a wristband for your child.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const onSubmit = (data: FormData) => {
    if (!signature) {
      toast({
        title: "Signature Required",
        description: "Please sign in the signature box",
        variant: "destructive",
      });
      return;
    }
    if (!photoFile) {
      toast({
        title: "Photo Required",
        description: "Please upload a photo of parent and child together",
        variant: "destructive",
      });
      return;
    }
    submitMutation.mutate(data);
  };

  return (
    <div 
      className="min-h-screen bg-background"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="max-w-lg mx-auto p-4 pb-8">
        <div className="text-center mb-6">
          <img src={otoLogo} alt="OTO" className="h-12 mx-auto mb-2" />
          <h2 className="text-lg font-semibold mb-2">Drop-Off Service Check-In Form</h2>
          <p className="text-sm text-muted-foreground">Ages 3-8</p>
          <p className="text-xs text-muted-foreground mt-1">{branch.name}</p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Parent / Guardian Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="parentFullName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Your full name" {...field} data-testid="input-parent-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="whatsappPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>WhatsApp Number *</FormLabel>
                      <FormControl>
                        <PhoneInput
                          international
                          defaultCountry="TH"
                          value={field.value}
                          onChange={(value) => field.onChange(value || "")}
                          data-testid="input-phone"
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Children's Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Number of Children</Label>
                  <Select
                    value={String(numberOfChildren)}
                    onValueChange={(val) => handleNumberOfChildrenChange(parseInt(val))}
                  >
                    <SelectTrigger data-testid="select-num-children">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                {children.map((child, index) => (
                  <div key={index} className="space-y-3 p-3 bg-muted/30 rounded-lg">
                    <p className="text-sm font-medium text-muted-foreground">Child {index + 1}</p>
                    <div>
                      <Label>Full Name *</Label>
                      <Input
                        placeholder={`Child ${index + 1}'s full name`}
                        value={child.name}
                        onChange={(e) => updateChild(index, "name", e.target.value)}
                        data-testid={`input-child-name-${index}`}
                      />
                    </div>
                    <div>
                      <Label>Age *</Label>
                      <Select
                        value={child.age}
                        onValueChange={(val) => updateChild(index, "age", val)}
                      >
                        <SelectTrigger data-testid={`select-child-age-${index}`}>
                          <SelectValue placeholder="Select age" />
                        </SelectTrigger>
                        <SelectContent>
                          {[3, 4, 5, 6, 7, 8].map((age) => (
                            <SelectItem key={age} value={String(age)}>{age} years</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Service Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-4 text-sm space-y-4">
                  <div>
                    <p className="font-semibold">Nanny Service (Ages 3-5, inclusive)</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5 list-disc list-inside">
                      <li>Required for children aged 3 to 5</li>
                      <li>300 THB per hour</li>
                      <li>One nanny per child</li>
                      <li>Two siblings or two children from the same group may share one nanny at no extra cost</li>
                      <li>Designed for parents who wish to leave their child unattended</li>
                    </ul>
                  </div>
                  
                  <div>
                    <p className="font-semibold">Drop-Off Service (Ages 6-8, inclusive)</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5 list-disc list-inside">
                      <li>Available for children aged 6 to 8</li>
                      <li>200 THB one-time fee</li>
                      <li>No assigned nanny</li>
                      <li>Our team will provide general supervision and extra attention to safety and well-being during play</li>
                    </ul>
                  </div>
                  
                  <div>
                    <p className="font-semibold">Siblings & Mixed Ages</p>
                    <p className="text-muted-foreground mt-1">If two siblings attend together, one aged 4+ and one aged up to 8, no extra nanny charge applies (they may share one nanny where applicable)</p>
                  </div>
                  
                  <div className="pt-2 border-t border-blue-200 dark:border-blue-800">
                    <p className="font-semibold text-blue-700 dark:text-blue-300">Important</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5 list-disc list-inside">
                      <li>All children must also have a valid park entrance ticket</li>
                      <li>Supervision services are in addition to the entrance ticket fee</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Health & Safety</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="hasAllergiesOrMedical"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Does your child have any allergies or medical conditions? *</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                          className="flex gap-4"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="no" id="allergies-no" data-testid="radio-allergies-no" />
                            <Label htmlFor="allergies-no">No</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="yes" id="allergies-yes" data-testid="radio-allergies-yes" />
                            <Label htmlFor="allergies-yes">Yes</Label>
                          </div>
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {watchHasAllergies === "yes" && (
                  <FormField
                    control={form.control}
                    name="allergiesMedicalDetails"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Please provide details *</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="Describe allergies or medical conditions..."
                            {...field}
                            data-testid="input-allergies-details"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Food & Drinks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="allowStaffOrderFood"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>May staff order food/drinks for your child? *</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                          className="flex gap-4"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="no" id="food-no" data-testid="radio-food-no" />
                            <Label htmlFor="food-no">No</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="yes" id="food-yes" data-testid="radio-food-yes" />
                            <Label htmlFor="food-yes">Yes</Label>
                          </div>
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="foodNotesRestrictions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Food restrictions or notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="Any dietary restrictions..."
                          {...field}
                          data-testid="input-food-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Photo</CardTitle>
                <CardDescription>Please upload a photo of parent and child together</CardDescription>
              </CardHeader>
              <CardContent>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePhotoChange}
                  ref={fileInputRef}
                  className="hidden"
                  data-testid="input-photo"
                />
                {photoPreview ? (
                  <div className="space-y-2">
                    <img 
                      src={photoPreview} 
                      alt="Preview" 
                      className="w-full max-h-48 object-cover rounded-md"
                    />
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full"
                      data-testid="button-change-photo"
                    >
                      <Camera className="h-4 w-4 mr-2" />
                      Change Photo
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full h-24 border-dashed"
                    data-testid="button-upload-photo"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <Upload className="h-6 w-6" />
                      <span>Tap to upload photo</span>
                    </div>
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Parent Confirmation</CardTitle>
                <CardDescription>Please read and confirm all statements below</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="confirmMall15min"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-confirm-mall"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-normal">
                          I will remain within the shopping mall and no more than 15 minutes away from OTO Play Park. *
                        </FormLabel>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmEarlyPickupRefund"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-confirm-pickup"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-normal">
                          OTO Play Park may contact me and request early pick-up for operational or safety reasons. If more than 30 minutes remain, the unused time will be refunded. *
                        </FormLabel>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmEvacLoadingBay"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-confirm-evac"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-normal">
                          In an emergency or evacuation, my child will be taken to the shopping centre loading bay. *
                        </FormLabel>
                      </div>
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Signature</CardTitle>
                <CardDescription>Please sign below to confirm check-in</CardDescription>
              </CardHeader>
              <CardContent>
                <SignatureCanvas onSignatureChange={setSignature} />
              </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground text-center px-4">
              By submitting this form, you consent to OTO Play Park collecting and using this 
              information and photo for safety and operational purposes. Records are retained 
              for up to {branch.retentionDays || 30} days.
            </div>

            <Button 
              type="submit" 
              className="w-full"
              disabled={submitMutation.isPending}
              data-testid="button-submit-checkin"
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit Check-In"
              )}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
