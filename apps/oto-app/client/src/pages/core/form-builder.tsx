import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Plus, Trash2, GripVertical, Eye, Languages, Upload, Save, FileText, ChevronRight, ChevronDown, Settings, AlertCircle, Check, Clock, History } from "lucide-react";

interface FormField {
  id: string;
  type: "text" | "textarea" | "number" | "date" | "time" | "select" | "radio" | "checkbox" | "phone" | "email" | "multitext" | "signature" | "photo" | "section_header";
  labelKey: string;
  placeholderKey?: string;
  required?: boolean;
  options?: { value: string; labelKey: string }[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
  conditionalOn?: {
    fieldId: string;
    value: string | boolean;
  };
}

interface FormSection {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  fields: FormField[];
  repeatable?: boolean;
  maxRepeats?: number;
}

interface FormSchema {
  titleKey: string;
  sections: FormSection[];
}

interface Translation {
  key: string;
  value: string;
  isOverride?: boolean;
}

interface FormVersion {
  id: number;
  formId: number;
  versionNumber: number;
  schemaJson: FormSchema;
  status: "draft" | "published";
  publishedAt: string | null;
  publishedByUserId: number | null;
  createdAt: string;
}

interface DropoffFormData {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  activePublishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DropoffFormResponse {
  form: DropoffFormData;
  draftVersion?: {
    id: string;
    formId: string;
    versionNumber: number;
    schemaJson: FormSchema;
    isDraft: boolean;
    publishedAt: string | null;
    createdAt: string;
  };
  publishedVersion?: {
    id: string;
    formId: string;
    versionNumber: number;
    schemaJson: FormSchema;
    isDraft: boolean;
    publishedAt: string | null;
    createdAt: string;
  };
}

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "th", name: "Thai" },
  { code: "ru", name: "Russian" },
  { code: "zh", name: "Chinese" },
];

const FIELD_TYPES = [
  { value: "text", label: "Text Input" },
  { value: "textarea", label: "Text Area" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "select", label: "Dropdown" },
  { value: "radio", label: "Radio Buttons" },
  { value: "checkbox", label: "Checkbox" },
  { value: "phone", label: "Phone Number" },
  { value: "email", label: "Email" },
  { value: "multitext", label: "Multiple Text Inputs" },
  { value: "signature", label: "Signature" },
  { value: "photo", label: "Photo Upload" },
  { value: "section_header", label: "Section Header" },
];

function generateId(): string {
  return `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export default function FormBuilderPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("builder");
  const [selectedLang, setSelectedLang] = useState("en");
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [editingSchema, setEditingSchema] = useState<FormSchema | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);

  const { data: formResponse, isLoading: formLoading, error: formError } = useQuery<DropoffFormResponse>({
    queryKey: ["/api/dropoff-form"],
  });

  const form = formResponse?.form;
  const draftVersion = formResponse?.draftVersion;
  const publishedVersion = formResponse?.publishedVersion;

  const { data: translations, isLoading: translationsLoading } = useQuery<Translation[]>({
    queryKey: [`/api/dropoff-form/${form?.id}/translations/${selectedLang}`],
    enabled: !!form?.id,
  });

  const { data: versions, isLoading: versionsLoading } = useQuery<FormVersion[]>({
    queryKey: [`/api/dropoff-form/${form?.id}/versions`],
    enabled: !!form?.id,
  });

  useEffect(() => {
    if (draftVersion?.schemaJson) {
      setEditingSchema(draftVersion.schemaJson as unknown as FormSchema);
    }
  }, [draftVersion]);

  const saveDraftMutation = useMutation({
    mutationFn: async (schema: FormSchema) => {
      if (!form?.id) throw new Error("Form not loaded");
      return apiRequest("PUT", `/api/dropoff-form/${form.id}/draft`, { schemaJson: schema });
    },
    onSuccess: () => {
      toast({ title: "Draft saved", description: "Your changes have been saved as a draft." });
      queryClient.invalidateQueries({ queryKey: ["/api/dropoff-form"] });
      setIsDirty(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error saving draft", description: error.message, variant: "destructive" });
    },
  });

  const saveTranslationMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return apiRequest("PUT", `/api/dropoff-form/translation`, { lang: selectedLang, key, value });
    },
    onSuccess: () => {
      toast({ title: "Translation saved" });
      queryClient.invalidateQueries({ queryKey: [`/api/dropoff-form/${form?.id}/translations/${selectedLang}`] });
    },
    onError: (error: Error) => {
      toast({ title: "Error saving translation", description: error.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!form?.id) throw new Error("Form not loaded");
      return apiRequest("POST", `/api/dropoff-form/${form.id}/publish`, {});
    },
    onSuccess: () => {
      toast({ title: "Form published", description: "The form is now live for guests." });
      queryClient.invalidateQueries({ queryKey: ["/api/dropoff-form"] });
      queryClient.invalidateQueries({ queryKey: [`/api/dropoff-form/${form?.id}/versions`] });
      setShowPublishDialog(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error publishing", description: error.message, variant: "destructive" });
    },
  });

  const updateSchema = (newSchema: FormSchema) => {
    setEditingSchema(newSchema);
    setIsDirty(true);
  };

  const addSection = () => {
    if (!editingSchema) return;
    const newSection: FormSection = {
      id: generateId(),
      titleKey: `section.new_${Date.now()}`,
      fields: [],
    };
    updateSchema({
      ...editingSchema,
      sections: [...editingSchema.sections, newSection],
    });
    setExpandedSections([...expandedSections, newSection.id]);
  };

  const removeSection = (sectionId: string) => {
    if (!editingSchema) return;
    updateSchema({
      ...editingSchema,
      sections: editingSchema.sections.filter((s) => s.id !== sectionId),
    });
  };

  const updateSection = (sectionId: string, updates: Partial<FormSection>) => {
    if (!editingSchema) return;
    updateSchema({
      ...editingSchema,
      sections: editingSchema.sections.map((s) => (s.id === sectionId ? { ...s, ...updates } : s)),
    });
  };

  const addField = (sectionId: string) => {
    if (!editingSchema) return;
    const newField: FormField = {
      id: generateId(),
      type: "text",
      labelKey: `field.new_${Date.now()}`,
      required: false,
    };
    updateSchema({
      ...editingSchema,
      sections: editingSchema.sections.map((s) =>
        s.id === sectionId ? { ...s, fields: [...s.fields, newField] } : s
      ),
    });
  };

  const updateField = (sectionId: string, fieldId: string, updates: Partial<FormField>) => {
    if (!editingSchema) return;
    updateSchema({
      ...editingSchema,
      sections: editingSchema.sections.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)),
            }
          : s
      ),
    });
  };

  const removeField = (sectionId: string, fieldId: string) => {
    if (!editingSchema) return;
    updateSchema({
      ...editingSchema,
      sections: editingSchema.sections.map((s) =>
        s.id === sectionId ? { ...s, fields: s.fields.filter((f) => f.id !== fieldId) } : s
      ),
    });
  };

  const getTranslation = (key: string): string => {
    const trans = translations?.find((t) => t.key === key);
    return trans?.value || key;
  };

  if (formLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (formError) {
    return (
      <Card className="m-4">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-destructive" data-testid="error-message">
            <AlertCircle className="w-5 h-5" />
            <span>Failed to load form builder. Please try again.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="page-title">Drop-off Form Builder</h1>
          <p className="text-muted-foreground">
            Customize the guest drop-off check-in form with multi-language support
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Badge variant="outline" className="text-orange-600 border-orange-300">
              Unsaved changes
            </Badge>
          )}
          {draftVersion?.isDraft && (
            <Badge variant="secondary">Draft v{draftVersion.versionNumber}</Badge>
          )}
          {publishedVersion && (
            <Badge variant="default" className="bg-green-600">
              Live v{publishedVersion.versionNumber}
            </Badge>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4 mb-6">
          <TabsTrigger value="builder" className="gap-2" data-testid="tab-builder">
            <Settings className="w-4 h-4" />
            Builder
          </TabsTrigger>
          <TabsTrigger value="preview" className="gap-2" data-testid="tab-preview">
            <Eye className="w-4 h-4" />
            Preview
          </TabsTrigger>
          <TabsTrigger value="translations" className="gap-2" data-testid="tab-translations">
            <Languages className="w-4 h-4" />
            Translations
          </TabsTrigger>
          <TabsTrigger value="publish" className="gap-2" data-testid="tab-publish">
            <Upload className="w-4 h-4" />
            Publish
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="space-y-4">
          <div className="flex justify-between items-center">
            <Button onClick={addSection} data-testid="button-add-section">
              <Plus className="w-4 h-4 mr-2" />
              Add Section
            </Button>
            <Button
              onClick={() => editingSchema && saveDraftMutation.mutate(editingSchema)}
              disabled={!isDirty || saveDraftMutation.isPending}
              data-testid="button-save-draft"
            >
              {saveDraftMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Draft
            </Button>
          </div>

          {editingSchema && (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Form Title Key</CardTitle>
                </CardHeader>
                <CardContent>
                  <Input
                    value={editingSchema.titleKey}
                    onChange={(e) => updateSchema({ ...editingSchema, titleKey: e.target.value })}
                    placeholder="dropoff.title"
                    data-testid="input-form-title-key"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Translation: {getTranslation(editingSchema.titleKey)}
                  </p>
                </CardContent>
              </Card>

              <Accordion
                type="multiple"
                value={expandedSections}
                onValueChange={setExpandedSections}
              >
                {editingSchema.sections.map((section, sectionIndex) => (
                  <AccordionItem key={section.id} value={section.id} className="border rounded-lg mb-2">
                    <AccordionTrigger className="px-4 hover:no-underline">
                      <div className="flex items-center gap-3 flex-1">
                        <GripVertical className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium">
                          Section {sectionIndex + 1}: {getTranslation(section.titleKey)}
                        </span>
                        <Badge variant="outline" className="ml-2">
                          {section.fields.length} fields
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-4">
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label>Title Key</Label>
                            <Input
                              value={section.titleKey}
                              onChange={(e) => updateSection(section.id, { titleKey: e.target.value })}
                              data-testid={`input-section-title-${section.id}`}
                            />
                          </div>
                          <div>
                            <Label>Description Key (optional)</Label>
                            <Input
                              value={section.descriptionKey || ""}
                              onChange={(e) => updateSection(section.id, { descriptionKey: e.target.value || undefined })}
                              data-testid={`input-section-desc-${section.id}`}
                            />
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={section.repeatable || false}
                              onCheckedChange={(checked) => updateSection(section.id, { repeatable: checked })}
                              data-testid={`switch-repeatable-${section.id}`}
                            />
                            <Label>Repeatable Section</Label>
                          </div>
                          {section.repeatable && (
                            <div className="flex items-center gap-2">
                              <Label>Max Repeats</Label>
                              <Input
                                type="number"
                                className="w-20"
                                value={section.maxRepeats || ""}
                                onChange={(e) => updateSection(section.id, { maxRepeats: parseInt(e.target.value) || undefined })}
                                data-testid={`input-max-repeats-${section.id}`}
                              />
                            </div>
                          )}
                        </div>

                        <div className="border-t pt-4">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-medium">Fields</h4>
                            <Button size="sm" variant="outline" onClick={() => addField(section.id)} data-testid={`button-add-field-${section.id}`}>
                              <Plus className="w-3 h-3 mr-1" />
                              Add Field
                            </Button>
                          </div>

                          <div className="space-y-3">
                            {section.fields.map((field, fieldIndex) => (
                              <Card key={field.id} className="p-3">
                                <div className="flex items-start gap-3">
                                  <GripVertical className="w-4 h-4 mt-2 text-muted-foreground cursor-move" />
                                  <div className="flex-1 grid grid-cols-3 gap-3">
                                    <div>
                                      <Label className="text-xs">Label Key</Label>
                                      <Input
                                        value={field.labelKey}
                                        onChange={(e) => updateField(section.id, field.id, { labelKey: e.target.value })}
                                        className="text-sm"
                                        data-testid={`input-field-label-${field.id}`}
                                      />
                                    </div>
                                    <div>
                                      <Label className="text-xs">Type</Label>
                                      <Select
                                        value={field.type}
                                        onValueChange={(value) => updateField(section.id, field.id, { type: value as FormField["type"] })}
                                      >
                                        <SelectTrigger className="text-sm" data-testid={`select-field-type-${field.id}`}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {FIELD_TYPES.map((ft) => (
                                            <SelectItem key={ft.value} value={ft.value}>
                                              {ft.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <div className="flex items-end gap-2">
                                      <div className="flex items-center gap-2">
                                        <Checkbox
                                          checked={field.required || false}
                                          onCheckedChange={(checked) => updateField(section.id, field.id, { required: !!checked })}
                                          data-testid={`checkbox-required-${field.id}`}
                                        />
                                        <Label className="text-xs">Required</Label>
                                      </div>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="text-destructive"
                                        onClick={() => removeField(section.id, field.id)}
                                        data-testid={`button-remove-field-${field.id}`}
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 ml-7">
                                  → {getTranslation(field.labelKey)}
                                </p>
                              </Card>
                            ))}

                            {section.fields.length === 0 && (
                              <p className="text-sm text-muted-foreground text-center py-4">
                                No fields yet. Click "Add Field" to get started.
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex justify-end pt-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => removeSection(section.id)}
                            data-testid={`button-remove-section-${section.id}`}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Remove Section
                          </Button>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {editingSchema.sections.length === 0 && (
                <Card className="p-8 text-center">
                  <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">
                    No sections yet. Click "Add Section" to start building your form.
                  </p>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="preview">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Form Preview</CardTitle>
                <Select value={selectedLang} onValueChange={setSelectedLang}>
                  <SelectTrigger className="w-40" data-testid="select-preview-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <CardDescription>
                Preview how the form will appear to guests in different languages
              </CardDescription>
            </CardHeader>
            <CardContent>
              {editingSchema && (
                <div className="border rounded-lg p-6 bg-muted/30">
                  <h2 className="text-xl font-bold mb-6">{getTranslation(editingSchema.titleKey)}</h2>
                  {editingSchema.sections.map((section) => (
                    <div key={section.id} className="mb-6">
                      <h3 className="text-lg font-semibold mb-2">{getTranslation(section.titleKey)}</h3>
                      {section.descriptionKey && (
                        <p className="text-sm text-muted-foreground mb-3">{getTranslation(section.descriptionKey)}</p>
                      )}
                      <div className="space-y-3">
                        {section.fields.map((field) => (
                          <div key={field.id}>
                            <Label>
                              {getTranslation(field.labelKey)}
                              {field.required && <span className="text-destructive ml-1">*</span>}
                            </Label>
                            {field.type === "text" && <Input placeholder={field.placeholderKey ? getTranslation(field.placeholderKey) : ""} disabled />}
                            {field.type === "textarea" && <Textarea placeholder={field.placeholderKey ? getTranslation(field.placeholderKey) : ""} disabled />}
                            {field.type === "select" && (
                              <Select disabled>
                                <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                              </Select>
                            )}
                            {field.type === "checkbox" && (
                              <div className="flex items-center gap-2">
                                <Checkbox disabled />
                                <span className="text-sm">{getTranslation(field.labelKey)}</span>
                              </div>
                            )}
                            {["number", "date", "time", "phone", "email"].includes(field.type) && (
                              <Input type={field.type} disabled />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="translations">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Translations</CardTitle>
                  <CardDescription>
                    Manage translations for all form labels and text
                  </CardDescription>
                </div>
                <Select value={selectedLang} onValueChange={setSelectedLang}>
                  <SelectTrigger className="w-40" data-testid="select-translation-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {translationsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : (
                <div className="space-y-4">
                  {editingSchema && (
                    <>
                      <div className="border rounded-lg p-4">
                        <Label className="text-xs text-muted-foreground">{editingSchema.titleKey}</Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            value={getTranslation(editingSchema.titleKey)}
                            onChange={(e) => {
                              saveTranslationMutation.mutate({ key: editingSchema.titleKey, value: e.target.value });
                            }}
                            data-testid={`input-trans-${editingSchema.titleKey}`}
                          />
                        </div>
                      </div>

                      {editingSchema.sections.map((section) => (
                        <div key={section.id} className="border rounded-lg p-4 space-y-3">
                          <h4 className="font-medium text-sm">{section.titleKey}</h4>
                          <div>
                            <Label className="text-xs text-muted-foreground">{section.titleKey}</Label>
                            <Input
                              value={getTranslation(section.titleKey)}
                              onChange={(e) => saveTranslationMutation.mutate({ key: section.titleKey, value: e.target.value })}
                              data-testid={`input-trans-${section.titleKey}`}
                            />
                          </div>
                          {section.descriptionKey && (
                            <div>
                              <Label className="text-xs text-muted-foreground">{section.descriptionKey}</Label>
                              <Input
                                value={getTranslation(section.descriptionKey)}
                                onChange={(e) => saveTranslationMutation.mutate({ key: section.descriptionKey!, value: e.target.value })}
                              />
                            </div>
                          )}
                          {section.fields.map((field) => (
                            <div key={field.id}>
                              <Label className="text-xs text-muted-foreground">{field.labelKey}</Label>
                              <Input
                                value={getTranslation(field.labelKey)}
                                onChange={(e) => saveTranslationMutation.mutate({ key: field.labelKey, value: e.target.value })}
                                data-testid={`input-trans-${field.labelKey}`}
                              />
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="publish">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Current Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium">Draft Version</p>
                    <p className="text-sm text-muted-foreground">
                      {draftVersion ? `v${draftVersion.versionNumber}` : "No draft"}
                    </p>
                  </div>
                  {draftVersion?.isDraft && (
                    <Badge variant="secondary">Draft</Badge>
                  )}
                </div>

                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium">Published Version</p>
                    <p className="text-sm text-muted-foreground">
                      {publishedVersion ? `v${publishedVersion.versionNumber}` : "Not published yet"}
                    </p>
                  </div>
                  {publishedVersion && (
                    <Badge className="bg-green-600">Live</Badge>
                  )}
                </div>

                <Dialog open={showPublishDialog} onOpenChange={setShowPublishDialog}>
                  <DialogTrigger asChild>
                    <Button
                      className="w-full"
                      disabled={!draftVersion || !draftVersion.isDraft || isDirty}
                      data-testid="button-publish"
                    >
                      <Upload className="w-4 h-4 mr-2" />
                      Publish Draft
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Publish Form</DialogTitle>
                      <DialogDescription>
                        This will make the current draft version live for all guests. Are you sure?
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowPublishDialog(false)}>
                        Cancel
                      </Button>
                      <Button onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending}>
                        {publishMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Check className="w-4 h-4 mr-2" />
                        )}
                        Confirm Publish
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {isDirty && (
                  <p className="text-sm text-orange-600 flex items-center gap-1">
                    <AlertCircle className="w-4 h-4" />
                    Save your changes before publishing
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History className="w-5 h-5" />
                  Version History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {versionsLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                ) : versions && versions.length > 0 ? (
                  <div className="space-y-2">
                    {versions.map((version) => (
                      <div
                        key={version.id}
                        className="flex items-center justify-between p-3 border rounded-lg"
                      >
                        <div>
                          <p className="font-medium">Version {version.versionNumber}</p>
                          <p className="text-xs text-muted-foreground">
                            {version.publishedAt
                              ? `Published ${new Date(version.publishedAt).toLocaleDateString()}`
                              : `Created ${new Date(version.createdAt).toLocaleDateString()}`}
                          </p>
                        </div>
                        <Badge variant={version.status === "published" ? "default" : "secondary"}>
                          {version.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No versions yet
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
