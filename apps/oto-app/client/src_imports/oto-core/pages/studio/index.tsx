import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarDays, ClipboardList, FileText, GraduationCap, Wrench, ListTodo } from "lucide-react";
import { Link } from "wouter";

const studioSections = [
  {
    title: "Tasks",
    description: "Create department-specific daily tasks with due times",
    icon: ListTodo,
    href: "/studio/tasks",
    color: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-amber-100 dark:bg-amber-900/30",
    requiresRole: null,
  },
  {
    title: "Events",
    description: "Create and manage birthday parties, private events, and school groups",
    icon: CalendarDays,
    href: "/studio/events",
    color: "text-pink-600 dark:text-pink-400",
    bgColor: "bg-pink-100 dark:bg-pink-900/30",
    requiresRole: null,
  },
  {
    title: "Checklists",
    description: "Design daily checklists for staff to complete",
    icon: ClipboardList,
    href: "/studio/checklists",
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
    requiresRole: null,
  },
  {
    title: "SOPs",
    description: "Write and organize standard operating procedures",
    icon: FileText,
    href: "/studio/sops",
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-100 dark:bg-green-900/30",
    requiresRole: null,
  },
  {
    title: "Training & Quizzes",
    description: "Build training modules and knowledge assessments",
    icon: GraduationCap,
    href: "/studio/quizzes",
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-100 dark:bg-purple-900/30",
    requiresRole: null,
  },
  {
    title: "Troubleshooting",
    description: "Create step-by-step troubleshooting flows",
    icon: Wrench,
    href: "/studio/troubleshooting",
    color: "text-orange-600 dark:text-orange-400",
    bgColor: "bg-orange-100 dark:bg-orange-900/30",
    requiresRole: null,
  },
];

export default function StudioIndexPage() {
  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-violet-900 dark:text-violet-100">OTO Studio</h1>
          <p className="text-sm text-muted-foreground">
            Configure content and templates for your park
          </p>
        </div>

        <div className="space-y-3">
          {studioSections.map((section) => (
            <Link key={section.href} href={section.href}>
              <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-studio-${section.title.toLowerCase().replace(/\s+/g, '-')}`}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-lg ${section.bgColor}`}>
                      <section.icon className={`h-6 w-6 ${section.color}`} />
                    </div>
                    <div>
                      <h3 className="font-semibold">{section.title}</h3>
                      <p className="text-sm text-muted-foreground">{section.description}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </StudioLayout>
  );
}
