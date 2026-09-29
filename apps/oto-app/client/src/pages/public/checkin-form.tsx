import { useState, useRef, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { useForm, Controller, useWatch } from "react-hook-form";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Loader2, CheckCircle, Upload, Camera, AlertTriangle, User, Baby, Heart, Utensils, Pen, Shield, Globe } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface FormFieldConfig {
  id: string;
  type: string;
  required?: boolean;
  labelKey: string;
  placeholderKey?: string;
  helpTextKey?: string;
  options?: { value: string; labelKey: string }[];
  conditionalOn?: {
    fieldId: string;
    value: string | boolean | string[];
  };
  displayOrder: number;
  validation?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

interface FormSectionConfig {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  displayOrder: number;
  fields: FormFieldConfig[];
  repeatable?: boolean;
  maxRepeats?: number;
}

interface FormSchemaConfig {
  titleKey: string;
  descriptionKey?: string;
  sections: FormSectionConfig[];
}

interface PublishedFormData {
  versionId: number;
  schema: FormSchemaConfig;
  translations: Record<string, string>;
  language: string;
  availableLanguages: string[];
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  th: "ไทย",
  ru: "Русский",
  zh: "中文",
};

const SECTION_ICONS: Record<string, typeof User> = {
  guardian_info: User,
  children_info: Baby,
  health_info: Heart,
  food_info: Utensils,
  photo_section: Camera,
  signature_section: Pen,
  confirmations: Shield,
};

export default function PublicCheckinForm() {
  const { branchId, token } = useParams<{ branchId: string; token: string }>();
  const { toast } = useToast();
  const [signature, setSignature] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [numberOfChildren, setNumberOfChildren] = useState<number>(1);
  const [children, setChildren] = useState<Array<{ name: string; age: string }>>([{ name: "", age: "" }]);
  const [selectedLang, setSelectedLang] = useState<string>("en");
  const [formValues, setFormValues] = useState<Record<string, any>>({});

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

  const { data: branchData, isLoading: branchLoading, error: branchError } = useQuery<{ name: string }>({
    queryKey: ["/api/public/branch-info", branchId],
    queryFn: async () => {
      const res = await fetch(`/api/public/branch-info/${branchId}`);
      if (!res.ok) throw new Error("Branch not found");
      return res.json();
    },
    enabled: !!branchId,
  });

  const { data: formConfig, isLoading: formConfigLoading } = useQuery<PublishedFormData | null>({
    queryKey: ["/api/public/dropoff-form", branchId, selectedLang],
    queryFn: async () => {
      const res = await fetch(`/api/public/dropoff-form/${branchId}?lang=${selectedLang}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!branchId,
  });

  const t = (key: string, fallback?: string): string => {
    if (formConfig?.translations && formConfig.translations[key]) {
      return formConfig.translations[key];
    }
    return fallback || key.split('.').pop()?.replace(/_/g, ' ') || key;
  };

  const isFieldVisible = (field: FormFieldConfig): boolean => {
    if (!field.conditionalOn) return true;
    const { fieldId, value } = field.conditionalOn;
    const currentValue = formValues[fieldId];
    if (Array.isArray(value)) {
      return value.includes(currentValue);
    }
    return currentValue === value;
  };

  const updateFormValue = (fieldId: string, value: any) => {
    setFormValues(prev => ({ ...prev, [fieldId]: value }));
  };

  async function compressImage(file: File, maxWidth = 1200, quality = 0.75): Promise<File> {
    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
            } else {
              resolve(file);
            }
          },
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
      img.src = objectUrl;
    });
  }

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 20 * 1024 * 1024) {
        toast({ title: "File too large", description: "Please select a photo under 20MB", variant: "destructive" });
        return;
      }
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        toast({ title: "Invalid file type", description: "Please select a JPEG, PNG, or WebP image", variant: "destructive" });
        return;
      }
      const compressed = await compressImage(file);
      if (compressed.size > 10 * 1024 * 1024) {
        toast({ title: "File too large", description: "Please select a photo that compresses under 10MB", variant: "destructive" });
        return;
      }
      setPhotoFile(compressed);
      setPhotoPreview(URL.createObjectURL(compressed));
    }
  };

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!signature) throw new Error(t("dropoff.error.signature_required", "Please provide your signature"));
      if (!photoFile) throw new Error(t("dropoff.error.photo_required", "Please upload a photo"));
      
      for (let i = 0; i < children.length; i++) {
        if (!children[i].name.trim()) {
          throw new Error(`Please enter name for Child ${i + 1}`);
        }
        if (!children[i].age) {
          throw new Error(`Please select age for Child ${i + 1}`);
        }
      }

      const contactMethod = formValues.contact_method || "whatsapp";
      if (contactMethod === "whatsapp" && !formValues.whatsapp_number) {
        throw new Error(t("dropoff.error.whatsapp_required", "Please enter your WhatsApp number"));
      }
      if (contactMethod === "telegram" && !formValues.telegram_phone) {
        throw new Error(t("dropoff.error.telegram_required", "Please enter your Telegram phone number"));
      }

      const formData = new FormData();
      formData.append("branchId", branchId!);
      formData.append("branchToken", token!);
      formData.append("parentFullName", formValues.parent_full_name || "");
      formData.append("contactMethod", contactMethod);
      formData.append("whatsappPhone", formValues.whatsapp_number || "");
      formData.append("telegramPhone", formValues.telegram_phone || "");
      formData.append("children", JSON.stringify(children));
      formData.append("hasAllergiesOrMedical", formValues.allergies_medical === "yes" ? "true" : "false");
      formData.append("allergiesMedicalDetails", formValues.allergies_details || "");
      formData.append("allowStaffOrderFood", formValues.allow_food_order === "yes" ? "true" : "false");
      formData.append("foodNotesRestrictions", formValues.food_restrictions || "");
      formData.append("confirmMall15min", String(formValues.confirm_15min === true));
      formData.append("confirmEarlyPickupRefund", String(formValues.confirm_refund === true));
      formData.append("confirmEvacLoadingBay", String(formValues.confirm_evac === true));
      formData.append("signature", signature);
      formData.append("photo", photoFile);
      formData.append("formData", JSON.stringify(formValues));

      const res = await fetch("/api/public/dropoff-checkin", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const error = await res.json();
          throw new Error(error.message || "Submission failed");
        }
        throw new Error("Submission failed. Please try again.");
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

  const renderField = (field: FormFieldConfig): JSX.Element | null => {
    if (!isFieldVisible(field)) return null;

    const label = t(field.labelKey, field.labelKey);
    const placeholder = field.placeholderKey ? t(field.placeholderKey, "") : "";
    const helpText = field.helpTextKey ? t(field.helpTextKey, "") : "";
    const requiredMark = field.required ? " *" : "";
    const value = formValues[field.id] ?? "";

    switch (field.type) {
      case "text":
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <Input
              placeholder={placeholder}
              value={value}
              onChange={(e) => updateFormValue(field.id, e.target.value)}
              data-testid={`input-${field.id}`}
            />
            {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
          </div>
        );

      case "textarea":
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <Textarea
              placeholder={placeholder}
              value={value}
              onChange={(e) => updateFormValue(field.id, e.target.value)}
              data-testid={`textarea-${field.id}`}
            />
            {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
          </div>
        );

      case "phone":
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <PhoneInput
              international
              defaultCountry="TH"
              value={value}
              onChange={(v) => updateFormValue(field.id, v || "")}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm"
              data-testid={`phone-${field.id}`}
            />
            {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
          </div>
        );

      case "radio":
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <RadioGroup
              value={value}
              onValueChange={(v) => updateFormValue(field.id, v)}
              className="flex flex-wrap gap-4"
            >
              {field.options?.map((opt) => (
                <div key={opt.value} className="flex items-center space-x-2">
                  <RadioGroupItem value={opt.value} id={`${field.id}-${opt.value}`} data-testid={`radio-${field.id}-${opt.value}`} />
                  <Label htmlFor={`${field.id}-${opt.value}`}>{t(opt.labelKey, opt.value)}</Label>
                </div>
              ))}
            </RadioGroup>
            {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
          </div>
        );

      case "checkbox":
        return (
          <div key={field.id} className="flex items-start space-x-3">
            <Checkbox
              checked={value === true}
              onCheckedChange={(checked) => updateFormValue(field.id, checked === true)}
              data-testid={`checkbox-${field.id}`}
            />
            <Label className="font-normal text-sm leading-tight">{label}{requiredMark}</Label>
          </div>
        );

      case "select":
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <Select value={value} onValueChange={(v) => updateFormValue(field.id, v)}>
              <SelectTrigger data-testid={`select-${field.id}`}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey, opt.value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
          </div>
        );

      default:
        return (
          <div key={field.id} className="space-y-1">
            <Label>{label}{requiredMark}</Label>
            <Input
              placeholder={placeholder}
              value={value}
              onChange={(e) => updateFormValue(field.id, e.target.value)}
              data-testid={`input-${field.id}`}
            />
          </div>
        );
    }
  };

  const renderSection = (section: FormSectionConfig): JSX.Element => {
    const IconComponent = SECTION_ICONS[section.id] || User;
    const sortedFields = [...section.fields].sort((a, b) => a.displayOrder - b.displayOrder);
    const visibleFields = sortedFields.filter(isFieldVisible);

    if (visibleFields.length === 0) return <></>;

    if (section.id === "children_info") {
      return (
        <Card key={section.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Baby className="h-4 w-4" />
              {t(section.titleKey, "Children")}
            </CardTitle>
            {section.descriptionKey && (
              <CardDescription>{t(section.descriptionKey, "")}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>{t("dropoff.num_children.label", "Number of Children")}</Label>
              <Select value={String(numberOfChildren)} onValueChange={(val) => handleNumberOfChildrenChange(parseInt(val))}>
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
              <div key={index} className="space-y-2 p-3 bg-muted/30 rounded-lg">
                <p className="text-sm font-medium text-muted-foreground">{t("dropoff.child_header", "Child")} {index + 1}</p>
                <div>
                  <Label>{t("dropoff.child_name.label", "Full Name")} *</Label>
                  <Input 
                    placeholder={t("dropoff.child_name.placeholder", "Child's name")} 
                    value={child.name} 
                    onChange={(e) => updateChild(index, "name", e.target.value)} 
                    data-testid={`input-child-name-${index}`}
                  />
                </div>
                <div>
                  <Label>{t("dropoff.child_age.label", "Age")} *</Label>
                  <Select value={child.age} onValueChange={(val) => updateChild(index, "age", val)}>
                    <SelectTrigger data-testid={`select-child-age-${index}`}>
                      <SelectValue placeholder={t("dropoff.child_age.placeholder", "Select age")} />
                    </SelectTrigger>
                    <SelectContent>
                      {[3, 4, 5, 6, 7, 8].map((age) => (
                        <SelectItem key={age} value={String(age)}>{age} {t("dropoff.years", "years")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      );
    }

    if (section.id === "photo_section") {
      return (
        <Card key={section.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Camera className="h-4 w-4" />
              {t(section.titleKey, "Photo")} *
            </CardTitle>
            {section.descriptionKey && (
              <CardDescription>{t(section.descriptionKey, "Upload a photo of parent and child together")}</CardDescription>
            )}
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
                <img src={photoPreview} alt="Preview" className="w-full max-h-48 object-cover rounded-md" />
                <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full" data-testid="button-change-photo">
                  <Camera className="h-4 w-4 mr-2" /> {t("dropoff.change_photo", "Change Photo")}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full h-24 border-dashed" data-testid="button-upload-photo">
                <Upload className="h-4 w-4 mr-2" /> {t("dropoff.upload_photo", "Upload Photo")}
              </Button>
            )}
          </CardContent>
        </Card>
      );
    }

    if (section.id === "signature_section") {
      return (
        <Card key={section.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Pen className="h-4 w-4" />
              {t(section.titleKey, "Signature")} *
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SignatureCanvas onSignatureChange={setSignature} />
          </CardContent>
        </Card>
      );
    }

    return (
      <Card key={section.id}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <IconComponent className="h-4 w-4" />
            {t(section.titleKey, section.id)}
          </CardTitle>
          {section.descriptionKey && (
            <CardDescription>{t(section.descriptionKey, "")}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedFields.map(renderField)}
        </CardContent>
      </Card>
    );
  };

  const sortedSections = useMemo(() => {
    if (!formConfig?.schema?.sections) return [];
    return [...formConfig.schema.sections].sort((a, b) => a.displayOrder - b.displayOrder);
  }, [formConfig]);

  if (!branchId || !token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Invalid Link</h2>
            <p className="text-muted-foreground">Please scan the QR code at the reception.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (branchLoading || formConfigLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (branchError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Branch Not Found</h2>
            <p className="text-muted-foreground">Please scan the QR code at the reception.</p>
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
            <h2 className="text-xl font-semibold mb-2">{t("dropoff.success.title", "Thank You!")}</h2>
            <p className="text-muted-foreground mb-4">{t("dropoff.success.message", "Your check-in has been submitted successfully.")}</p>
            <div className="bg-muted rounded-lg p-4">
              <p className="font-medium">{t("dropoff.success.proceed", "Please proceed to reception")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("dropoff.success.verify", "Staff will verify your check-in.")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formValues.parent_full_name?.trim()) {
      toast({ title: "Required", description: t("dropoff.error.name_required", "Please enter your full name"), variant: "destructive" });
      return;
    }
    
    submitMutation.mutate();
  };

  const renderFallbackForm = () => (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-4 w-4" />
            {t("dropoff.section.guardian.title", "Parent / Guardian")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>{t("dropoff.parent_full_name.label", "Full Name")} *</Label>
            <Input
              placeholder={t("dropoff.parent_full_name.placeholder", "Your full name")}
              value={formValues.parent_full_name || ""}
              onChange={(e) => updateFormValue("parent_full_name", e.target.value)}
              data-testid="input-parent-name"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("dropoff.contact_method.label", "Preferred Contact Method")} *</Label>
            <RadioGroup
              value={formValues.contact_method || "whatsapp"}
              onValueChange={(v) => updateFormValue("contact_method", v)}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="whatsapp" id="contact-whatsapp" data-testid="radio-whatsapp" />
                <Label htmlFor="contact-whatsapp" className="cursor-pointer">WhatsApp</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="telegram" id="contact-telegram" data-testid="radio-telegram" />
                <Label htmlFor="contact-telegram" className="cursor-pointer">Telegram</Label>
              </div>
            </RadioGroup>
          </div>
          
          {(formValues.contact_method || "whatsapp") === "whatsapp" && (
            <div className="space-y-1">
              <Label>{t("dropoff.whatsapp_number.label", "WhatsApp Number")} *</Label>
              <PhoneInput
                international
                defaultCountry="TH"
                value={formValues.whatsapp_number || ""}
                onChange={(v) => updateFormValue("whatsapp_number", v || "")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm"
                data-testid="input-phone"
              />
            </div>
          )}
          
          {(formValues.contact_method || "whatsapp") === "telegram" && (
            <div className="space-y-1">
              <Label>{t("dropoff.telegram_phone.label", "Telegram Phone Number")} *</Label>
              <PhoneInput
                international
                defaultCountry="TH"
                value={formValues.telegram_phone || ""}
                onChange={(v) => updateFormValue("telegram_phone", v || "")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm"
                data-testid="input-telegram"
              />
              <p className="text-xs text-muted-foreground">
                {t("dropoff.telegram_phone.help", "Enter your phone number linked to Telegram")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Baby className="h-4 w-4" />
            {t("dropoff.section.children.title", "Children")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>{t("dropoff.num_children.label", "Number of Children")}</Label>
            <Select value={String(numberOfChildren)} onValueChange={(val) => handleNumberOfChildrenChange(parseInt(val))}>
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
            <div key={index} className="space-y-2 p-3 bg-muted/30 rounded-lg">
              <p className="text-sm font-medium text-muted-foreground">{t("dropoff.child_header", "Child")} {index + 1}</p>
              <div>
                <Label>{t("dropoff.child_name.label", "Full Name")} *</Label>
                <Input 
                  placeholder={t("dropoff.child_name.placeholder", "Child's name")} 
                  value={child.name} 
                  onChange={(e) => updateChild(index, "name", e.target.value)} 
                  data-testid={`input-child-name-${index}`}
                />
              </div>
              <div>
                <Label>{t("dropoff.child_age.label", "Age")} *</Label>
                <Select value={child.age} onValueChange={(val) => updateChild(index, "age", val)}>
                  <SelectTrigger data-testid={`select-child-age-${index}`}>
                    <SelectValue placeholder={t("dropoff.child_age.placeholder", "Select age")} />
                  </SelectTrigger>
                  <SelectContent>
                    {[3, 4, 5, 6, 7, 8].map((age) => (
                      <SelectItem key={age} value={String(age)}>{age} {t("dropoff.years", "years")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Heart className="h-4 w-4" />
            {t("dropoff.section.health.title", "Health & Safety")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>{t("dropoff.allergies_question.label", "Any allergies or medical conditions?")} *</Label>
            <RadioGroup
              value={formValues.allergies_medical || "no"}
              onValueChange={(v) => updateFormValue("allergies_medical", v)}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="no" id="allergies-no" data-testid="radio-allergies-no" />
                <Label htmlFor="allergies-no">{t("dropoff.no", "No")}</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="yes" id="allergies-yes" data-testid="radio-allergies-yes" />
                <Label htmlFor="allergies-yes">{t("dropoff.yes", "Yes")}</Label>
              </div>
            </RadioGroup>
          </div>
          {formValues.allergies_medical === "yes" && (
            <div className="space-y-1">
              <Label>{t("dropoff.allergies_details.label", "Details")} *</Label>
              <Textarea
                placeholder={t("dropoff.allergies_details.placeholder", "Describe allergies or medical conditions...")}
                value={formValues.allergies_details || ""}
                onChange={(e) => updateFormValue("allergies_details", e.target.value)}
                data-testid="input-allergies-details"
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Utensils className="h-4 w-4" />
            {t("dropoff.section.food.title", "Food & Drinks")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>{t("dropoff.food_question.label", "May staff order food for your child?")} *</Label>
            <RadioGroup
              value={formValues.allow_food_order || "no"}
              onValueChange={(v) => updateFormValue("allow_food_order", v)}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="no" id="food-no" data-testid="radio-food-no" />
                <Label htmlFor="food-no">{t("dropoff.no", "No")}</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="yes" id="food-yes" data-testid="radio-food-yes" />
                <Label htmlFor="food-yes">{t("dropoff.yes", "Yes")}</Label>
              </div>
            </RadioGroup>
          </div>
          <div className="space-y-1">
            <Label>{t("dropoff.food_restrictions.label", "Food restrictions (optional)")}</Label>
            <Textarea
              placeholder={t("dropoff.food_restrictions.placeholder", "Any dietary restrictions...")}
              value={formValues.food_restrictions || ""}
              onChange={(e) => updateFormValue("food_restrictions", e.target.value)}
              data-testid="input-food-notes"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Camera className="h-4 w-4" />
            {t("dropoff.section.photo.title", "Photo")} *
          </CardTitle>
          <CardDescription>{t("dropoff.section.photo.description", "Upload a photo of parent and child together")}</CardDescription>
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
              <img src={photoPreview} alt="Preview" className="w-full max-h-48 object-cover rounded-md" />
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full" data-testid="button-change-photo">
                <Camera className="h-4 w-4 mr-2" /> {t("dropoff.change_photo", "Change Photo")}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full h-24 border-dashed" data-testid="button-upload-photo">
              <Upload className="h-4 w-4 mr-2" /> {t("dropoff.upload_photo", "Upload Photo")}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Pen className="h-4 w-4" />
            {t("dropoff.section.signature.title", "Signature")} *
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SignatureCanvas onSignatureChange={setSignature} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {t("dropoff.section.confirmations.title", "Confirmations")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              checked={formValues.confirm_15min === true}
              onCheckedChange={(checked) => updateFormValue("confirm_15min", checked === true)}
              data-testid="checkbox-mall-15min"
            />
            <Label className="font-normal text-sm leading-tight">{t("dropoff.confirm_mall.label", "I will remain within 15 minutes of the venue")} *</Label>
          </div>
          <div className="flex items-start space-x-3">
            <Checkbox
              checked={formValues.confirm_refund === true}
              onCheckedChange={(checked) => updateFormValue("confirm_refund", checked === true)}
              data-testid="checkbox-refund"
            />
            <Label className="font-normal text-sm leading-tight">{t("dropoff.confirm_refund.label", "I understand early pickup does not qualify for refund")} *</Label>
          </div>
          <div className="flex items-start space-x-3">
            <Checkbox
              checked={formValues.confirm_evac === true}
              onCheckedChange={(checked) => updateFormValue("confirm_evac", checked === true)}
              data-testid="checkbox-evac"
            />
            <Label className="font-normal text-sm leading-tight">{t("dropoff.confirm_evac.label", "I acknowledge the emergency evacuation point")} *</Label>
          </div>
        </CardContent>
      </Card>
    </>
  );

  return (
    <div className="min-h-screen bg-background" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="max-w-lg mx-auto p-4 pb-8">
        <div className="text-center mb-6">
          <Baby className="h-10 w-10 text-primary mx-auto mb-2" />
          <h2 className="text-lg font-semibold mb-1">
            {formConfig?.schema?.titleKey ? t(formConfig.schema.titleKey, "Drop-Off Service Check-In") : "Drop-Off Service Check-In"}
          </h2>
          <p className="text-xs text-muted-foreground">{branchData?.name || "Loading..."}</p>
          
          {formConfig?.availableLanguages && formConfig.availableLanguages.length > 1 && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <Select value={selectedLang} onValueChange={setSelectedLang}>
                <SelectTrigger className="w-32 h-8 text-xs" data-testid="select-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {formConfig.availableLanguages.map(lang => (
                    <SelectItem key={lang} value={lang}>
                      {LANGUAGE_LABELS[lang] || lang}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {formConfig?.schema?.sections && sortedSections.length > 0 
            ? sortedSections.map(renderSection)
            : renderFallbackForm()
          }

          <Button type="submit" className="w-full" size="lg" disabled={submitMutation.isPending} data-testid="button-submit">
            {submitMutation.isPending 
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t("dropoff.submitting", "Submitting...")}</> 
              : t("dropoff.submit", "Submit Check-In")
            }
          </Button>
        </form>
      </div>
    </div>
  );
}
