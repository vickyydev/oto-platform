import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Sparkles, Loader2, Check, X, Info } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ExtractedEventData {
  title?: string | null;
  event_type?: "birthday" | "private_event" | "school_group" | "other" | null;
  event_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  child_name?: string | null;
  booking_name?: string | null;
  parent_name?: string | null;
  whatsapp_phone?: string | null;
  num_children?: number | null;
  num_adults?: number | null;
  program_name?: string | null;
  program_details?: string | null;
  allergies_notes?: string | null;
  cake_notes?: string | null;
  special_requests?: string | null;
  internal_staff_notes?: string | null;
  total_value?: number | null;
  prepayment_amount?: number | null;
  prepayment_date?: string | null;
  prepayment_method?: string | null;
}

interface AIExtractionResponse {
  extracted: ExtractedEventData;
  missing_required?: string[];
  assumptions?: string[];
  suggested_branch_id?: string;
}

interface EventFormData {
  eventType?: "birthday" | "private_event" | "school_group" | "other";
  title?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string | null;
  childName?: string | null;
  bookingName?: string | null;
  parentName?: string | null;
  whatsappPhoneRaw?: string | null;
  numChildren?: number | null;
  numAdults?: number | null;
  programName?: string | null;
  programDetails?: string | null;
  allergiesNotes?: string | null;
  cakeNotes?: string | null;
  specialRequests?: string | null;
  internalStaffNotes?: string | null;
  totalValue?: number | null;
  prepaymentAmount?: number | null;
  prepaymentDate?: string | null;
  prepaymentMethod?: string | null;
  status?: "upcoming" | "in_progress" | "completed" | "cancelled";
}

interface FieldMapping {
  extractedKey: keyof ExtractedEventData;
  formKey: keyof EventFormData;
  label: string;
  type: "text" | "number" | "date" | "time" | "textarea" | "select";
  options?: { value: string; label: string }[];
}

const FIELD_MAPPINGS: FieldMapping[] = [
  { extractedKey: "title", formKey: "title", label: "Title", type: "text" },
  { extractedKey: "event_type", formKey: "eventType", label: "Event Type", type: "select", options: [
    { value: "birthday", label: "Birthday" },
    { value: "private_event", label: "Private Event" },
    { value: "school_group", label: "School Group" },
    { value: "other", label: "Other" },
  ]},
  { extractedKey: "event_date", formKey: "eventDate", label: "Date", type: "date" },
  { extractedKey: "start_time", formKey: "startTime", label: "Start Time", type: "time" },
  { extractedKey: "end_time", formKey: "endTime", label: "End Time", type: "time" },
  { extractedKey: "child_name", formKey: "childName", label: "Child Name", type: "text" },
  { extractedKey: "booking_name", formKey: "bookingName", label: "Booking Name", type: "text" },
  { extractedKey: "parent_name", formKey: "parentName", label: "Parent Name", type: "text" },
  { extractedKey: "whatsapp_phone", formKey: "whatsappPhoneRaw", label: "WhatsApp", type: "text" },
  { extractedKey: "num_children", formKey: "numChildren", label: "Children", type: "number" },
  { extractedKey: "num_adults", formKey: "numAdults", label: "Adults", type: "number" },
  { extractedKey: "program_name", formKey: "programName", label: "Program", type: "text" },
  { extractedKey: "program_details", formKey: "programDetails", label: "Program Details", type: "textarea" },
  { extractedKey: "allergies_notes", formKey: "allergiesNotes", label: "Allergies", type: "textarea" },
  { extractedKey: "cake_notes", formKey: "cakeNotes", label: "Cake", type: "textarea" },
  { extractedKey: "special_requests", formKey: "specialRequests", label: "Special Requests", type: "textarea" },
  { extractedKey: "internal_staff_notes", formKey: "internalStaffNotes", label: "Staff Notes", type: "textarea" },
  { extractedKey: "total_value", formKey: "totalValue", label: "Total Value", type: "number" },
  { extractedKey: "prepayment_amount", formKey: "prepaymentAmount", label: "Prepayment", type: "number" },
  { extractedKey: "prepayment_date", formKey: "prepaymentDate", label: "Prepayment Date", type: "date" },
  { extractedKey: "prepayment_method", formKey: "prepaymentMethod", label: "Payment Method", type: "text" },
];

interface AIEventAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFormData: EventFormData;
  onApply: (updates: Partial<EventFormData>) => void;
  onBranchSelect?: (branchId: string) => void;
  branchContext?: { branch_id: string; branch_name: string; timezone?: string };
}

export function AIEventAssistant({
  open,
  onOpenChange,
  currentFormData,
  onApply,
  onBranchSelect,
  branchContext,
}: AIEventAssistantProps) {
  const { toast } = useToast();
  const [notesText, setNotesText] = useState("");
  const [extractionResponse, setExtractionResponse] = useState<AIExtractionResponse | null>(null);
  const [editableData, setEditableData] = useState<ExtractedEventData>({});
  const [selectedFields, setSelectedFields] = useState<Set<keyof ExtractedEventData>>(new Set());

  const extractMutation = useMutation({
    mutationFn: async (notes: string) => {
      const res = await apiRequest("POST", "/api/ai/extract-event", {
        notes_text: notes,
        existing_form_data: currentFormData,
        branch_context: branchContext,
        timezone: branchContext?.timezone || "Asia/Bangkok",
      });
      return res.json() as Promise<AIExtractionResponse>;
    },
    onSuccess: (data) => {
      setExtractionResponse(data);
      setEditableData({ ...data.extracted });
      const autoSelected = new Set<keyof ExtractedEventData>();
      FIELD_MAPPINGS.forEach(({ extractedKey }) => {
        const extractedValue = data.extracted[extractedKey];
        if (extractedValue !== null && extractedValue !== undefined && extractedValue !== "") {
          autoSelected.add(extractedKey);
        }
      });
      setSelectedFields(autoSelected);
    },
    onError: (error: any) => {
      const message = error?.message || "Failed to extract event data";
      toast({
        title: "AI Extraction Failed",
        description: message,
        variant: "destructive",
      });
    },
  });

  const handleGenerate = () => {
    if (!notesText.trim()) {
      toast({ title: "Please enter some notes", variant: "destructive" });
      return;
    }
    extractMutation.mutate(notesText);
  };

  const handleClear = () => {
    setNotesText("");
    setExtractionResponse(null);
    setEditableData({});
    setSelectedFields(new Set());
  };

  const toggleField = (field: keyof ExtractedEventData) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  };

  const updateFieldValue = (field: keyof ExtractedEventData, value: any) => {
    setEditableData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleApply = () => {
    if (!extractionResponse) return;

    const updates: Partial<EventFormData> = {};
    FIELD_MAPPINGS.forEach(({ extractedKey, formKey }) => {
      if (selectedFields.has(extractedKey)) {
        const value = editableData[extractedKey];
        if (value !== null && value !== undefined && value !== "") {
          (updates as any)[formKey] = value;
        }
      }
    });

    onApply(updates);
    if (onBranchSelect && extractionResponse.suggested_branch_id) {
      onBranchSelect(extractionResponse.suggested_branch_id);
    }
    toast({
      title: "Fields Applied",
      description: `${selectedFields.size} field(s) added to the form`,
    });
    onOpenChange(false);
    handleClear();
  };

  const renderFieldInput = (mapping: FieldMapping) => {
    const { extractedKey, type, options } = mapping;
    const value = editableData[extractedKey];
    const isSelected = selectedFields.has(extractedKey);

    if (type === "select" && options) {
      return (
        <Select
          value={String(value || "")}
          onValueChange={(v) => updateFieldValue(extractedKey, v)}
          disabled={!isSelected}
        >
          <SelectTrigger className="h-8" data-testid={`input-${extractedKey}`}>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    if (type === "textarea") {
      return (
        <Textarea
          value={String(value || "")}
          onChange={(e) => updateFieldValue(extractedKey, e.target.value)}
          disabled={!isSelected}
          className="min-h-[60px] resize-none text-sm"
          data-testid={`input-${extractedKey}`}
        />
      );
    }

    if (type === "number") {
      return (
        <Input
          type="number"
          value={value !== null && value !== undefined ? String(value) : ""}
          onChange={(e) => updateFieldValue(extractedKey, e.target.value ? Number(e.target.value) : null)}
          disabled={!isSelected}
          className="h-8"
          data-testid={`input-${extractedKey}`}
        />
      );
    }

    return (
      <Input
        type={type}
        value={String(value || "")}
        onChange={(e) => updateFieldValue(extractedKey, e.target.value)}
        disabled={!isSelected}
        className="h-8"
        data-testid={`input-${extractedKey}`}
      />
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Event Assistant
          </SheetTitle>
          <SheetDescription>
            Paste unstructured notes about an event to automatically extract details
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4">
          <div className="space-y-4 pr-4">
            <div className="space-y-2">
              <Label htmlFor="notes">Paste your event notes</Label>
              <Textarea
                id="notes"
                value={notesText}
                onChange={(e) => setNotesText(e.target.value)}
                placeholder="e.g., Birthday party for Emma, turning 5 on January 20th. Mom's name is Sarah, phone +66 81 234 5678. 15 kids, 10 adults. Premium package. Allergies: no nuts. Unicorn cake needed. Start at 2pm."
                className="min-h-[150px] resize-none"
                data-testid="textarea-ai-notes"
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleGenerate}
                disabled={extractMutation.isPending || !notesText.trim()}
                className="flex-1"
                data-testid="button-ai-generate"
              >
                {extractMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Extracting...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Generate Draft
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={handleClear} data-testid="button-ai-clear">
                Clear
              </Button>
            </div>

            {extractionResponse && (
              <>
                <Separator />

                {extractionResponse.assumptions && extractionResponse.assumptions.length > 0 && (
                  <div className="bg-muted p-3 rounded-md">
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Info className="h-4 w-4" />
                      Assumptions Made
                    </div>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {extractionResponse.assumptions.map((a, i) => (
                        <li key={i}>• {a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {extractionResponse.missing_required && extractionResponse.missing_required.length > 0 && (
                  <div className="bg-destructive/10 p-3 rounded-md">
                    <div className="flex items-center gap-2 text-sm font-medium text-destructive mb-2">
                      <AlertCircle className="h-4 w-4" />
                      Missing Required Fields
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {extractionResponse.missing_required.map((field) => (
                        <Badge key={field} variant="outline" className="text-xs">
                          {field.replace(/_/g, " ")}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Extracted Fields</Label>
                    <span className="text-xs text-muted-foreground">
                      {selectedFields.size} selected
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Check the fields you want to include. You can edit values before applying.
                  </p>

                  <div className="border rounded-md divide-y">
                    {FIELD_MAPPINGS.map((mapping) => {
                      const { extractedKey, label } = mapping;
                      const originalValue = extractionResponse.extracted[extractedKey];
                      const isSelected = selectedFields.has(extractedKey);
                      const hasValue = originalValue !== null && originalValue !== undefined && originalValue !== "";

                      if (!hasValue) return null;

                      return (
                        <div key={extractedKey} className="p-3">
                          <div className="flex items-start gap-3">
                            <Checkbox
                              id={`field-${extractedKey}`}
                              checked={isSelected}
                              onCheckedChange={() => toggleField(extractedKey)}
                              className="mt-1"
                              data-testid={`checkbox-field-${extractedKey}`}
                            />
                            <div className="flex-1 min-w-0 space-y-2">
                              <Label htmlFor={`field-${extractedKey}`} className="text-sm font-medium">
                                {label}
                              </Label>
                              {renderFieldInput(mapping)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {extractionResponse && (
          <div className="flex gap-2 pt-4 border-t mt-4">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="flex-1"
              data-testid="button-ai-cancel"
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button
              onClick={handleApply}
              disabled={selectedFields.size === 0}
              className="flex-1"
              data-testid="button-ai-apply"
            >
              <Check className="h-4 w-4 mr-2" />
              Apply ({selectedFields.size})
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
