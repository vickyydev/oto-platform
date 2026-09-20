import { useState, useRef } from "react";
import { useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from "libphonenumber-js";
import type { Branch } from "@shared/schema";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Loader2, CheckCircle, Upload, Camera, AlertTriangle, Baby, Users, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import otoLogo from "@assets/IMG_5815_1767489429774-BCpKrIfC_1767700375991.png";

const SERVICE_CONFIG = {
  nanny: {
    name: "Nanny Service",
    ageRange: "0-2 years",
    pricingType: "hourly" as const,
    priceAmount: 300,
    priceUnit: "THB/hour per nanny",
    description: "One nanny cares for your child. Two siblings or two children from the same group may share one nanny at no extra cost.",
    color: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  },
  dropoff: {
    name: "Drop-Off Service",
    ageRange: "3-8 years",
    pricingType: "one_time" as const,
    priceAmount: 200,
    priceUnit: "THB one-time fee",
    description: "No assigned nanny, but our team will give extra attention to your child's safety and well-being during play.",
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
};

const formSchema = z.object({
  parentFullName: z.string().min(2, "Please enter your full name"),
  whatsappPhoneRaw: z.string().min(5, "Please enter a valid phone number"),
  whatsappCountry: z.string().default("TH"),
  whatsappConsent: z.boolean().refine(val => val === true, "Please consent to WhatsApp communication"),
  childFullName: z.string().optional(),
  siblingAttendingSameTime: z.boolean().optional(),
  hasAllergiesOrMedical: z.enum(["yes", "no"]),
  allergiesMedicalDetails: z.string().optional(),
  allowStaffOrderFood: z.enum(["yes", "no"]),
  foodNotesRestrictions: z.string().optional(),
  confirmMall15min: z.boolean().refine(val => val === true, "This confirmation is required"),
  confirmEarlyPickupRefund: z.boolean().refine(val => val === true, "This confirmation is required"),
  confirmEvacLoadingBay: z.boolean().refine(val => val === true, "This confirmation is required"),
});

type FormData = z.infer<typeof formSchema>;

const popularCountries = [
  { code: "TH", name: "Thailand" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "CN", name: "China" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" },
  { code: "IN", name: "India" },
  { code: "RU", name: "Russia" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
];

type ServiceType = "nanny" | "dropoff";

export default function ServiceCheckinPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const branchParam = params.get("branch") || "";
  
  const { toast } = useToast();
  const [childAge, setChildAge] = useState<number | null>(null);
  const [serviceType, setServiceType] = useState<ServiceType | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [numberOfChildren, setNumberOfChildren] = useState<number>(1);
  const [children, setChildren] = useState<Array<{ name: string; age: string }>>([{ name: "", age: "" }]);

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
      whatsappPhoneRaw: "",
      whatsappCountry: "TH",
      whatsappConsent: false,
      childFullName: "",
      siblingAttendingSameTime: false,
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
      if (!serviceType || childAge === null) throw new Error("Service type not selected");

      if (serviceType === "dropoff") {
        const emptyChild = children.find((c, i) => i < numberOfChildren && (!c.name.trim() || !c.age));
        if (emptyChild) {
          throw new Error("Please fill in all children's names and ages");
        }
      }

      const config = SERVICE_CONFIG[serviceType];
      
      const formData = new FormData();
      formData.append("branchId", branch.id);
      formData.append("serviceType", serviceType);
      formData.append("pricingType", config.pricingType);
      formData.append("priceAmountThb", String(config.priceAmount));
      formData.append("priceUnit", config.priceUnit);
      formData.append("parentFullName", data.parentFullName);
      formData.append("whatsappPhoneRaw", data.whatsappPhoneRaw);
      formData.append("whatsappCountry", data.whatsappCountry);
      formData.append("whatsappConsent", String(data.whatsappConsent));
      
      if (serviceType === "dropoff") {
        const childNames = children.slice(0, numberOfChildren).map(c => c.name.trim()).join(", ");
        const childAges = children.slice(0, numberOfChildren).map(c => c.age).join(", ");
        formData.append("childFullName", childNames);
        formData.append("childAge", childAges);
        formData.append("numberOfChildren", String(numberOfChildren));
        formData.append("childrenData", JSON.stringify(children.slice(0, numberOfChildren)));
      } else {
        formData.append("childFullName", data.childFullName || "");
        formData.append("childAge", String(childAge));
      }
      
      formData.append("siblingAttendingSameTime", String(data.siblingAttendingSameTime || false));
      formData.append("hasAllergiesOrMedical", data.hasAllergiesOrMedical === "yes" ? "true" : "false");
      formData.append("allergiesMedicalDetails", data.allergiesMedicalDetails || "");
      formData.append("allowStaffOrderFood", data.allowStaffOrderFood === "yes" ? "true" : "false");
      formData.append("foodNotesRestrictions", data.foodNotesRestrictions || "");
      formData.append("confirmMall15min", String(data.confirmMall15min));
      formData.append("confirmEarlyPickupRefund", String(data.confirmEarlyPickupRefund));
      formData.append("confirmEvacLoadingBay", String(data.confirmEvacLoadingBay));
      formData.append("signature", signature);
      formData.append("photo", photoFile);

      const res = await fetch("/api/public/service-checkin", {
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

  const handleAgeSelect = (age: number) => {
    setChildAge(age);
    if (age >= 0 && age <= 2) {
      setServiceType("nanny");
    } else if (age >= 3 && age <= 8) {
      setServiceType("dropoff");
    } else {
      setServiceType(null);
    }
  };

  const handleBack = () => {
    setChildAge(null);
    setServiceType(null);
    setNumberOfChildren(1);
    setChildren([{ name: "", age: "" }]);
    form.reset();
  };

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
              Your {serviceType === "nanny" ? "nanny service" : "drop-off"} check-in has been submitted successfully.
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

  if (childAge === null || serviceType === null) {
    return (
      <div 
        className="min-h-screen bg-background"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="max-w-lg mx-auto p-4 pb-8">
          <div className="text-center mb-8">
            <img src={otoLogo} alt="OTO" className="h-12 mx-auto mb-2" />
            <h2 className="text-lg font-semibold mb-2">Check-In</h2>
            <p className="text-xs text-muted-foreground">{branch.name}</p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-center">How old is your child?</CardTitle>
              <CardDescription className="text-center">
                Select your child's age to see available services
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2 mb-6">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((age) => (
                  <Button
                    key={age}
                    variant="outline"
                    className="h-14 text-lg font-medium"
                    onClick={() => handleAgeSelect(age)}
                    data-testid={`button-age-${age}`}
                  >
                    {age}
                  </Button>
                ))}
              </div>

              <div className="space-y-3 mt-6">
                <div className="flex items-center gap-3 p-3 rounded-lg border bg-pink-50 dark:bg-pink-950/30">
                  <Baby className="h-5 w-5 text-pink-600" />
                  <div>
                    <p className="font-medium text-sm">Nanny Service</p>
                    <p className="text-xs text-muted-foreground">Ages 0-2 - 300 THB/hour per nanny</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-lg border bg-blue-50 dark:bg-blue-950/30">
                  <Users className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="font-medium text-sm">Drop-Off Service</p>
                    <p className="text-xs text-muted-foreground">Ages 3-8 - 200 THB one-time fee</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const config = SERVICE_CONFIG[serviceType];

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
    if (serviceType === "nanny" && (!data.childFullName || data.childFullName.length < 2)) {
      toast({
        title: "Child Name Required",
        description: "Please enter your child's full name",
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
        <div className="mb-4">
          <Button variant="ghost" size="sm" onClick={handleBack} data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Change Age
          </Button>
        </div>

        <div className="text-center mb-6">
          <img src={otoLogo} alt="OTO" className="h-12 mx-auto mb-2" />
          <h2 className="text-lg font-semibold mb-2">{config.name} Check-In</h2>
          <div className="flex items-center justify-center gap-2 mb-1">
            <Badge className={config.color}>
              Age {childAge} - {config.ageRange}
            </Badge>
          </div>
          <p className="text-sm font-medium text-muted-foreground">{config.priceAmount} {config.priceUnit}</p>
          <p className="text-xs text-muted-foreground mt-1">{branch.name}</p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Parent Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="parentFullName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Your Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Enter your full name" {...field} data-testid="input-parent-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <Label>WhatsApp Number</Label>
                  <div className="flex gap-2">
                    <FormField
                      control={form.control}
                      name="whatsappCountry"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-[100px]" data-testid="select-country">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {popularCountries.map((country) => (
                              <SelectItem key={country.code} value={country.code}>
                                +{getCountryCallingCode(country.code as any)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="whatsappPhoneRaw"
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input 
                              type="tel" 
                              placeholder="Phone number" 
                              {...field} 
                              data-testid="input-phone"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                <FormField
                  control={form.control}
                  name="whatsappConsent"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-whatsapp-consent"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-normal">
                          I consent to receive messages via WhatsApp for check-in updates and emergencies
                        </FormLabel>
                        <FormMessage />
                      </div>
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {serviceType === "dropoff" ? "Children's Information" : "Child Information"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {serviceType === "dropoff" ? (
                  <>
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
                          <Label>Full Name</Label>
                          <Input
                            placeholder={`Child ${index + 1}'s full name`}
                            value={child.name}
                            onChange={(e) => updateChild(index, "name", e.target.value)}
                            data-testid={`input-child-name-${index}`}
                          />
                        </div>
                        <div>
                          <Label>Age</Label>
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
                    
                    <div className="bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg text-sm">
                      <p className="text-muted-foreground">
                        {config.description}
                      </p>
                      {numberOfChildren >= 2 && (
                        <p className="mt-2 text-blue-700 dark:text-blue-300 font-medium">
                          If you have two siblings, one aged 4+ and one aged 8+, no extra charge applies.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <FormField
                      control={form.control}
                      name="childFullName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Child's Full Name</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter child's full name" {...field} data-testid="input-child-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="bg-muted/50 p-3 rounded-lg">
                      <p className="text-sm">
                        <span className="font-medium">Age:</span> {childAge} years old
                      </p>
                    </div>

                    <div className="bg-pink-50 dark:bg-pink-950/30 p-3 rounded-lg text-sm">
                      <p className="text-muted-foreground">
                        {config.description}
                      </p>
                    </div>

                    <FormField
                      control={form.control}
                      name="siblingAttendingSameTime"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="checkbox-sibling"
                            />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel className="text-sm font-normal">
                              Sibling is also attending at the same time (share nanny at no extra cost)
                            </FormLabel>
                          </div>
                        </FormItem>
                      )}
                    />
                  </>
                )}
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
                      <FormLabel>Does your child have any allergies or medical conditions?</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          value={field.value}
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
                    </FormItem>
                  )}
                />

                {watchHasAllergies === "yes" && (
                  <FormField
                    control={form.control}
                    name="allergiesMedicalDetails"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Please provide details</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="List allergies, medications, or medical conditions..." 
                            {...field} 
                            data-testid="textarea-allergies"
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
                      <FormLabel>May staff order food/drinks for your child? (charged to parent)</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={field.onChange}
                          value={field.value}
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
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="foodNotesRestrictions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Any food restrictions or notes?</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="e.g., No nuts, vegetarian only..." 
                          {...field} 
                          data-testid="textarea-food-notes"
                        />
                      </FormControl>
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
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handlePhotoChange}
                  data-testid="input-photo"
                />
                {photoPreview ? (
                  <div className="space-y-3">
                    <img 
                      src={photoPreview} 
                      alt="Preview" 
                      className="w-full max-h-64 object-cover rounded-lg"
                    />
                    <Button 
                      type="button" 
                      variant="outline" 
                      className="w-full"
                      onClick={() => fileInputRef.current?.click()}
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
                    className="w-full h-24"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="button-upload-photo"
                  >
                    <div className="flex flex-col items-center">
                      <Upload className="h-6 w-6 mb-1" />
                      <span>Upload Photo</span>
                    </div>
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Confirmations</CardTitle>
                <CardDescription>Please read and confirm each item</CardDescription>
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
                          I confirm that I will stay within 15 minutes of the mall during my child's visit
                        </FormLabel>
                        <FormMessage />
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
                          data-testid="checkbox-confirm-refund"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-normal">
                          I understand that early pickup is non-refundable
                        </FormLabel>
                        <FormMessage />
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
                          In case of emergency evacuation, I will meet staff at the mall loading bay
                        </FormLabel>
                        <FormMessage />
                      </div>
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Signature</CardTitle>
                <CardDescription>Sign below to confirm all information is correct</CardDescription>
              </CardHeader>
              <CardContent>
                <SignatureCanvas
                  onSignatureChange={setSignature}
                />
              </CardContent>
            </Card>

            <Button 
              type="submit" 
              className="w-full" 
              size="lg"
              disabled={submitMutation.isPending}
              data-testid="button-submit"
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
