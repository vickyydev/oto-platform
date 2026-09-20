import { useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SignatureCanvas } from "@/components/ui/signature-canvas";
import { Loader2, Plus, Trash2, Globe, Camera, Upload } from "lucide-react";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";

interface FormVisibilityRule {
  fieldId: string;
  operator: "equals" | "not_equals" | "contains" | "not_empty";
  value?: string;
}

interface FormFieldSchema {
  id: string;
  type: string;
  labelKey: string;
  placeholderKey?: string;
  helpTextKey?: string;
  required?: boolean;
  options?: Array<{ value: string; labelKey: string }>;
  displayOrder?: number;
  visibilityRule?: FormVisibilityRule;
}

interface FormSectionSchema {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  fields: FormFieldSchema[];
  repeatable?: boolean;
  maxRepeats?: number;
  displayOrder?: number;
}

interface FormSchema {
  titleKey: string;
  descriptionKey?: string;
  sections: FormSectionSchema[];
  submitTextKey?: string;
  successMessageKey?: string;
  requiresPhoto?: boolean;
  requiresSignature?: boolean;
}

export interface PublicFormData {
  versionId: number;
  schema: FormSchema;
  translations: Record<string, string>;
  language: string;
  availableLanguages: string[];
}

interface SchemaFormRendererProps {
  formData: PublicFormData;
  onSubmit: (data: Record<string, unknown>) => void;
  onLanguageChange: (lang: string) => void;
  isSubmitting?: boolean;
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  th: "ไทย",
  ru: "Русский",
  zh: "中文",
};

export function SchemaFormRenderer({ formData, onSubmit, onLanguageChange, isSubmitting }: SchemaFormRendererProps) {
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [repeatableSections, setRepeatableSections] = useState<Record<string, number>>({});
  const signatureRef = useRef<HTMLDivElement>(null);

  const t = (key: string): string => {
    return formData?.translations[key] || key;
  };

  const getFieldKey = (sectionId: string, fieldId: string, repeatIndex?: number): string => {
    if (repeatIndex !== undefined) {
      return `${sectionId}[${repeatIndex}].${fieldId}`;
    }
    return fieldId;
  };

  const updateValue = (sectionId: string, fieldId: string, value: unknown, repeatIndex?: number) => {
    const key = getFieldKey(sectionId, fieldId, repeatIndex);
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  const getValue = (sectionId: string, fieldId: string, repeatIndex?: number): unknown => {
    const key = getFieldKey(sectionId, fieldId, repeatIndex);
    return formValues[key];
  };

  const isFieldVisible = (field: FormFieldSchema, section: FormSectionSchema, repeatIndex?: number): boolean => {
    if (!field.visibilityRule) return true;
    
    const rule = field.visibilityRule;
    const targetValue = getValue(section.id, rule.fieldId, repeatIndex);
    const targetValueStr = String(targetValue || "");
    
    switch (rule.operator) {
      case "equals":
        return targetValueStr === rule.value;
      case "not_equals":
        return targetValueStr !== rule.value;
      case "contains":
        return targetValueStr.includes(rule.value || "");
      case "not_empty":
        return targetValueStr.trim().length > 0;
      default:
        return true;
    }
  };

  const addRepeat = (sectionId: string, max?: number) => {
    setRepeatableSections((prev) => {
      const current = prev[sectionId] || 1;
      if (max && current >= max) return prev;
      return { ...prev, [sectionId]: current + 1 };
    });
  };

  const removeRepeat = (sectionId: string, index: number) => {
    setRepeatableSections((prev) => {
      const current = prev[sectionId] || 1;
      if (current <= 1) return prev;
      return { ...prev, [sectionId]: current - 1 };
    });
    const prefix = `${sectionId}[${index}].`;
    const newValues = { ...formValues };
    Object.keys(newValues).forEach((key) => {
      if (key.startsWith(prefix)) {
        delete newValues[key];
      }
    });
    setFormValues(newValues);
  };

  const validateForm = (): string[] => {
    const errors: string[] = [];
    const schema = formData.schema;
    
    for (const section of schema.sections) {
      const repeatCount = section.repeatable ? (repeatableSections[section.id] || 1) : 1;
      
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex++) {
        for (const field of section.fields) {
          const actualRepeatIndex = section.repeatable ? repeatIndex : undefined;
          
          if (!isFieldVisible(field, section, actualRepeatIndex)) {
            continue;
          }
          
          if (field.required) {
            const value = section.repeatable 
              ? getValue(section.id, field.id, repeatIndex)
              : getValue(section.id, field.id);
            
            if (!value || (typeof value === 'string' && !value.trim())) {
              const label = t(field.labelKey);
              if (section.repeatable) {
                errors.push(`${label} (${repeatIndex + 1}) is required`);
              } else {
                errors.push(`${label} is required`);
              }
            }
          }
        }
      }
    }
    
    if (schema.requiresPhoto) {
      const hasPhoto = Object.keys(formValues).some(key => 
        key.includes('.photo') || key === 'photo'
      );
      if (!hasPhoto || !formValues[Object.keys(formValues).find(k => k.includes('photo')) || '']) {
        errors.push('Photo is required');
      }
    }
    
    if (schema.requiresSignature) {
      const hasSignature = Object.keys(formValues).some(key => 
        key.includes('.signature') || key === 'signature'
      );
      if (!hasSignature || !formValues[Object.keys(formValues).find(k => k.includes('signature')) || '']) {
        errors.push('Signature is required');
      }
    }
    
    return errors;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const errors = validateForm();
    if (errors.length > 0) {
      alert(errors.join('\n'));
      return;
    }
    
    onSubmit(formValues);
  };

  const renderField = (field: FormFieldSchema, section: FormSectionSchema, repeatIndex?: number) => {
    const fieldId = getFieldKey(section.id, field.id, repeatIndex);
    const value = getValue(section.id, field.id, repeatIndex);

    switch (field.type) {
      case "text":
      case "email":
        return (
          <div key={fieldId} className="space-y-2">
            <Label htmlFor={fieldId}>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={fieldId}
              type={field.type}
              placeholder={field.placeholderKey ? t(field.placeholderKey) : ""}
              value={(value as string) || ""}
              onChange={(e) => updateValue(section.id, field.id, e.target.value, repeatIndex)}
              data-testid={`input-${fieldId}`}
            />
            {field.helpTextKey && (
              <p className="text-sm text-muted-foreground">{t(field.helpTextKey)}</p>
            )}
          </div>
        );

      case "textarea":
        return (
          <div key={fieldId} className="space-y-2">
            <Label htmlFor={fieldId}>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Textarea
              id={fieldId}
              placeholder={field.placeholderKey ? t(field.placeholderKey) : ""}
              value={(value as string) || ""}
              onChange={(e) => updateValue(section.id, field.id, e.target.value, repeatIndex)}
              data-testid={`textarea-${fieldId}`}
            />
          </div>
        );

      case "number":
        return (
          <div key={fieldId} className="space-y-2">
            <Label htmlFor={fieldId}>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={fieldId}
              type="number"
              value={(value as number) || ""}
              onChange={(e) => updateValue(section.id, field.id, parseInt(e.target.value) || 0, repeatIndex)}
              data-testid={`input-${fieldId}`}
            />
          </div>
        );

      case "phone":
        return (
          <div key={fieldId} className="space-y-2">
            <Label htmlFor={fieldId}>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <PhoneInput
              international
              defaultCountry="TH"
              value={(value as string) || ""}
              onChange={(v) => updateValue(section.id, field.id, v || "", repeatIndex)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid={`phone-${fieldId}`}
            />
            {field.helpTextKey && (
              <p className="text-sm text-muted-foreground">{t(field.helpTextKey)}</p>
            )}
          </div>
        );

      case "select":
        return (
          <div key={fieldId} className="space-y-2">
            <Label htmlFor={fieldId}>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Select
              value={(value as string) || ""}
              onValueChange={(v) => updateValue(section.id, field.id, v, repeatIndex)}
            >
              <SelectTrigger data-testid={`select-${fieldId}`}>
                <SelectValue placeholder={field.placeholderKey ? t(field.placeholderKey) : ""} />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );

      case "radio":
        return (
          <div key={fieldId} className="space-y-2">
            <Label>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            {field.helpTextKey && (
              <p className="text-sm text-muted-foreground">{t(field.helpTextKey)}</p>
            )}
            <RadioGroup
              value={(value as string) || ""}
              onValueChange={(v) => updateValue(section.id, field.id, v, repeatIndex)}
              className="flex gap-4"
            >
              {field.options?.map((option) => (
                <div key={option.value} className="flex items-center space-x-2">
                  <RadioGroupItem 
                    value={option.value} 
                    id={`${fieldId}-${option.value}`}
                    data-testid={`radio-${fieldId}-${option.value}`}
                  />
                  <Label htmlFor={`${fieldId}-${option.value}`}>{t(option.labelKey)}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        );

      case "checkbox":
        return (
          <div key={fieldId} className="flex items-start space-x-3">
            <Checkbox
              id={fieldId}
              checked={(value as boolean) || false}
              onCheckedChange={(v) => updateValue(section.id, field.id, v, repeatIndex)}
              data-testid={`checkbox-${fieldId}`}
            />
            <Label htmlFor={fieldId} className="leading-tight">
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
          </div>
        );

      case "signature":
        return (
          <div key={fieldId} className="space-y-2" ref={signatureRef}>
            <Label>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <SignatureCanvas
              onSignatureChange={(data) => updateValue(section.id, field.id, data, repeatIndex)}
            />
          </div>
        );

      case "photo":
        const photoPreview = value as string | null;
        return (
          <div key={fieldId} className="space-y-2">
            <Label>
              {t(field.labelKey)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            {photoPreview ? (
              <div className="relative">
                <img 
                  src={photoPreview} 
                  alt="Photo preview" 
                  className="w-full max-w-[200px] rounded-md border"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => updateValue(section.id, field.id, null, repeatIndex)}
                  data-testid={`button-remove-photo-${fieldId}`}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.capture = "user";
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          updateValue(section.id, field.id, reader.result as string, repeatIndex);
                        };
                        reader.readAsDataURL(file);
                      }
                    };
                    input.click();
                  }}
                  data-testid={`button-take-photo-${fieldId}`}
                >
                  <Camera className="w-4 h-4 mr-2" />
                  Take Photo
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          updateValue(section.id, field.id, reader.result as string, repeatIndex);
                        };
                        reader.readAsDataURL(file);
                      }
                    };
                    input.click();
                  }}
                  data-testid={`button-upload-photo-${fieldId}`}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Upload
                </Button>
              </div>
            )}
          </div>
        );

      default:
        return (
          <div key={fieldId} className="space-y-2">
            <Label>{t(field.labelKey)}</Label>
            <Input disabled placeholder={`Unsupported field type: ${field.type}`} />
          </div>
        );
    }
  };

  const renderSection = (section: FormSectionSchema) => {
    const repeatCount = section.repeatable ? (repeatableSections[section.id] || 1) : 1;

    return (
      <Card key={section.id} className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t(section.titleKey)}</CardTitle>
          {section.descriptionKey && (
            <CardDescription>{t(section.descriptionKey)}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {section.repeatable ? (
            <>
              {Array.from({ length: repeatCount }).map((_, repeatIndex) => (
                <div key={repeatIndex} className="space-y-4 p-4 border rounded-lg relative">
                  {repeatCount > 1 && (
                    <div className="absolute top-2 right-2">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeRepeat(section.id, repeatIndex)}
                        data-testid={`button-remove-repeat-${section.id}-${repeatIndex}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                  <div className="text-sm font-medium text-muted-foreground mb-2">
                    #{repeatIndex + 1}
                  </div>
                  {section.fields
                    .filter((field) => isFieldVisible(field, section, repeatIndex))
                    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
                    .map((field) => renderField(field, section, repeatIndex))}
                </div>
              ))}
              {(!section.maxRepeats || repeatCount < section.maxRepeats) && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addRepeat(section.id, section.maxRepeats)}
                  className="w-full"
                  data-testid={`button-add-repeat-${section.id}`}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Another
                </Button>
              )}
            </>
          ) : (
            section.fields
              .filter((field) => isFieldVisible(field, section))
              .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
              .map((field) => renderField(field, section))
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="max-w-lg mx-auto p-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t(formData.schema.titleKey)}</h1>
        {formData.availableLanguages.length > 1 && (
          <Select value={formData.language} onValueChange={onLanguageChange}>
            <SelectTrigger className="w-32" data-testid="select-language">
              <Globe className="w-4 h-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formData.availableLanguages.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {LANGUAGE_LABELS[lang] || lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {formData.schema.descriptionKey && (
        <p className="text-muted-foreground mb-6">{t(formData.schema.descriptionKey)}</p>
      )}

      <form onSubmit={handleSubmit}>
        {formData.schema.sections
          .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
          .map((section) => renderSection(section))}

        <Button
          type="submit"
          className="w-full mt-4"
          disabled={isSubmitting}
          data-testid="button-submit-form"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Submitting...
            </>
          ) : (
            formData.schema.submitTextKey ? t(formData.schema.submitTextKey) : "Submit"
          )}
        </Button>
      </form>
    </div>
  );
}
