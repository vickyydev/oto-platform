import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
}

interface AIExtractionResponse {
  extracted: ExtractedEventData;
  missing_required?: string[];
  assumptions?: string[];
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
  status?: "upcoming" | "in_progress" | "completed" | "cancelled";
}

interface FieldMapping {
  extractedKey: keyof ExtractedEventData;
  formKey: keyof EventFormData;
  label: string;
}

const FIELD_MAPPINGS: FieldMapping[] = [
  { extractedKey: "title", formKey: "title", label: "Title" },
  { extractedKey: "event_type", formKey: "eventType", label: "Event Type" },
  { extractedKey: "event_date", formKey: "eventDate", label: "Date" },
  { extractedKey: "start_time", formKey: "startTime", label: "Start Time" },
  { extractedKey: "end_time", formKey: "endTime", label: "End Time" },
  { extractedKey: "child_name", formKey: "childName", label: "Child Name" },
  { extractedKey: "booking_name", formKey: "bookingName", label: "Booking Name" },
  { extractedKey: "parent_name", formKey: "parentName", label: "Parent Name" },
  { extractedKey: "whatsapp_phone", formKey: "whatsappPhoneRaw", label: "WhatsApp" },
  { extractedKey: "num_children", formKey: "numChildren", label: "Children" },
  { extractedKey: "num_adults", formKey: "numAdults", label: "Adults" },
  { extractedKey: "program_name", formKey: "programName", label: "Program" },
  { extractedKey: "program_details", formKey: "programDetails", label: "Program Details" },
  { extractedKey: "allergies_notes", formKey: "allergiesNotes", label: "Allergies" },
  { extractedKey: "cake_notes", formKey: "cakeNotes", label: "Cake" },
  { extractedKey: "special_requests", formKey: "specialRequests", label: "Special Requests" },
  { extractedKey: "internal_staff_notes", formKey: "internalStaffNotes", label: "Staff Notes" },
];

interface AIEventAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFormData: EventFormData;
  onApply: (updates: Partial<EventFormData>) => void;
  branchContext?: { branch_id: string; branch_name: string };
}

export function AIEventAssistant({
  open,
  onOpenChange,
  currentFormData,
  onApply,
  branchContext,
}: AIEventAssistantProps) {
  const { toast } = useToast();
  const [notesText, setNotesText] = useState("");
  const [extractedData, setExtractedData] = useState<AIExtractionResponse | null>(null);
  const [selectedFields, setSelectedFields] = useState<Set<keyof ExtractedEventData>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);

  const extractMutation = useMutation({
    mutationFn: async (notes: string) => {
      const res = await apiRequest("POST", "/api/ai/extract-event", {
        notes_text: notes,
        existing_form_data: currentFormData,
        branch_context: branchContext,
        timezone: "Asia/Bangkok",
      });
      return res.json() as Promise<AIExtractionResponse>;
    },
    onSuccess: (data) => {
      setExtractedData(data);
      // Auto-select all fields that have values and don't conflict with existing data
      const autoSelected = new Set<keyof ExtractedEventData>();
      FIELD_MAPPINGS.forEach(({ extractedKey, formKey }) => {
        const extractedValue = data.extracted[extractedKey];
        const currentValue = currentFormData[formKey];
        if (extractedValue !== null && extractedValue !== undefined) {
          // Auto-select if current form field is empty or matches
          if (!currentValue || currentValue === "" || currentValue === 0) {
            autoSelected.add(extractedKey);
          }
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
    setExtractedData(null);
    setSelectedFields(new Set());
    setShowConfirm(false);
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

  const handleApply = () => {
    if (!extractedData) return;

    const updates: Partial<EventFormData> = {};
    FIELD_MAPPINGS.forEach(({ extractedKey, formKey }) => {
      if (selectedFields.has(extractedKey)) {
        const value = extractedData.extracted[extractedKey];
        if (value !== null && value !== undefined) {
          (updates as any)[formKey] = value;
        }
      }
    });

    onApply(updates);
    toast({
      title: "Fields Applied",
      description: `${selectedFields.size} field(s) updated from AI extraction`,
    });
    onOpenChange(false);
    handleClear();
  };

  const getFieldStatus = (extractedKey: keyof ExtractedEventData, formKey: keyof EventFormData) => {
    const extractedValue = extractedData?.extracted[extractedKey];
    const currentValue = currentFormData[formKey];
    
    const hasExtracted = extractedValue !== null && extractedValue !== undefined && extractedValue !== "";
    const hasCurrent = currentValue !== null && currentValue !== undefined && currentValue !== "" && currentValue !== 0;
    
    if (!hasExtracted) return "empty";
    if (!hasCurrent) return "new";
    if (String(extractedValue) === String(currentValue)) return "same";
    return "conflict";
  };

  const formatValue = (value: any) => {
    if (value === null || value === undefined) return "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
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

            {extractedData && (
              <>
                <Separator />

                {extractedData.assumptions && extractedData.assumptions.length > 0 && (
                  <div className="bg-muted p-3 rounded-md">
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Info className="h-4 w-4" />
                      Assumptions Made
                    </div>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {extractedData.assumptions.map((a, i) => (
                        <li key={i}>• {a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {extractedData.missing_required && extractedData.missing_required.length > 0 && (
                  <div className="bg-destructive/10 p-3 rounded-md">
                    <div className="flex items-center gap-2 text-sm font-medium text-destructive mb-2">
                      <AlertCircle className="h-4 w-4" />
                      Missing Required Fields
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {extractedData.missing_required.map((field) => (
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

                  <div className="border rounded-md divide-y">
                    {FIELD_MAPPINGS.map(({ extractedKey, formKey, label }) => {
                      const extractedValue = extractedData.extracted[extractedKey];
                      const currentValue = currentFormData[formKey];
                      const status = getFieldStatus(extractedKey, formKey);
                      const isSelected = selectedFields.has(extractedKey);

                      if (status === "empty") return null;

                      return (
                        <div
                          key={extractedKey}
                          className={`p-3 ${status === "conflict" ? "bg-amber-50 dark:bg-amber-950/20" : ""}`}
                        >
                          <div className="flex items-start gap-3">
                            <Checkbox
                              id={`field-${extractedKey}`}
                              checked={isSelected}
                              onCheckedChange={() => toggleField(extractedKey)}
                              data-testid={`checkbox-field-${extractedKey}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <Label htmlFor={`field-${extractedKey}`} className="text-sm font-medium">
                                  {label}
                                </Label>
                                {status === "new" && (
                                  <Badge variant="secondary" className="text-xs">New</Badge>
                                )}
                                {status === "conflict" && (
                                  <Badge variant="outline" className="text-xs border-amber-500 text-amber-600">
                                    Will overwrite
                                  </Badge>
                                )}
                                {status === "same" && (
                                  <Badge variant="outline" className="text-xs">Same</Badge>
                                )}
                              </div>
                              <div className="text-sm">
                                <span className="text-foreground">{formatValue(extractedValue)}</span>
                              </div>
                              {status === "conflict" && (
                                <div className="text-xs text-muted-foreground mt-1">
                                  Current: {formatValue(currentValue)}
                                </div>
                              )}
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

        {extractedData && (
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
