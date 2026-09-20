import { SetupLayout } from "@/components/layout/setup-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { FixDepartmentSection } from "@/components/fix-department-section";
import {
  ListTodo,
  ClipboardList,
  Building2,
  Layers,
  Tag,
  FormInput,
  FileText,
  GraduationCap,
  MessageCircleQuestion,
  BookOpen,
  Cog,
  Bell,
  Shield,
  MapPin,
  CalendarDays,
  Baby,
  Ticket,
} from "lucide-react";

interface SetupSection {
  title: string;
  items: {
    title: string;
    description: string;
    icon: typeof ListTodo;
    href: string;
    color: string;
    bgColor: string;
    adminOnly?: boolean;
  }[];
}

const setupSections: SetupSection[] = [
  {
    title: "Operations Config",
    items: [
      {
        title: "Departments",
        description: "Manage organizational departments",
        icon: Building2,
        href: "/departments",
        color: "text-blue-600 dark:text-blue-400",
        bgColor: "bg-blue-100 dark:bg-blue-900/30",
      },
      {
        title: "Roles",
        description: "Define employee roles and positions",
        icon: Tag,
        href: "/roles",
        color: "text-indigo-600 dark:text-indigo-400",
        bgColor: "bg-indigo-100 dark:bg-indigo-900/30",
      },
      {
        title: "Locations",
        description: "Manage branch locations and zones",
        icon: MapPin,
        href: "/locations",
        color: "text-emerald-600 dark:text-emerald-400",
        bgColor: "bg-emerald-100 dark:bg-emerald-900/30",
      },
      {
        title: "Branches",
        description: "Configure branch settings",
        icon: Layers,
        href: "/branches",
        color: "text-violet-600 dark:text-violet-400",
        bgColor: "bg-violet-100 dark:bg-violet-900/30",
        adminOnly: true,
      },
    ],
  },
  {
    title: "Forms",
    items: [
      {
        title: "Drop-off Form Builder",
        description: "Customize the check-in form with multi-language support",
        icon: FormInput,
        href: "/studio/form-builder",
        color: "text-cyan-600 dark:text-cyan-400",
        bgColor: "bg-cyan-100 dark:bg-cyan-900/30",
        adminOnly: true,
      },
    ],
  },
  {
    title: "Studio",
    items: [
      {
        title: "Tasks",
        description: "Create one-off or recurring tasks with flexible assignments",
        icon: ListTodo,
        href: "/studio/tasks",
        color: "text-amber-600 dark:text-amber-400",
        bgColor: "bg-amber-100 dark:bg-amber-900/30",
      },
      {
        title: "Events",
        description: "Birthday parties, private events, and school groups",
        icon: CalendarDays,
        href: "/studio/events",
        color: "text-pink-600 dark:text-pink-400",
        bgColor: "bg-pink-100 dark:bg-pink-900/30",
      },
      {
        title: "Children",
        description: "Manage the children database and camp registrations",
        icon: Baby,
        href: "/studio/children",
        color: "text-violet-600 dark:text-violet-400",
        bgColor: "bg-violet-100 dark:bg-violet-900/30",
      },
      {
        title: "Checklists",
        description: "Design daily checklists for staff to complete",
        icon: ClipboardList,
        href: "/studio/checklists",
        color: "text-blue-600 dark:text-blue-400",
        bgColor: "bg-blue-100 dark:bg-blue-900/30",
      },
      {
        title: "Vouchers",
        description: "Create and manage discount vouchers",
        icon: Ticket,
        href: "/studio/vouchers",
        color: "text-orange-600 dark:text-orange-400",
        bgColor: "bg-orange-100 dark:bg-orange-900/30",
      },
    ],
  },
  {
    title: "Training",
    items: [
      {
        title: "Training & Quizzes",
        description: "Build training modules and knowledge assessments",
        icon: GraduationCap,
        href: "/studio/quizzes",
        color: "text-purple-600 dark:text-purple-400",
        bgColor: "bg-purple-100 dark:bg-purple-900/30",
      },
    ],
  },
  {
    title: "AI & SOP",
    items: [
      {
        title: "ASK OTO",
        description: "Upload SOPs and articles to power the AI assistant",
        icon: MessageCircleQuestion,
        href: "/studio/kb",
        color: "text-green-600 dark:text-green-400",
        bgColor: "bg-green-100 dark:bg-green-900/30",
      },
      {
        title: "Troubleshooting",
        description: "Manage troubleshooting guides",
        icon: BookOpen,
        href: "/studio/troubleshooting",
        color: "text-orange-600 dark:text-orange-400",
        bgColor: "bg-orange-100 dark:bg-orange-900/30",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        title: "Settings",
        description: "System-wide configuration and preferences",
        icon: Cog,
        href: "/settings",
        color: "text-gray-600 dark:text-gray-400",
        bgColor: "bg-gray-100 dark:bg-gray-900/30",
        adminOnly: true,
      },
      {
        title: "Access & Permissions",
        description: "Manage role permissions and access policies",
        icon: Shield,
        href: "/settings/access",
        color: "text-red-600 dark:text-red-400",
        bgColor: "bg-red-100 dark:bg-red-900/30",
        adminOnly: true,
      },
      {
        title: "Permissions Debug",
        description: "View effective permissions for all users",
        icon: Shield,
        href: "/settings/permissions-debug",
        color: "text-purple-600 dark:text-purple-400",
        bgColor: "bg-purple-100 dark:bg-purple-900/30",
        adminOnly: true,
      },
    ],
  },
];

export default function SetupPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "global_admin" || user?.role === "admin" || user?.role === "operator_admin";

  return (
    <SetupLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" data-testid="text-setup-title">Setup</h1>
          <p className="text-sm text-muted-foreground">
            Configure your workspace structure and system settings
          </p>
        </div>

        <div className="space-y-6">
          {setupSections.map((section) => {
            const visibleItems = section.items.filter(item => !item.adminOnly || isAdmin);
            if (visibleItems.length === 0) return null;

            return (
              <div key={section.title} className="space-y-2">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1" data-testid={`text-setup-section-${section.title.toLowerCase().replace(/\s+/g, '-')}`}>
                  {section.title}
                </h2>
                <div className="space-y-2">
                  {visibleItems.map((item) => (
                    <Link key={item.href} href={item.href}>
                      <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-setup-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                        <CardContent className="p-4">
                          <div className="flex items-center gap-4">
                            <div className={`p-2.5 rounded-lg ${item.bgColor}`}>
                              <item.icon className={`h-5 w-5 ${item.color}`} />
                            </div>
                            <div>
                              <h3 className="font-semibold text-sm">{item.title}</h3>
                              <p className="text-xs text-muted-foreground">{item.description}</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}

          {isAdmin && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
                Fix Reports
              </h2>
              <FixDepartmentSection />
            </div>
          )}

        </div>
      </div>
    </SetupLayout>
  );
}
