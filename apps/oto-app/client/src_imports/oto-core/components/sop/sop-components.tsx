import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Info, 
  AlertTriangle, 
  HelpCircle, 
  CheckCircle2, 
  Clock,
  Ban,
  Lightbulb,
  ListChecks,
  BookOpen
} from "lucide-react";
import { cn } from "@/lib/utils";

interface HeroCardProps {
  title: string;
  departments: string[];
  readingTime?: number;
  icon?: ReactNode;
}

export function HeroCard({ title, departments, readingTime = 3, icon }: HeroCardProps) {
  return (
    <div className="mb-6">
      <div className="flex items-start gap-4">
        {icon && (
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shrink-0 shadow-sm">
            {icon}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight mb-3">{title}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            {departments.map((dept) => (
              <Badge key={dept} variant="secondary" className="capitalize text-xs font-medium">
                {dept.replace("_", "/")}
              </Badge>
            ))}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground ml-1">
              <Clock className="h-3.5 w-3.5" />
              {readingTime} min read
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface InfoCalloutProps {
  title?: string;
  children: ReactNode;
}

export function InfoCallout({ title = "Overview", children }: InfoCalloutProps) {
  return (
    <div className="relative mb-6 pl-4 border-l-4 border-blue-500">
      <div className="flex items-center gap-2 mb-2">
        <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        <h3 className="font-semibold text-blue-700 dark:text-blue-300 text-sm uppercase tracking-wide">{title}</h3>
      </div>
      <p className="text-sm text-foreground/80 leading-relaxed">{children}</p>
    </div>
  );
}

interface ChecklistCardProps {
  title?: string;
  items: string[];
}

export function ChecklistCard({ title = "Key Rules", items }: ChecklistCardProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-green-500/20 flex items-center justify-center">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="font-semibold text-base">{title}</h2>
      </div>
      <div className="grid gap-2">
        {items.map((item, idx) => (
          <div 
            key={idx} 
            className="flex items-start gap-3 p-3 rounded-xl bg-green-500/5 border border-green-500/20"
          >
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
            <span className="text-sm leading-relaxed">{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface StepTimelineProps {
  title?: string;
  steps: string[];
}

export function StepTimeline({ title = "Step-by-Step", steps }: StepTimelineProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-primary/20 flex items-center justify-center">
          <ListChecks className="h-4 w-4 text-primary" />
        </div>
        <h2 className="font-semibold text-base">{title}</h2>
      </div>
      <div className="relative pl-5 space-y-0">
        <div className="absolute left-[11px] top-3 bottom-3 w-0.5 bg-gradient-to-b from-primary via-primary/50 to-primary/20 rounded-full" />
        {steps.map((step, idx) => (
          <div key={idx} className="relative flex items-start gap-4 pb-4 last:pb-0">
            <div className="relative z-10 h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold shadow-sm -ml-[10px]">
              {idx + 1}
            </div>
            <div className="flex-1 pt-0.5">
              <p className="text-sm leading-relaxed">{step}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface WarningCardProps {
  title?: string;
  items: string[];
}

export function WarningCard({ title = "Common Mistakes", items }: WarningCardProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-red-500/20 flex items-center justify-center">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="font-semibold text-base text-red-700 dark:text-red-400">{title}</h2>
      </div>
      <Card className="border-red-500/30 bg-red-500/5 overflow-hidden">
        <CardContent className="p-0 divide-y divide-red-500/20">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-start gap-3 p-3">
              <Ban className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <span className="text-sm leading-relaxed">{item}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

interface HelpCardProps {
  title?: string;
  items: string[];
}

export function HelpCard({ title = "Tips & Reminders", items }: HelpCardProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-amber-500/20 flex items-center justify-center">
          <Lightbulb className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <h2 className="font-semibold text-base">{title}</h2>
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
            <Lightbulb className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <span className="text-sm leading-relaxed">{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BodyContentProps {
  content: string;
}

export function BodyContent({ content }: BodyContentProps) {
  const paragraphs = content.split("\n\n").filter(p => p.trim());
  if (paragraphs.length === 0) return null;
  
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
        </div>
        <h2 className="font-semibold text-base">Details</h2>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none">
        {paragraphs.map((paragraph, idx) => (
          <p key={idx} className="text-sm text-foreground/80 leading-relaxed mb-3 last:mb-0">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );
}

interface ColorColumnProps {
  color: "blue" | "yellow" | "green";
  title: string;
  items: string[];
}

export function ColorColumn({ color, title, items }: ColorColumnProps) {
  const colorClasses = {
    blue: "border-blue-500/30",
    yellow: "border-amber-500/30",
    green: "border-green-500/30",
  };

  const headerClasses = {
    blue: "bg-blue-500 text-white",
    yellow: "bg-amber-500 text-white",
    green: "bg-green-500 text-white",
  };

  const bulletClasses = {
    blue: "bg-blue-500",
    yellow: "bg-amber-500",
    green: "bg-green-500",
  };

  return (
    <Card className={cn("flex-1 overflow-hidden", colorClasses[color])}>
      <div className={cn("px-3 py-2 text-center font-semibold text-xs uppercase tracking-wide", headerClasses[color])}>
        {title}
      </div>
      <CardContent className="p-3">
        <ul className="space-y-2">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-xs">
              <span className={cn("h-1.5 w-1.5 rounded-full mt-1.5 shrink-0", bulletClasses[color])} />
              <span className="leading-relaxed">{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface ThreeColumnLayoutProps {
  yesterday: string[];
  today: string[];
  tomorrow: string[];
}

export function ThreeColumnLayout({ yesterday, today, tomorrow }: ThreeColumnLayoutProps) {
  const hasContent = yesterday.length > 0 || today.length > 0 || tomorrow.length > 0;
  if (!hasContent) return null;
  
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center">
          <Clock className="h-4 w-4 text-muted-foreground" />
        </div>
        <h2 className="font-semibold text-base">Daily Focus</h2>
      </div>
      <div className="flex gap-2">
        <ColorColumn color="blue" title="YTD" items={yesterday} />
        <ColorColumn color="yellow" title="Today" items={today} />
        <ColorColumn color="green" title="TMR" items={tomorrow} />
      </div>
    </div>
  );
}

interface SectionDividerProps {
  className?: string;
}

export function SectionDivider({ className }: SectionDividerProps) {
  return (
    <div className={cn("flex items-center gap-4 my-6", className)}>
      <div className="flex-1 h-px bg-border" />
      <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}
