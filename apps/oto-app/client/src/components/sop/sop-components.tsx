import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertTriangle, HelpCircle, Clock, Info } from "lucide-react";

interface HeroCardProps {
  title: string;
  departments?: string | null;
  readingTime?: number;
  icon?: ReactNode;
}

export function HeroCard({ title, departments, readingTime, icon }: HeroCardProps) {
  return (
    <div className="mb-6">
      <div className="flex items-start gap-3 mb-3">
        {icon && <div className="flex-shrink-0 mt-1">{icon}</div>}
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {departments && (
          <Badge variant="secondary" className="text-xs">
            {departments}
          </Badge>
        )}
        {readingTime && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{readingTime} min read</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface InfoCalloutProps {
  children: ReactNode;
}

export function InfoCallout({ children }: InfoCalloutProps) {
  return (
    <Card className="mb-4 border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30">
      <CardContent className="p-4">
        <div className="flex gap-3">
          <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-blue-900 dark:text-blue-100">{children}</p>
        </div>
      </CardContent>
    </Card>
  );
}

interface ChecklistCardProps {
  items: string[];
}

export function ChecklistCard({ items }: ChecklistCardProps) {
  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle className="h-5 w-5 text-green-600" />
          Rules & Guidelines
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-sm">
              <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface StepTimelineProps {
  steps: string[];
}

export function StepTimeline({ steps }: StepTimelineProps) {
  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Steps</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ol className="relative border-l border-muted-foreground/20 ml-2">
          {steps.map((step, index) => (
            <li key={index} className="mb-4 ml-4 last:mb-0">
              <div className="absolute -left-2 w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                <span className="text-[10px] text-primary-foreground font-bold">{index + 1}</span>
              </div>
              <p className="text-sm pl-2">{step}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

interface WarningCardProps {
  items: string[];
}

export function WarningCard({ items }: WarningCardProps) {
  return (
    <Card className="mb-4 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-5 w-5" />
          Common Mistakes
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100">
              <span className="text-amber-600 dark:text-amber-400">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface HelpCardProps {
  items: string[];
}

export function HelpCard({ items }: HelpCardProps) {
  return (
    <Card className="mb-4 border-purple-200 bg-purple-50 dark:border-purple-900 dark:bg-purple-950/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-purple-800 dark:text-purple-200">
          <HelpCircle className="h-5 w-5" />
          If You're Unsure
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-purple-900 dark:text-purple-100">
              <span className="text-purple-600 dark:text-purple-400">•</span>
              <span>{item}</span>
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
  return (
    <div className="grid grid-cols-3 gap-2 mb-4">
      <Card className="p-3">
        <h4 className="text-xs font-semibold text-muted-foreground mb-2">Yesterday</h4>
        <ul className="space-y-1">
          {yesterday.map((item, index) => (
            <li key={index} className="text-xs">{item}</li>
          ))}
        </ul>
      </Card>
      <Card className="p-3 border-primary">
        <h4 className="text-xs font-semibold text-primary mb-2">Today</h4>
        <ul className="space-y-1">
          {today.map((item, index) => (
            <li key={index} className="text-xs">{item}</li>
          ))}
        </ul>
      </Card>
      <Card className="p-3">
        <h4 className="text-xs font-semibold text-muted-foreground mb-2">Tomorrow</h4>
        <ul className="space-y-1">
          {tomorrow.map((item, index) => (
            <li key={index} className="text-xs">{item}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface BodyContentProps {
  content: string;
}

export function BodyContent({ content }: BodyContentProps) {
  return (
    <div 
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}

export function SectionDivider() {
  return <hr className="my-6 border-border" />;
}
