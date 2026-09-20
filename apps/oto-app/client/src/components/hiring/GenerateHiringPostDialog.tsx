import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, Copy, Check, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  HiringPostData,
  AspectRatio,
  TemplateId,
  TEMPLATE_OPTIONS,
  getTemplateComponent,
} from "./HiringPostTemplates";
import html2canvas from "html2canvas";

interface GenerateHiringPostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeData: {
    title: string;
    positionTitle?: string | null;
    branchName?: string | null;
    employmentType?: "full_time" | "part_time" | "casual" | null;
    jobDescription?: string | null;
    keyResponsibilities?: string[] | null;
    requirements?: string[] | null;
    salaryRange?: string | null;
    benefits?: string[] | null;
    contactPhone?: string | null;
    contactLine?: string | null;
    contactEmail?: string | null;
    applyUrl?: string | null;
  } | null;
  companyName?: string;
}

const ASPECT_RATIO_LABELS: Record<AspectRatio, { label: string; desc: string }> = {
  "1:1": { label: "Square", desc: "Instagram Feed" },
  "4:5": { label: "Portrait", desc: "Instagram Post" },
  "9:16": { label: "Story", desc: "Stories/Reels" },
};

const COLOR_PRESETS = [
  { name: "Indigo", primary: "#6366f1", accent: "#f59e0b" },
  { name: "Blue", primary: "#3b82f6", accent: "#10b981" },
  { name: "Red", primary: "#dc2626", accent: "#fbbf24" },
  { name: "Green", primary: "#059669", accent: "#f97316" },
  { name: "Purple", primary: "#7c3aed", accent: "#ec4899" },
  { name: "Slate", primary: "#475569", accent: "#0ea5e9" },
];

export function GenerateHiringPostDialog({
  open,
  onOpenChange,
  nodeData,
  companyName = "OTO",
}: GenerateHiringPostDialogProps) {
  const { toast } = useToast();
  const templateRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>("modern");
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("1:1");
  const [primaryColor, setPrimaryColor] = useState("#6366f1");
  const [accentColor, setAccentColor] = useState("#f59e0b");
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  const postData: HiringPostData = {
    positionTitle: nodeData?.positionTitle || nodeData?.title || "Open Position",
    branchName: nodeData?.branchName || "Location",
    employmentType: nodeData?.employmentType,
    jobDescription: nodeData?.jobDescription,
    keyResponsibilities: nodeData?.keyResponsibilities,
    requirements: nodeData?.requirements,
    salaryRange: nodeData?.salaryRange,
    benefits: nodeData?.benefits,
    contactPhone: nodeData?.contactPhone,
    contactLine: nodeData?.contactLine,
    contactEmail: nodeData?.contactEmail,
    applyUrl: nodeData?.applyUrl,
    companyName,
    primaryColor,
    accentColor,
  };

  const TemplateComponent = getTemplateComponent(selectedTemplate);

  const handleExport = useCallback(async () => {
    if (!exportRef.current) return;
    
    setIsExporting(true);
    try {
      const canvas = await html2canvas(exportRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
      });

      const link = document.createElement("a");
      link.download = `hiring-${postData.positionTitle.replace(/\s+/g, "-").toLowerCase()}-${selectedRatio.replace(":", "x")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();

      toast({
        title: "Image exported",
        description: "Your hiring post has been downloaded.",
      });
    } catch (error) {
      console.error("Export error:", error);
      toast({
        title: "Export failed",
        description: "There was an error exporting the image.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  }, [postData.positionTitle, selectedRatio, toast]);

  const generateCaption = useCallback(() => {
    const lines: string[] = [];
    lines.push(`We're hiring! Join our team as a ${postData.positionTitle}! `);
    lines.push("");
    lines.push(`Location: ${postData.branchName}`);
    
    if (postData.employmentType) {
      const typeMap: Record<string, string> = {
        full_time: "Full-time",
        part_time: "Part-time",
        casual: "Casual",
      };
      lines.push(`Type: ${typeMap[postData.employmentType]}`);
    }
    
    if (postData.salaryRange) {
      lines.push(`Salary: ${postData.salaryRange}`);
    }
    
    lines.push("");
    
    if (postData.requirements && postData.requirements.length > 0) {
      lines.push("Requirements:");
      postData.requirements.slice(0, 3).forEach((req) => {
        lines.push(`- ${req}`);
      });
      lines.push("");
    }
    
    if (postData.benefits && postData.benefits.length > 0) {
      lines.push("Benefits:");
      postData.benefits.slice(0, 3).forEach((benefit) => {
        lines.push(`- ${benefit}`);
      });
      lines.push("");
    }
    
    lines.push("How to apply:");
    if (postData.contactPhone) lines.push(`Phone: ${postData.contactPhone}`);
    if (postData.contactLine) lines.push(`LINE: ${postData.contactLine}`);
    if (postData.contactEmail) lines.push(`Email: ${postData.contactEmail}`);
    if (postData.applyUrl) lines.push(`Apply: ${postData.applyUrl}`);
    
    lines.push("");
    lines.push("#hiring #jobs #career #joinus #openposition");
    
    return lines.join("\n");
  }, [postData]);

  const handleCopyCaption = useCallback(async () => {
    const caption = generateCaption();
    await navigator.clipboard.writeText(caption);
    setCopied(true);
    toast({
      title: "Caption copied",
      description: "The caption has been copied to your clipboard.",
    });
    setTimeout(() => setCopied(false), 2000);
  }, [generateCaption, toast]);

  const applyColorPreset = (preset: typeof COLOR_PRESETS[0]) => {
    setPrimaryColor(preset.primary);
    setAccentColor(preset.accent);
  };

  if (!nodeData) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5" />
            Generate Hiring Post
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium">Template Style</Label>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {TEMPLATE_OPTIONS.map((template) => (
                  <Button
                    key={template.id}
                    variant={selectedTemplate === template.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedTemplate(template.id)}
                    data-testid={`button-template-${template.id}`}
                  >
                    {template.name}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium">Aspect Ratio</Label>
              <Tabs value={selectedRatio} onValueChange={(v) => setSelectedRatio(v as AspectRatio)} className="mt-2">
                <TabsList className="grid grid-cols-3">
                  {(Object.keys(ASPECT_RATIO_LABELS) as AspectRatio[]).map((ratio) => (
                    <TabsTrigger key={ratio} value={ratio} data-testid={`tab-ratio-${ratio}`}>
                      <div className="text-center">
                        <div className="font-medium">{ASPECT_RATIO_LABELS[ratio].label}</div>
                        <div className="text-xs opacity-70">{ratio}</div>
                      </div>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <div>
              <Label className="text-sm font-medium">Color Scheme</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => applyColorPreset(preset)}
                    className="w-8 h-8 rounded-md border-2 transition-all"
                    style={{
                      background: `linear-gradient(135deg, ${preset.primary} 50%, ${preset.accent} 50%)`,
                      borderColor: primaryColor === preset.primary ? preset.primary : "transparent",
                    }}
                    title={preset.name}
                    data-testid={`button-color-${preset.name.toLowerCase()}`}
                  />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <Label className="text-xs">Primary</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type="color"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="w-10 h-8 p-0 border-0"
                      data-testid="input-primary-color"
                    />
                    <Input
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="flex-1 h-8 text-xs font-mono"
                      data-testid="input-primary-color-hex"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Accent</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type="color"
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="w-10 h-8 p-0 border-0"
                      data-testid="input-accent-color"
                    />
                    <Input
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="flex-1 h-8 text-xs font-mono"
                      data-testid="input-accent-color-hex"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <Label className="text-sm font-medium">Actions</Label>
              <div className="flex flex-col gap-2 mt-2">
                <Button
                  onClick={handleExport}
                  disabled={isExporting}
                  className="w-full"
                  data-testid="button-export-image"
                >
                  {isExporting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 mr-2" />
                      Download Image
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCopyCaption}
                  className="w-full"
                  data-testid="button-copy-caption"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 mr-2" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      Copy Caption
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              <p>Tip: Use the Square (1:1) format for Instagram feed posts, Portrait (4:5) for maximum engagement, and Story (9:16) for Instagram/Facebook Stories.</p>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center bg-muted/30 rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-2">Preview</div>
            <div ref={templateRef}>
              <TemplateComponent
                data={postData}
                aspectRatio={selectedRatio}
                scale={0.35}
              />
            </div>
            <Badge variant="secondary" className="mt-2">
              {ASPECT_RATIO_LABELS[selectedRatio].desc}
            </Badge>
          </div>
        </div>

        <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
          <div ref={exportRef}>
            <TemplateComponent
              data={postData}
              aspectRatio={selectedRatio}
              scale={1}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
