import { useState, useMemo, useEffect, useCallback, useRef, Fragment, Suspense, lazy } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import SyncStatusSection from "@/components/sync-status-section";
const CampaignsTab = lazy(() => import("@/pages/campaigns-tab"));
import { BirthdaysFootnote, useBirthdays, type StaffBirthday } from "@/components/birthdays-widget";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  excludeSummerCamp,
  excludeWeekends,
  fillActivityDateRange,
  getActivityBranchStatus,
  getActivityHourlyTotals,
  mergeActivityDays,
  mergeActivityHours,
} from "@/lib/activityHeatmap";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { computeSmartPaceForecast, computeFutureMonthBaseline, comparePaceToTarget, type SmartPaceForecast } from "@/lib/paceForecast";
import { normalizeDashboardDateRange } from "@/lib/dashboardDateRange";
import { RevenuePlannerButton } from "@/components/revenue-planner";
import { useToast } from "@/hooks/use-toast";
import { DatePicker } from "@/components/ui/date-picker";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { format, parseISO } from "date-fns";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { useTheme } from "@/components/theme-provider";
import {
  Loader2,
  TrendingUp,
  DollarSign,
  ShoppingCart,
  CreditCard,
  Receipt,
  FileText,
  Package,
  Wifi,
  WifiOff,
  RefreshCw,
  Users,
  CalendarDays,
  Ticket,
  Percent,
  Baby,
  User,
  Clock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  BarChart as BarChartLucide,
  LineChart as LineChartLucide,
  Settings,
  Activity,
  RotateCcw,
  CalendarHeart,
  Star,
  StickyNote,
  X,
  Save,
  ShoppingBag,
  Send,
  Sparkles,
  Tent,
  MessageCircle,
  History,
  Trash2,
  BookOpen,
  Plus,
  ArrowLeft,
  BarChart3,
  PieChart as PieChartIcon,
  AreaChart as AreaChartIcon,
  Filter,
  Check,
  Lock,
  Unlock,
  MapPin,
  Cpu,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  ScanLine,
  Info,
} from "lucide-react";
import { Link } from "wouter";
import {
  OtoCoin,
  OtoCurrency,
  OtoPlayCoin,
  OtoRevenue,
  OtoTotalOrders,
  OtoHeadcount,
  OtoGateCount,
  OtoAvgOrder,
  OtoTicket,
  OtoFnb,
  OtoExtras,
  OtoNanny,
  OtoPerfGraph,
  OtoTopProducts,
  OtoMerch,
  OtoEvents,
  OtoAvgStay,
  OtoVipTicket,
  OtoLive,
  otoLoadingPath,
  otoAppIconPath,
  otoLogoFullPath,
} from "@/components/oto-icons";
import {
  PieChart as RechartsPC,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LineChart,
  Line,
  ReferenceLine,
  AreaChart,
  Area,
} from "recharts";

function useAnimatedNumber(target: number, duration = 600): number {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const from = prevRef.current;
    if (from === target) return;
    prevRef.current = target;
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration]);

  return display;
}

function AnimatedBaht({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const animated = useAnimatedNumber(value);
  return <span className={className}>฿{animated.toLocaleString()}</span>;
}

const CATEGORY_GRADIENTS: Record<string, string> = {
  "Tickets & Packages": "from-blue-500 to-blue-400",
  "F&B": "from-amber-500 to-orange-400",
  "Events / Birthdays": "from-purple-500 to-violet-400",
  "Nanny & Drop-off": "from-pink-500 to-rose-400",
  Merchandise: "from-teal-500 to-emerald-400",
  Workshop: "from-indigo-500 to-indigo-400",
  Extras: "from-gray-500 to-slate-400",
};

const CATEGORY_GRADIENT_DARK: Record<string, string> = {
  "Tickets & Packages": "from-blue-600 to-blue-500",
  "F&B": "from-amber-600 to-orange-500",
  "Events / Birthdays": "from-purple-600 to-violet-500",
  "Nanny & Drop-off": "from-pink-600 to-rose-500",
  Merchandise: "from-teal-600 to-emerald-500",
  Workshop: "from-indigo-600 to-indigo-500",
  Extras: "from-gray-600 to-slate-500",
};

type HolidayType =
  | "thai"
  | "intl"
  | "school"
  | "kid"
  | "camp"
  | "inset"
  | "term"
  | "intl_school"
  | "milestone"
  | "birthday";

const INTELLIGENCE_CALENDAR: Record<
  string,
  { name: string; type: HolidayType }
> = {
  "2026-01-01": { name: "New Year's Day", type: "intl" },
  "2026-01-02": { name: "New Year Holiday", type: "intl" },
  "2026-01-10": { name: "Children's Day (Wan Dek)", type: "kid" },
  "2026-01-25": { name: "Chinese New Year (Eve)", type: "intl" },
  "2026-01-26": { name: "Chinese New Year", type: "intl" },
  "2026-02-01": { name: "🚀 Sales Booth Launch", type: "milestone" },
  "2026-02-14": { name: "Valentine's Day", type: "intl" },
  "2026-02-17": { name: "Makha Bucha Day", type: "thai" },
  "2026-03-01": { name: "Thai School Break (Big Break)", type: "school" },
  "2026-03-02": { name: "Thai School Break", type: "school" },
  "2026-03-03": { name: "Thai School Break", type: "school" },
  "2026-03-04": { name: "Thai School Break", type: "school" },
  "2026-03-05": { name: "Thai School Break", type: "school" },
  "2026-03-06": { name: "Thai School Break", type: "school" },
  "2026-03-07": { name: "Thai School Break", type: "school" },
  "2026-03-08": { name: "Thai School Break", type: "school" },
  "2026-03-09": { name: "Thai School Break", type: "school" },
  "2026-03-10": { name: "Thai School Break", type: "school" },
  "2026-03-11": { name: "Thai School Break", type: "school" },
  "2026-03-12": { name: "Thai School Break", type: "school" },
  "2026-03-13": { name: "Thai School Break", type: "school" },
  "2026-03-14": { name: "Thai School Break", type: "school" },
  "2026-03-15": { name: "Thai School Break", type: "school" },
  "2026-03-16": { name: "Thai School Break", type: "school" },
  "2026-03-17": { name: "Thai School Break", type: "school" },
  "2026-03-18": { name: "Thai School Break", type: "school" },
  "2026-03-19": { name: "Thai School Break", type: "school" },
  "2026-03-20": { name: "Thai School Break", type: "school" },
  "2026-03-21": { name: "Thai School Break", type: "school" },
  "2026-03-22": { name: "Thai School Break", type: "school" },
  "2026-03-23": { name: "Thai School Break", type: "school" },
  "2026-03-24": { name: "Thai School Break", type: "school" },
  "2026-03-25": { name: "Thai School Break", type: "school" },
  "2026-03-26": { name: "Thai School Break", type: "school" },
  "2026-03-27": { name: "Thai School Break", type: "school" },
  "2026-03-28": { name: "Thai School Break", type: "school" },
  "2026-03-29": { name: "Thai School Break", type: "school" },
  "2026-03-30": { name: "Thai School Break", type: "school" },
  "2026-03-31": { name: "Thai School Break (end)", type: "school" },
  "2026-04-01": { name: "Thai School Break", type: "school" },
  "2026-04-02": { name: "Thai School Break", type: "school" },
  "2026-04-03": { name: "Thai School Break", type: "school" },
  "2026-04-04": { name: "Thai School Break", type: "school" },
  "2026-04-05": { name: "Thai School Break", type: "school" },
  "2026-04-06": { name: "Chakri Memorial Day", type: "thai" },
  "2026-04-07": { name: "Thai School Break", type: "school" },
  "2026-04-08": { name: "Thai School Break", type: "school" },
  "2026-04-09": { name: "Thai School Break", type: "school" },
  "2026-04-10": { name: "Thai School Break", type: "school" },
  "2026-04-11": { name: "Thai School Break", type: "school" },
  "2026-04-12": { name: "Thai School Break", type: "school" },
  "2026-04-13": { name: "Songkran (start)", type: "thai" },
  "2026-04-14": { name: "Songkran", type: "thai" },
  "2026-04-15": { name: "Songkran (end)", type: "thai" },
  "2026-04-16": { name: "Thai School Break", type: "school" },
  "2026-04-17": { name: "Thai School Break", type: "school" },
  "2026-04-18": { name: "Thai School Break", type: "school" },
  "2026-04-19": { name: "Thai School Break", type: "school" },
  "2026-04-20": { name: "Thai School Break", type: "school" },
  "2026-04-21": { name: "Thai School Break", type: "school" },
  "2026-04-22": { name: "Thai School Break", type: "school" },
  "2026-04-23": { name: "Thai School Break", type: "school" },
  "2026-04-24": { name: "Thai School Break", type: "school" },
  "2026-04-25": { name: "Thai School Break", type: "school" },
  "2026-04-26": { name: "Thai School Break", type: "school" },
  "2026-04-27": { name: "Thai School Break", type: "school" },
  "2026-04-28": { name: "Thai School Break", type: "school" },
  "2026-04-29": { name: "Thai School Break", type: "school" },
  "2026-04-30": { name: "Thai School Break (end)", type: "school" },
  "2026-05-01": { name: "Labour Day", type: "intl" },
  "2026-05-04": { name: "Coronation Day", type: "thai" },
  "2026-05-13": { name: "Royal Ploughing Ceremony", type: "thai" },
  "2026-05-15": { name: "Visakha Bucha Day", type: "thai" },
  "2026-06-03": { name: "Queen Suthida's Birthday", type: "thai" },
  "2026-06-15": { name: "Intl School Summer Break (start)", type: "school" },
  "2026-06-16": { name: "Intl School Summer", type: "school" },
  "2026-06-17": { name: "Intl School Summer", type: "school" },
  "2026-06-18": { name: "Intl School Summer", type: "school" },
  "2026-06-19": { name: "Intl School Summer", type: "school" },
  "2026-06-20": { name: "Intl School Summer", type: "school" },
  "2026-06-21": { name: "Intl School Summer", type: "school" },
  "2026-06-22": { name: "Intl School Summer", type: "school" },
  "2026-06-23": { name: "Intl School Summer", type: "school" },
  "2026-06-24": { name: "Intl School Summer", type: "school" },
  "2026-06-25": { name: "Intl School Summer", type: "school" },
  "2026-06-26": { name: "Intl School Summer", type: "school" },
  "2026-06-27": { name: "Intl School Summer", type: "school" },
  "2026-06-28": { name: "Intl School Summer", type: "school" },
  "2026-06-29": { name: "Intl School Summer", type: "school" },
  "2026-06-30": { name: "Intl School Summer", type: "school" },
  "2026-07-13": { name: "Asalha Bucha Day", type: "thai" },
  "2026-07-14": { name: "Buddhist Lent Day", type: "thai" },
  "2026-07-28": { name: "King's Birthday", type: "thai" },
  "2026-08-12": { name: "Mother's Day (Queen's Birthday)", type: "kid" },
  "2026-10-01": { name: "October Break (start)", type: "school" },
  "2026-10-02": { name: "October Break", type: "school" },
  "2026-10-03": { name: "October Break", type: "school" },
  "2026-10-04": { name: "October Break", type: "school" },
  "2026-10-05": { name: "October Break", type: "school" },
  "2026-10-06": { name: "October Break", type: "school" },
  "2026-10-07": { name: "October Break", type: "school" },
  "2026-10-08": { name: "October Break", type: "school" },
  "2026-10-09": { name: "October Break", type: "school" },
  "2026-10-10": { name: "October Break", type: "school" },
  "2026-10-11": { name: "October Break", type: "school" },
  "2026-10-12": { name: "October Break", type: "school" },
  "2026-10-13": { name: "King Bhumibol Memorial Day", type: "thai" },
  "2026-10-14": { name: "October Break", type: "school" },
  "2026-10-15": { name: "October Break", type: "school" },
  "2026-10-16": { name: "October Break", type: "school" },
  "2026-10-17": { name: "October Break", type: "school" },
  "2026-10-18": { name: "October Break", type: "school" },
  "2026-10-19": { name: "October Break", type: "school" },
  "2026-10-20": { name: "October Break", type: "school" },
  "2026-10-21": { name: "October Break", type: "school" },
  "2026-10-22": { name: "October Break", type: "school" },
  "2026-10-23": { name: "Chulalongkorn Day", type: "thai" },
  "2026-10-24": { name: "October Break", type: "school" },
  "2026-10-25": { name: "October Break", type: "school" },
  "2026-10-26": { name: "October Break", type: "school" },
  "2026-10-27": { name: "October Break", type: "school" },
  "2026-10-28": { name: "October Break", type: "school" },
  "2026-10-29": { name: "October Break", type: "school" },
  "2026-10-30": { name: "October Break", type: "school" },
  "2026-10-31": { name: "Halloween", type: "intl" },
  "2026-12-05": { name: "Father's Day (King Bhumibol)", type: "kid" },
  "2026-12-10": { name: "Constitution Day", type: "thai" },
  "2026-12-24": { name: "Christmas Eve", type: "kid" },
  "2026-12-25": { name: "Christmas Day", type: "kid" },
  "2026-12-26": { name: "Christmas Holiday", type: "kid" },
  "2026-12-27": { name: "Christmas Holiday", type: "kid" },
  "2026-12-28": { name: "Christmas Holiday", type: "kid" },
  "2026-12-29": { name: "Christmas Holiday", type: "kid" },
  "2026-12-30": { name: "New Year Period", type: "kid" },
  "2026-12-31": { name: "New Year's Eve", type: "kid" },
};

const BCIS_CALENDAR_RANGES: Array<{
  s: string;
  e: string;
  name: string;
  type: HolidayType;
}> = [
  { s: "2026-07-01", e: "2026-07-03", name: "Holiday Camp", type: "camp" },
  { s: "2026-07-06", e: "2026-07-10", name: "Holiday Camp", type: "camp" },
  { s: "2026-07-15", e: "2026-07-17", name: "Holiday Camp", type: "camp" },
  { s: "2026-07-20", e: "2026-07-22", name: "Holiday Camp", type: "camp" },
  { s: "2026-07-27", e: "2026-07-27", name: "Holiday Camp", type: "camp" },
  { s: "2026-07-29", e: "2026-07-31", name: "Holiday Camp", type: "camp" },
  {
    s: "2026-08-03",
    e: "2026-08-03",
    name: "New Teachers Inset",
    type: "inset",
  },
  { s: "2026-08-04", e: "2026-08-07", name: "Staff Inset Day", type: "inset" },
  { s: "2026-08-10", e: "2026-08-11", name: "Staff Prep", type: "inset" },
  { s: "2026-08-13", e: "2026-08-14", name: "Staff Prep", type: "inset" },
  { s: "2026-08-17", e: "2026-08-21", name: "Orientation Week", type: "inset" },
  {
    s: "2026-08-24",
    e: "2026-08-24",
    name: "Back to School · Term 1",
    type: "term",
  },
  { s: "2026-12-04", e: "2026-12-04", name: "Bridge Holiday", type: "thai" },
  { s: "2026-12-14", e: "2026-12-14", name: "End of Term 1", type: "term" },
  {
    s: "2026-12-15",
    e: "2026-12-23",
    name: "Christmas Holiday",
    type: "school",
  },
  { s: "2027-01-01", e: "2027-01-01", name: "New Year's Day", type: "intl" },
  { s: "2027-01-04", e: "2027-01-04", name: "Staff Inset Day", type: "inset" },
  { s: "2027-01-05", e: "2027-01-05", name: "Term 2 Start", type: "term" },
  { s: "2027-02-15", e: "2027-02-19", name: "Midterm Break", type: "school" },
  { s: "2027-02-22", e: "2027-02-22", name: "Makha Bucha Day", type: "thai" },
  {
    s: "2027-04-06",
    e: "2027-04-06",
    name: "Chakri Memorial Day",
    type: "thai",
  },
  { s: "2027-04-12", e: "2027-04-12", name: "End of Term 2", type: "term" },
  { s: "2027-04-13", e: "2027-04-16", name: "Songkran Holiday", type: "thai" },
  { s: "2027-04-19", e: "2027-04-23", name: "School Holiday", type: "school" },
  { s: "2027-04-26", e: "2027-04-26", name: "Staff Inset Day", type: "inset" },
  { s: "2027-04-27", e: "2027-04-27", name: "Term 3 Start", type: "term" },
  { s: "2027-05-01", e: "2027-05-01", name: "Labour Day", type: "intl" },
  { s: "2027-05-03", e: "2027-05-03", name: "Coronation Day", type: "thai" },
  { s: "2027-06-03", e: "2027-06-03", name: "Queen's Birthday", type: "thai" },
  { s: "2027-06-25", e: "2027-06-25", name: "Last School Day", type: "term" },
  { s: "2027-06-28", e: "2027-06-30", name: "Holiday Camp", type: "camp" },
];

for (const r of BCIS_CALENDAR_RANGES) {
  let d = new Date(r.s + "T12:00:00");
  const end = new Date(r.e + "T12:00:00");
  while (d <= end) {
    const ds = d.toISOString().split("T")[0];
    if (!INTELLIGENCE_CALENDAR[ds]) {
      INTELLIGENCE_CALENDAR[ds] = { name: r.name, type: r.type };
    }
    d.setDate(d.getDate() + 1);
  }
}

const INTL_SCHOOL_BREAKS: Array<{
  s: string;
  e: string;
  name: string;
}> = [
  { s: "2025-10-11", e: "2025-10-19", name: "Intl School Mid-Term Break" },
  { s: "2025-12-13", e: "2026-01-04", name: "Intl School Christmas Break" },
  { s: "2026-02-14", e: "2026-02-22", name: "Intl School Mid-Term Break" },
  { s: "2026-04-04", e: "2026-04-19", name: "Intl School Songkran/Easter Break" },
  { s: "2026-06-13", e: "2026-08-16", name: "Intl School Summer Break" },
  { s: "2026-10-11", e: "2026-10-19", name: "Intl School Mid-Term Break" },
  { s: "2026-12-12", e: "2027-01-04", name: "Intl School Christmas Break" },
  { s: "2027-02-14", e: "2027-02-22", name: "Intl School Mid-Term Break" },
  { s: "2027-04-03", e: "2027-04-19", name: "Intl School Songkran/Easter Break" },
];

const INTL_SCHOOL_LOOKUP = new Set<string>();
const INTL_SCHOOL_MAP: Record<string, string> = {};
for (const r of INTL_SCHOOL_BREAKS) {
  const start = new Date(r.s + "T12:00:00");
  const end = new Date(r.e + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    INTL_SCHOOL_LOOKUP.add(ds);
    INTL_SCHOOL_MAP[ds] = r.name;
  }
}

function getBangkokToday(): string {
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  return `${bkk.getFullYear()}-${String(bkk.getMonth() + 1).padStart(2, "0")}-${String(bkk.getDate()).padStart(2, "0")}`;
}

function fmtDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getHolidayForDate(
  date: string,
): { name: string; type: HolidayType } | null {
  return INTELLIGENCE_CALENDAR[date] || null;
}

function getAllHolidaysForDate(
  date: string,
): Array<{ name: string; type: HolidayType }> {
  const result: Array<{ name: string; type: HolidayType }> = [];
  const cal = INTELLIGENCE_CALENDAR[date];
  if (cal) result.push(cal);
  if (INTL_SCHOOL_LOOKUP.has(date)) {
    result.push({ name: INTL_SCHOOL_MAP[date], type: "intl_school" });
  }
  return result;
}

function hasAnyHoliday(date: string): boolean {
  return !!INTELLIGENCE_CALENDAR[date] || INTL_SCHOOL_LOOKUP.has(date);
}

const HOLIDAY_COLORS: Record<
  HolidayType,
  { bg: string; text: string; dot: string; label: string }
> = {
  thai: {
    bg: "bg-orange-100 dark:bg-orange-950/30",
    text: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
    label: "Thai Holiday",
  },
  intl: {
    bg: "bg-blue-100 dark:bg-blue-950/30",
    text: "text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
    label: "International",
  },
  school: {
    bg: "bg-indigo-100 dark:bg-indigo-950/30",
    text: "text-indigo-700 dark:text-indigo-400",
    dot: "bg-indigo-500",
    label: "School Break",
  },
  intl_school: {
    bg: "bg-purple-100 dark:bg-purple-950/30",
    text: "text-purple-700 dark:text-purple-400",
    dot: "bg-purple-500",
    label: "Intl School Break",
  },
  kid: {
    bg: "bg-amber-100 dark:bg-amber-950/30",
    text: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    label: "Kid Priority",
  },
  camp: {
    bg: "bg-cyan-100 dark:bg-cyan-950/30",
    text: "text-cyan-700 dark:text-cyan-400",
    dot: "bg-cyan-400",
    label: "Holiday Camp",
  },
  inset: {
    bg: "bg-rose-100 dark:bg-rose-950/30",
    text: "text-rose-700 dark:text-rose-400",
    dot: "bg-rose-400",
    label: "Inset / PD Day",
  },
  term: {
    bg: "bg-teal-100 dark:bg-teal-950/30",
    text: "text-teal-700 dark:text-teal-400",
    dot: "bg-teal-500",
    label: "Term Start / End",
  },
  milestone: {
    bg: "bg-yellow-100 dark:bg-yellow-950/40",
    text: "text-yellow-800 dark:text-yellow-300",
    dot: "bg-yellow-500",
    label: "OTO Milestone",
  },
  birthday: {
    bg: "bg-pink-100 dark:bg-pink-950/30",
    text: "text-pink-700 dark:text-pink-300",
    dot: "bg-pink-500",
    label: "Staff Birthday",
  },
};

type Branch = "floresta" | "chalong";
type ActiveBranches = Set<Branch>;

interface BranchForecastConfig {
  baseMonthlyRevenue: number;
  weekdaysPerMonth: number;
  weekendsPerMonth: number;
  seasonality: Record<number, number>;
  categoryShares: Record<string, number>;
  weekday: {
    kidsPerDay: number;
    adultsPerDay: number;
    kidRevPerDay: number;
    adultRevPerDay: number;
    marketSplit: Record<string, number>;
  };
  weekend: {
    kidsPerDay: number;
    adultsPerDay: number;
    kidRevPerDay: number;
    adultRevPerDay: number;
    marketSplit: Record<string, number>;
  };
  birthdaysPerMonth: number;
}

const FORECAST_CENTRAL: BranchForecastConfig = {
  baseMonthlyRevenue: 4929457,
  weekdaysPerMonth: 22,
  weekendsPerMonth: 8,
  seasonality: {
    0: 1.00, 1: 1.00, 2: 1.00, 3: 0.95, 4: 0.70, 5: 0.65,
    6: 0.75, 7: 0.75, 8: 0.65, 9: 0.80, 10: 0.90, 11: 1.00,
  },
  categoryShares: {
    "Tickets & Packages": 0.7107,
    "Events / Birthdays": 0.0584,
    "F&B": 0.1154,
    Extras: 0.1154,
  },
  weekday: {
    kidsPerDay: 100,
    adultsPerDay: 67.5,
    kidRevPerDay: 54850,
    adultRevPerDay: 23625,
    marketSplit: { Thai: 0.25, Expat: 0.25, Tourist: 0.50 },
  },
  weekend: {
    kidsPerDay: 210,
    adultsPerDay: 141.75,
    kidRevPerDay: 127680,
    adultRevPerDay: 94500,
    marketSplit: { Thai: 0.25, Expat: 0.25, Tourist: 0.50 },
  },
  birthdaysPerMonth: 16,
};

const FORECAST_CHALONG: BranchForecastConfig = {
  baseMonthlyRevenue: 700000,
  weekdaysPerMonth: 22,
  weekendsPerMonth: 8,
  seasonality: {
    0: 1.10, 1: 1.15, 2: 0.85, 3: 0.80, 4: 0.65, 5: 0.60,
    6: 0.70, 7: 0.70, 8: 0.60, 9: 0.75, 10: 0.90, 11: 1.10,
  },
  categoryShares: {
    "Tickets & Packages": 0.41,
    Extras: 0.25,
    "F&B": 0.17,
    "Events / Birthdays": 0.15,
    Merchandise: 0.03,
  },
  weekday: {
    kidsPerDay: 20,
    adultsPerDay: 15,
    kidRevPerDay: 12000,
    adultRevPerDay: 6500,
    marketSplit: { Thai: 0.60, Expat: 0.15, Tourist: 0.25 },
  },
  weekend: {
    kidsPerDay: 45,
    adultsPerDay: 30,
    kidRevPerDay: 27000,
    adultRevPerDay: 14000,
    marketSplit: { Thai: 0.55, Expat: 0.15, Tourist: 0.30 },
  },
  birthdaysPerMonth: 6,
};

interface ForecastResult {
  totalRevenue: number;
  categoryBreakdown: Record<string, number>;
  kids: number;
  adults: number;
  totalGuests: number;
  kidRevenue: number;
  adultRevenue: number;
  customerTypes: Array<{
    type: string;
    kids: number;
    adults: number;
    revenue: number;
    orders: number;
    totalGuests: number;
  }>;
}

function getForecastConfig(activeBranches: ActiveBranches): BranchForecastConfig {
  const hasFloresta = activeBranches.has("floresta");
  const hasChalong = activeBranches.has("chalong");
  if (hasFloresta && hasChalong) {
    return {
      baseMonthlyRevenue: FORECAST_CENTRAL.baseMonthlyRevenue + FORECAST_CHALONG.baseMonthlyRevenue,
      weekdaysPerMonth: 22,
      weekendsPerMonth: 8,
      seasonality: Object.fromEntries(
        Object.entries(FORECAST_CENTRAL.seasonality).map(([k, v]) => {
          const cw = FORECAST_CENTRAL.baseMonthlyRevenue;
          const ch = FORECAST_CHALONG.baseMonthlyRevenue;
          const chSeas = FORECAST_CHALONG.seasonality[Number(k)] || 1;
          return [k, (v * cw + chSeas * ch) / (cw + ch)];
        })
      ),
      categoryShares: (() => {
        const merged: Record<string, number> = {};
        const total = FORECAST_CENTRAL.baseMonthlyRevenue + FORECAST_CHALONG.baseMonthlyRevenue;
        for (const [cat, share] of Object.entries(FORECAST_CENTRAL.categoryShares)) {
          merged[cat] = (merged[cat] || 0) + share * FORECAST_CENTRAL.baseMonthlyRevenue / total;
        }
        for (const [cat, share] of Object.entries(FORECAST_CHALONG.categoryShares)) {
          merged[cat] = (merged[cat] || 0) + share * FORECAST_CHALONG.baseMonthlyRevenue / total;
        }
        return merged;
      })(),
      weekday: {
        kidsPerDay: FORECAST_CENTRAL.weekday.kidsPerDay + FORECAST_CHALONG.weekday.kidsPerDay,
        adultsPerDay: FORECAST_CENTRAL.weekday.adultsPerDay + FORECAST_CHALONG.weekday.adultsPerDay,
        kidRevPerDay: FORECAST_CENTRAL.weekday.kidRevPerDay + FORECAST_CHALONG.weekday.kidRevPerDay,
        adultRevPerDay: FORECAST_CENTRAL.weekday.adultRevPerDay + FORECAST_CHALONG.weekday.adultRevPerDay,
        marketSplit: FORECAST_CENTRAL.weekday.marketSplit,
      },
      weekend: {
        kidsPerDay: FORECAST_CENTRAL.weekend.kidsPerDay + FORECAST_CHALONG.weekend.kidsPerDay,
        adultsPerDay: FORECAST_CENTRAL.weekend.adultsPerDay + FORECAST_CHALONG.weekend.adultsPerDay,
        kidRevPerDay: FORECAST_CENTRAL.weekend.kidRevPerDay + FORECAST_CHALONG.weekend.kidRevPerDay,
        adultRevPerDay: FORECAST_CENTRAL.weekend.adultRevPerDay + FORECAST_CHALONG.weekend.adultRevPerDay,
        marketSplit: FORECAST_CENTRAL.weekend.marketSplit,
      },
      birthdaysPerMonth: FORECAST_CENTRAL.birthdaysPerMonth + FORECAST_CHALONG.birthdaysPerMonth,
    };
  }
  if (hasChalong) return FORECAST_CHALONG;
  return FORECAST_CENTRAL;
}

function getForecastForDateRange(startStr: string, endStr: string, activeBranches?: ActiveBranches): ForecastResult {
  const fc = activeBranches ? getForecastConfig(activeBranches) : FORECAST_CENTRAL;
  const start = new Date(startStr + "T12:00:00");
  const end = new Date(endStr + "T12:00:00");
  let totalForecast = 0;
  const categoryForecasts: Record<string, number> = {};
  let totalKids = 0, totalAdults = 0, totalKidRev = 0, totalAdultRev = 0;
  const marketKeys = new Set([
    ...Object.keys(fc.weekday.marketSplit),
    ...Object.keys(fc.weekend.marketSplit),
  ]);
  const ctAccum: Record<string, { kids: number; adults: number; revenue: number }> = {};
  for (const mk of marketKeys) {
    ctAccum[mk] = { kids: 0, adults: 0, revenue: 0 };
  }

  const weekdayDailyRev = fc.weekday.kidRevPerDay + fc.weekday.adultRevPerDay;
  const weekendDailyRev = fc.weekend.kidRevPerDay + fc.weekend.adultRevPerDay;

  const d = new Date(start);
  while (d <= end) {
    const month = d.getMonth();
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const seas = fc.seasonality[month] || 1;
    const daysInMonth = new Date(d.getFullYear(), month + 1, 0).getDate();

    let monthWeekdays = 0, monthWeekends = 0;
    for (let i = 1; i <= daysInMonth; i++) {
      const wd = new Date(d.getFullYear(), month, i).getDay();
      if (wd === 0 || wd === 6) monthWeekends++;
      else monthWeekdays++;
    }
    const monthTotalWeight = (monthWeekdays * weekdayDailyRev) + (monthWeekends * weekendDailyRev);
    const dayWeight = isWeekend ? weekendDailyRev : weekdayDailyRev;
    const dailyForecast = (fc.baseMonthlyRevenue * seas * dayWeight) / monthTotalWeight;
    totalForecast += dailyForecast;

    for (const [cat, share] of Object.entries(fc.categoryShares)) {
      categoryForecasts[cat] = (categoryForecasts[cat] || 0) + dailyForecast * share;
    }

    const profile = isWeekend ? fc.weekend : fc.weekday;
    const dayKids = profile.kidsPerDay * seas;
    const dayAdults = profile.adultsPerDay * seas;
    const dayKidRev = profile.kidRevPerDay * seas;
    const dayAdultRev = profile.adultRevPerDay * seas;
    totalKids += dayKids;
    totalAdults += dayAdults;
    totalKidRev += dayKidRev;
    totalAdultRev += dayAdultRev;

    for (const [market, share] of Object.entries(profile.marketSplit)) {
      ctAccum[market].kids += dayKids * share;
      ctAccum[market].adults += dayAdults * share;
      ctAccum[market].revenue += (dayKidRev + dayAdultRev) * share;
    }

    d.setDate(d.getDate() + 1);
  }

  const customerTypes = Object.entries(ctAccum).map(([type, data]) => ({
    type,
    kids: Math.round(data.kids),
    adults: Math.round(data.adults),
    revenue: data.revenue,
    orders: Math.round(data.kids),
    kidTickets: Math.round(data.kids),
    adultTickets: Math.round(data.adults),
    totalGuests: Math.round(data.kids + data.adults),
  }));

  return {
    totalRevenue: totalForecast,
    categoryBreakdown: categoryForecasts,
    kids: Math.round(totalKids),
    adults: Math.round(totalAdults),
    totalGuests: Math.round(totalKids + totalAdults),
    kidRevenue: totalKidRev,
    adultRevenue: totalAdultRev,
    customerTypes,
  };
}

function getForecastForDate(dateStr: string, activeBranches?: ActiveBranches): ForecastResult {
  return getForecastForDateRange(dateStr, dateStr, activeBranches);
}

type CompDeltaMode = "pct" | "abs";

function ComparisonDelta({ current, previous, format = "number", label, compact = false, deltaMode = "pct" }: {
  current: number;
  previous: number;
  format?: "number" | "baht";
  label?: string;
  compact?: boolean;
  deltaMode?: CompDeltaMode;
}) {
  if (previous === 0 && current === 0) return null;
  const fmtVal = format === "baht"
    ? (v: number) => `฿${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : (v: number) => v.toLocaleString();

  if (previous === 0 && current > 0) {
    if (compact) {
      return <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">new</span>;
    }
    return (
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-muted-foreground">{label || "vs"} {fmtVal(0)}</span>
        <span className="font-semibold text-emerald-600 dark:text-emerald-400">new</span>
      </div>
    );
  }
  if (previous > 0 && current === 0) {
    const absVal = format === "baht" ? `฿${previous.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : previous.toLocaleString();
    if (compact) {
      return <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-500 dark:text-red-400">
        {deltaMode === "abs" ? `▼${absVal}` : "▼100%"}
      </span>;
    }
    return (
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-muted-foreground">{label || "vs"} {fmtVal(previous)}</span>
        <span className="font-semibold text-red-500 dark:text-red-400">
          {deltaMode === "abs" ? `▼${absVal}` : "▼100%"}
        </span>
      </div>
    );
  }

  const pct = ((current - previous) / previous) * 100;
  const diff = current - previous;
  const isUp = diff >= 0;
  const isFlat = Math.abs(pct) < 0.5;

  const absDiffStr = format === "baht"
    ? `฿${Math.abs(Math.round(diff)).toLocaleString()}`
    : Math.abs(Math.round(diff)).toLocaleString();
  const deltaStr = deltaMode === "abs"
    ? `${isFlat ? "~" : isUp ? "+" : "-"}${absDiffStr}`
    : `${isFlat ? "~" : isUp ? "▲" : "▼"}${Math.abs(pct).toFixed(0)}%`;

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-[10px] font-semibold",
        isFlat ? "text-muted-foreground" : isUp ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"
      )}>
        {deltaStr}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="text-muted-foreground">{label || "vs"} {fmtVal(previous)}</span>
      <span className={cn("font-semibold",
        isFlat ? "text-muted-foreground" : isUp ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"
      )}>
        {deltaStr}
      </span>
    </div>
  );
}

function MetricCardSkeleton() {
  return (
    <div className="neu-card overflow-hidden p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-2">
          <div className="h-4 w-24 rounded skeleton-shimmer" />
          <div className="h-7 w-32 rounded skeleton-shimmer" />
          <div className="h-3 w-20 rounded skeleton-shimmer" />
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  annotation,
  icon: Icon,
  color = "blue",
  className: extraClass,
  comparison,
  deltaMode,
}: {
  title: string;
  value: string;
  subtitle?: string;
  annotation?: string;
  icon: any;
  color?: string;
  className?: string;
  comparison?: { prevValue: number; currValue: number; label: string; format?: "number" | "baht" } | null;
  deltaMode?: CompDeltaMode;
}) {
  const colorMap: Record<string, { icon: string; accent: string; border: string }> = {
    green: {
      icon: "bg-emerald-100/80 dark:bg-emerald-900/30",
      accent: "from-emerald-500/8 via-emerald-400/3 to-transparent dark:from-emerald-500/10 dark:via-emerald-400/4 dark:to-transparent",
      border: "border-emerald-200/40 dark:border-emerald-800/30",
    },
    red: {
      icon: "bg-red-100/80 dark:bg-red-900/30",
      accent: "from-red-500/8 via-red-400/3 to-transparent dark:from-red-500/10 dark:via-red-400/4 dark:to-transparent",
      border: "border-red-200/40 dark:border-red-800/30",
    },
    blue: {
      icon: "bg-blue-100/80 dark:bg-blue-900/30",
      accent: "from-blue-500/8 via-blue-400/3 to-transparent dark:from-blue-500/10 dark:via-blue-400/4 dark:to-transparent",
      border: "border-blue-200/40 dark:border-blue-800/30",
    },
    orange: {
      icon: "bg-orange-100/80 dark:bg-orange-900/30",
      accent: "from-orange-500/8 via-orange-400/3 to-transparent dark:from-orange-500/10 dark:via-orange-400/4 dark:to-transparent",
      border: "border-orange-200/40 dark:border-orange-800/30",
    },
    purple: {
      icon: "bg-purple-100/80 dark:bg-purple-900/30",
      accent: "from-purple-500/8 via-purple-400/3 to-transparent dark:from-purple-500/10 dark:via-purple-400/4 dark:to-transparent",
      border: "border-purple-200/40 dark:border-purple-800/30",
    },
    cyan: {
      icon: "bg-cyan-100/80 dark:bg-cyan-900/30",
      accent: "from-cyan-500/8 via-cyan-400/3 to-transparent dark:from-cyan-500/10 dark:via-cyan-400/4 dark:to-transparent",
      border: "border-cyan-200/40 dark:border-cyan-800/30",
    },
  };

  const colors = colorMap[color] || colorMap.blue;

  return (
    <div className={cn("neu-card overflow-hidden relative p-3 sm:p-5 border", colors.border, extraClass)}>
      <div
        className={`absolute inset-0 bg-gradient-to-br ${colors.accent} pointer-events-none`}
      />
      <div className="relative">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] sm:text-[12px] font-extrabold text-muted-foreground tracking-widest uppercase">
              {title}
            </p>
            <p
              className="text-[22px] sm:text-[30px] font-extrabold mt-0.5 sm:mt-1 metric-value leading-tight"
              data-testid={`metric-${title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {value}
            </p>
            {subtitle && (
              <p className="text-[10px] sm:text-[12px] text-muted-foreground mt-1 sm:mt-1.5 font-semibold leading-snug">
                {subtitle}
              </p>
            )}
            {annotation && (
              <p className="text-[9px] sm:text-[10px] text-muted-foreground/60 mt-0.5 font-semibold leading-snug">
                {annotation}
              </p>
            )}
            {comparison && (comparison.prevValue > 0 || comparison.currValue > 0) && (() => {
              if (comparison.prevValue === 0 && comparison.currValue > 0) {
                return (
                  <div className="flex items-center gap-1 mt-1.5" data-testid={`comparison-${title.toLowerCase().replace(/\s+/g, "-")}`}>
                    <span className="text-[10px] sm:text-[11px] font-bold text-emerald-600 dark:text-emerald-400">new</span>
                    <span className="text-[9px] text-muted-foreground/60 truncate">vs {comparison.label} (no data)</span>
                  </div>
                );
              }
              const diff = comparison.currValue - comparison.prevValue;
              const pct = ((diff) / comparison.prevValue) * 100;
              const isUp = diff >= 0;
              const isFlat = Math.abs(pct) < 0.5;
              const dm = deltaMode || "pct";
              const fmt = comparison.format || "number";
              const absDiffStr = fmt === "baht"
                ? `฿${Math.abs(Math.round(diff)).toLocaleString()}`
                : Math.abs(Math.round(diff)).toLocaleString();
              const deltaStr = dm === "abs"
                ? `${isFlat ? "~" : isUp ? "+" : "-"}${absDiffStr}`
                : `${isFlat ? "~" : isUp ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%`;
              return (
                <div className="flex items-center gap-1 mt-1.5" data-testid={`comparison-${title.toLowerCase().replace(/\s+/g, "-")}`}>
                  <span className={cn(
                    "text-[10px] sm:text-[11px] font-bold",
                    isFlat ? "text-muted-foreground" : isUp ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400",
                  )}>
                    {deltaStr}
                  </span>
                  <span className="text-[9px] text-muted-foreground/60 truncate">
                    vs {comparison.label}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

interface DiscountOrder {
  orderId: string;
  orderNumber: string;
  time: string;
  channel: string;
  terminal: string;
  billTotal: number;
  discountTotal: number;
  revenue: number;
  items: Array<{ name: string; quantity: number; price: number }>;
  payments: Array<{ method: string; amount: number }>;
  discountItems: Array<{ name: string; total: number }>;
}

function DiscountOrderDetail({ order }: { order: DiscountOrder }) {
  const timeStr = order.time ? (() => {
    try {
      const d = new Date(order.time);
      return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  })() : "";

  return (
    <div className="neu-inset rounded-xl p-3 space-y-2" data-testid={`discount-order-${order.orderId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {timeStr && <span className="text-xs font-mono text-muted-foreground">{timeStr}</span>}
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{order.channel}</span>
        </div>
        <span className="text-sm font-bold metric-value">฿{Math.round(order.revenue).toLocaleString()}</span>
      </div>
      <div className="space-y-0.5">
        {order.items.map((item, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <span className="text-foreground/80 truncate flex-1">{item.quantity > 1 ? `${item.quantity}× ` : ""}{item.name}</span>
            <span className="text-muted-foreground ml-2 shrink-0">฿{Math.round(item.price).toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-border/50 pt-1.5 flex items-center justify-between">
        <div className="flex gap-1.5 flex-wrap">
          {order.payments.map((p, idx) => (
            <span key={idx} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">
              {p.method} ฿{Math.round(p.amount).toLocaleString()}
            </span>
          ))}
        </div>
        <span className="text-xs text-red-500 font-semibold">-฿{Math.round(order.discountTotal).toLocaleString()}</span>
      </div>
    </div>
  );
}

function DiscountBreakdown({
  discounts,
  date,
  from,
  to,
}: {
  discounts: Array<{ name: string; count: number; total: number }>;
  date?: string;
  from?: string;
  to?: string;
}) {
  const [expandedDiscount, setExpandedDiscount] = useState<string | null>(null);
  const [discountOrders, setDiscountOrders] = useState<Record<string, DiscountOrder[]>>({});
  const [loadingDiscount, setLoadingDiscount] = useState<string | null>(null);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  if (!discounts || discounts.length === 0) return null;
  const grandTotal = discounts.reduce((s, d) => s + d.total, 0);
  const totalUses = discounts.reduce((s, d) => s + d.count, 0);
  const colors = ["#ef4444", "#f97316", "#eab308", "#a855f7", "#ec4899", "#06b6d4", "#84cc16", "#6366f1"];

  // Resolve the period the discount lookup should query (single day OR range).
  const queryFrom = from || date;
  const queryTo = to || date;
  const canFetchOrders = !!(queryFrom && queryTo);

  const handleDiscountClick = async (discountName: string) => {
    if (expandedDiscount === discountName) {
      setExpandedDiscount(null);
      return;
    }
    setExpandedDiscount(discountName);
    setExpandedOrder(null);

    if (discountOrders[discountName]) return;
    if (!canFetchOrders) return;

    setLoadingDiscount(discountName);
    try {
      const params = new URLSearchParams({
        from: queryFrom!,
        to: queryTo!,
        discount: discountName,
      });
      const resp = await fetch(`/api/papaya/orders-by-discount?${params.toString()}`);
      const data = await resp.json();
      setDiscountOrders((prev) => ({ ...prev, [discountName]: data.orders || [] }));
    } catch (e) {
      console.error("Failed to fetch discount orders:", e);
      setDiscountOrders((prev) => ({ ...prev, [discountName]: [] }));
    } finally {
      setLoadingDiscount(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="discount-breakdown">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Discounts Applied</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500 font-semibold">{totalUses} uses</span>
        </div>
        <span className="text-sm font-bold text-red-500">-฿{Math.round(grandTotal).toLocaleString()}</span>
      </div>
      <div className="neu-inset h-4 overflow-hidden flex rounded-full">
        {discounts.map((d, i) => {
          const pct = grandTotal > 0 ? (d.total / grandTotal) * 100 : 0;
          return (
            <div
              key={d.name}
              className="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
              style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }}
              title={`${d.name}: ฿${Math.round(d.total).toLocaleString()} (${d.count}x)`}
            />
          );
        })}
      </div>
      <div className="space-y-1">
        {discounts.map((d, i) => {
          const isExpanded = expandedDiscount === d.name;
          const orders = discountOrders[d.name];
          const isLoading = loadingDiscount === d.name;
          return (
            <div key={d.name}>
              <button
                onClick={() => handleDiscountClick(d.name)}
                className={cn(
                  "flex items-center gap-2 px-1 py-1.5 rounded-lg w-full text-left transition-colors",
                  isExpanded ? "bg-foreground/10" : "hover:bg-foreground/5",
                  date ? "cursor-pointer" : "cursor-default",
                )}
                data-testid={`discount-row-${i}`}
              >
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colors[i % colors.length] }} />
                <span className="text-sm flex-1 truncate">{d.name}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{d.count}x</span>
                <span className="text-sm font-semibold text-red-500 metric-value">-฿{Math.round(d.total).toLocaleString()}</span>
                {date && (
                  <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", isExpanded && "rotate-180")} />
                )}
              </button>
              {isExpanded && (
                <div className="pl-5 pr-1 pb-2 space-y-2 mt-1 animate-slide-up">
                  {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-xs text-muted-foreground ml-2">Loading orders...</span>
                    </div>
                  ) : orders && orders.length > 0 ? (
                    orders.map((order) => {
                      const isOrderExpanded = expandedOrder === order.orderId;
                      const timeStr = order.time ? (() => {
                        try {
                          const dt = new Date(order.time);
                          return dt.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
                        } catch { return ""; }
                      })() : "";
                      return (
                        <div key={order.orderId}>
                          <button
                            onClick={() => setExpandedOrder(isOrderExpanded ? null : order.orderId)}
                            className={cn(
                              "flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg transition-colors",
                              isOrderExpanded ? "bg-foreground/8" : "hover:bg-foreground/5",
                            )}
                            data-testid={`discount-order-row-${order.orderId}`}
                          >
                            {timeStr && <span className="text-xs font-mono text-muted-foreground shrink-0">{timeStr}</span>}
                            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium shrink-0">{order.channel}</span>
                            <span className="text-xs text-muted-foreground flex-1 truncate">
                              {order.items.length} item{order.items.length !== 1 ? "s" : ""}
                            </span>
                            <span className="text-xs text-red-500 font-semibold shrink-0">-฿{Math.round(order.discountTotal).toLocaleString()}</span>
                            <span className="text-sm font-semibold metric-value shrink-0">฿{Math.round(order.revenue).toLocaleString()}</span>
                            <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform shrink-0", isOrderExpanded && "rotate-180")} />
                          </button>
                          {isOrderExpanded && (
                            <div className="mt-1 ml-2">
                              <DiscountOrderDetail order={order} />
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : orders && orders.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">No orders found</p>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SalesInsights({
  paymentData,
  products,
  compPaymentData,
  compProducts,
  compLabel,
  deltaMode = "pct",
}: {
  paymentData: Record<string, number>;
  products: Array<{ name: string; revenue: number; quantity: number; category: string }>;
  compPaymentData?: Record<string, number> | null;
  compProducts?: Array<{ name: string; revenue: number; quantity: number; category: string }> | null;
  compLabel?: string;
  deltaMode?: CompDeltaMode;
}) {
  const payEntries = Object.entries(paymentData).sort((a, b) => b[1] - a[1]);
  const payTotal = payEntries.reduce((s, [, v]) => s + v, 0);
  const voucherAmount = Number(paymentData["Voucher"] || 0);
  const netRevenue = payTotal - voucherAmount;
  const allItems = products;
  const [showAllProducts, setShowAllProducts] = useState(false);
  const visibleCount = showAllProducts ? Math.min(allItems.length, 10) : Math.min(allItems.length, 5);
  const items = allItems.slice(0, visibleCount);
  const maxRevenue = Math.max(...allItems.slice(0, 10).map((p) => p.revenue), 1);

  const payColors = ["#3b82f6", "#22c55e", "#f97316", "#a855f7", "#ec4899", "#06b6d4", "#eab308"];
  const productColors = [
    "#3b82f6", "#a855f7", "#f97316", "#22c55e", "#ec4899",
    "#06b6d4", "#d946ef", "#84cc16", "#6366f1", "#ef4444",
  ];

  return (
    <div className="space-y-3">
      {payEntries.length > 0 && (
        <div data-testid="payment-stacked-bar">
          <div className="neu-inset h-5 overflow-hidden flex rounded-full">
            {payEntries.map(([method, amount], i) => {
              const pct = payTotal > 0 ? (amount / payTotal) * 100 : 0;
              return (
                <div
                  key={method}
                  className="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${pct}%`, backgroundColor: payColors[i % payColors.length] }}
                  title={`${method}: ฿${Math.round(amount).toLocaleString()} (${Math.round(pct)}%)`}
                  data-testid={`payment-row-${method.toLowerCase().replace(/\s+/g, "-")}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 px-1">
            {payEntries.map(([method, amount], i) => {
              const pct = payTotal > 0 ? Math.round((amount / payTotal) * 100) : 0;
              const isVoucher = method === "Voucher";
              return (
                <div
                  key={method}
                  className="flex items-center gap-1.5 text-xs"
                  data-testid={`payment-legend-${method.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: payColors[i % payColors.length] }} />
                  <span className="text-muted-foreground">{method}</span>
                  <span className="font-semibold metric-value">฿{Math.round(amount).toLocaleString()}</span>
                  <span className="text-muted-foreground/60">({pct}%)</span>
                  {isVoucher && voucherAmount > 0 && (
                    <span
                      className="text-[10px] italic text-muted-foreground/80"
                      title={`Vouchers were already counted in revenue earlier. Net Revenue = Payments − Vouchers = ฿${Math.round(netRevenue).toLocaleString()}.`}
                      data-testid="voucher-note-inline"
                    >
                      (already in revenue)
                    </span>
                  )}
                  {compPaymentData && compPaymentData[method] !== undefined && (
                    <ComparisonDelta current={amount} previous={compPaymentData[method]} format="baht" compact deltaMode={deltaMode} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div data-testid="top-products-table">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="dash-section-header">Top Products</span>
            <span className="dash-meta">
              {showAllProducts || allItems.length <= 5 ? `${items.length} items` : `Top 5 of ${Math.min(allItems.length, 10)}`}
            </span>
          </div>
          <div className="space-y-1">
            {items.map((p, i) => {
              const pct = Math.round((p.revenue / maxRevenue) * 100);
              const color = productColors[i % productColors.length];
              return (
                <div
                  key={`${p.name}-${i}`}
                  className="group relative flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-muted/40 transition-colors duration-150"
                  data-testid={`top-product-${i}`}
                >
                  <span
                    className="inline-flex items-center justify-center rounded-full text-white font-bold shrink-0 h-5 w-5 text-[9px]"
                    style={{ backgroundColor: color }}
                  >
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium truncate">{p.name}</span>
                      <span className="text-[13px] font-bold metric-value shrink-0">
                        ฿{p.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                      {compProducts && (() => {
                        const cp = compProducts.find(c => c.name === p.name);
                        return cp ? <ComparisonDelta current={p.revenue} previous={cp.revenue} format="baht" compact deltaMode={deltaMode} /> : null;
                      })()}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex-1 neu-inset h-1.5 overflow-hidden rounded-full">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">×{p.quantity}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {allItems.length > 5 && (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAllProducts((v) => !v)}
                className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded-full hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                data-testid="btn-toggle-top-products"
              >
                {showAllProducts
                  ? "Show top 5"
                  : `Show all (${Math.min(allItems.length, 10)})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  "Tickets & Packages": "Tickets",
};

const getCategoryDisplayName = (name: string) =>
  CATEGORY_DISPLAY_NAMES[name] || name;

const CATEGORY_CONFIG: Record<
  string,
  { icon: any; color: string; bgColor: string }
> = {
  "Tickets & Packages": {
    icon: OtoTicket,
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-50 dark:bg-blue-950/20",
  },
  "F&B": {
    icon: OtoFnb,
    color: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-amber-50 dark:bg-amber-950/20",
  },
  "Events / Birthdays": {
    icon: OtoEvents,
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-50 dark:bg-purple-950/20",
  },
  "Nanny & Drop-off": {
    icon: OtoNanny,
    color: "text-pink-600 dark:text-pink-400",
    bgColor: "bg-pink-50 dark:bg-pink-950/20",
  },
  Merchandise: {
    icon: OtoMerch,
    color: "text-teal-600 dark:text-teal-400",
    bgColor: "bg-teal-50 dark:bg-teal-950/20",
  },
  Camp: {
    icon: Tent,
    color: "text-emerald-600 dark:text-emerald-400",
    bgColor: "bg-emerald-50 dark:bg-emerald-950/20",
  },
  Workshop: {
    icon: Sparkles,
    color: "text-indigo-600 dark:text-indigo-400",
    bgColor: "bg-indigo-50 dark:bg-indigo-950/20",
  },
  Extras: {
    icon: OtoExtras,
    color: "text-slate-600 dark:text-slate-500",
    bgColor: "bg-slate-50 dark:bg-gray-950/20",
  },
};

function ProductList({
  items,
}: {
  items: Array<{
    name: string;
    category: string;
    revenue: number;
    quantity: number;
    bdayRevenue?: number;
  }>;
}) {
  // task-119: when the server splits a product's bday and non-bday sales into
  // two rows, the user can collapse them back into a single row with a
  // partial bday badge (the original "grouped" view). Default is grouped so
  // the list stays compact; toggle reveals the split breakdown.
  const hasSplit = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const it of items) {
      const isBday = !!(it.bdayRevenue && it.bdayRevenue > 0);
      const prev = seen.get(it.name);
      if (prev === undefined) seen.set(it.name, isBday);
      else if (prev !== isBday) return true;
    }
    return false;
  }, [items]);
  const [grouped, setGrouped] = useState(true);

  const displayItems = useMemo(() => {
    if (!grouped) return items;
    const map = new Map<string, { name: string; category: string; revenue: number; quantity: number; bdayRevenue?: number }>();
    for (const it of items) {
      const ex = map.get(it.name);
      if (ex) {
        ex.revenue += it.revenue;
        ex.quantity += it.quantity;
        if (it.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + it.bdayRevenue;
      } else {
        map.set(it.name, { ...it });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [items, grouped]);

  if (!items.length)
    return (
      <p className="text-xs text-muted-foreground text-center py-2">No items</p>
    );
  const maxRev = Math.max(...displayItems.map((i) => i.revenue), 1);
  return (
    <div className="space-y-1.5">
      {hasSplit ? (
        <div className="flex justify-end -mt-1 mb-0.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setGrouped((g) => !g); }}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded border border-border/60 hover:border-border"
            title={
              grouped
                ? "Showing one row per product — birthday and non-birthday sales are combined. Click to split."
                : "Showing birthday and non-birthday sales as separate rows. Click to group."
            }
            data-testid="button-toggle-bday-grouping"
          >
            {grouped ? "Split bday" : "Group bday"}
          </button>
        </div>
      ) : null}
      {displayItems.map((item, i) => {
        const showBdayBadge = !!(item.bdayRevenue && item.bdayRevenue > 0);
        const isPartialBday = grouped && showBdayBadge && item.bdayRevenue! < item.revenue;
        return (
          <div
            key={`${item.name}-${grouped ? "g" : "s"}-${i}`}
            className="flex items-center gap-2 text-xs"
            data-testid={`product-item-${i}`}
          >
            <div className="flex-1 min-w-0">
              <span className="truncate block">
                {item.name}
                {showBdayBadge ? (
                  <span
                    className="ml-1.5 inline-flex items-center align-middle px-1 py-0 rounded text-[9px] font-semibold uppercase tracking-wide bg-pink-500/15 text-pink-600 dark:text-pink-300"
                    title={
                      isPartialBday
                        ? `Includes ฿${Math.round(item.bdayRevenue!).toLocaleString()} from birthday-party orders`
                        : `Birthday-party orders only — ฿${Math.round(item.bdayRevenue!).toLocaleString()}`
                    }
                    data-testid={`badge-bday-${i}`}
                  >
                    bday
                  </span>
                ) : null}
              </span>
              <div className="h-1 bg-muted/60 rounded-full mt-0.5 overflow-hidden">
                <div
                  className="h-full bg-primary/50 rounded-full progress-bar-fill"
                  style={{ width: `${(item.revenue / maxRev) * 100}%` }}
                />
              </div>
            </div>
            <span className="text-muted-foreground shrink-0">
              ×{item.quantity}
            </span>
            <span className="font-medium shrink-0 w-16 text-right">
              ฿
              {item.revenue.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface DashboardSummaryData {
  date?: string;
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  paymentBreakdown: Record<string, number>;
  topProducts: Array<{
    name: string;
    category: string;
    quantity: number;
    revenue: number;
  }>;
  categoryBreakdown: Record<string, CategoryData>;
  // task-114 v3: per-natural-category breakdown of revenue from
  // birthday-channel orders (Chalong/Papaya only). Used to flip the BD
  // allocation view client-side without a server roundtrip.
  birthdayChannelSplit?: Record<string, CategoryData>;
  discountTotal: number;
  discountBreakdown?: Array<{ name: string; count: number; total: number }>;
  guestBreakdown: GuestBreakdownData | null;
  hourlyBreakdown: Array<{
    hour: number;
    label: string;
    orders: number;
    revenue: number;
    ticketsSold: number;
    summerCamp?: { orders: number; revenue: number; ticketsSold: number };
  }>;
  customerTypeSplit: Array<{
    type: string;
    orders: number;
    revenue: number;
    kidTickets: number;
    adultTickets: number;
    totalGuests: number;
  }>;
  voucherSwingAmount: number;
  pureTicketRevenue: number;
  sourceBreakdown?: Array<{
    source: string;
    orders: number;
    revenue: number;
    discount: number;
    variants: Array<{ name: string; orders: number; revenue: number; discount: number }>;
  }>;
  birthdayLinks?: BirthdayLinksData | null;
  birthdayAllocation?: "fnb" | "events";
  birthdayMovedAmount?: number;
  dailyRevenue?: Array<{ date: string; revenue: number; orders: number; kids?: number; adults?: number; categories?: Record<string, number>; customerTypes?: Record<string, { kids: number; adults: number }> }>;
  cashReportsDailyTotals?: Array<{
    date: string;
    revenue: number;
    florestaRevenue?: number;
  }>;
  dailyHourly?: Array<{
    date: string;
    hourlyBreakdown: Array<{
      hour: number;
      label: string;
      orders: number;
      revenue: number;
      ticketsSold: number;
      summerCamp?: { orders: number; revenue: number; ticketsSold: number };
    }>;
  }>;
  staffOnDuty?: number;
  eventCount?: number;
  funtopiaConnected?: boolean;
  papayaConnected?: boolean;
}

interface GuestBreakdownData {
  kidTickets: number;
  adultTickets: number;
  kidRevenue: number;
  adultRevenue: number;
  avgStayHours: number;
  estimatedTotalAdults: number;
  totalInPark: number;
  stayDistribution: Array<{ hours: number; count: number; label: string }>;
  details: Array<{
    name: string;
    type: string;
    quantity: number;
    revenue: number;
  }>;
}

function GuestBreakdownCard({
  data,
  embedded,
  hourlyData,
  date,
  customerTypeSplit,
  onGraphFilter,
  compData,
  compCustomerTypes,
  compLabel,
  voucherAmount = 0,
  vouchersToFnb = false,
  deltaMode = "pct",
}: {
  data: GuestBreakdownData;
  embedded?: boolean;
  hourlyData?: HourlyBucket[];
  date?: string;
  customerTypeSplit?: CustomerTypeData[];
  onGraphFilter?: (filter: PerfGraphFilter) => void;
  compData?: GuestBreakdownData | null;
  compCustomerTypes?: CustomerTypeData[];
  compLabel?: string;
  voucherAmount?: number;
  vouchersToFnb?: boolean;
  deltaMode?: CompDeltaMode;
}) {
  const totalInPark = data.totalInPark || data.kidTickets + (data.estimatedTotalAdults || data.adultTickets);
  const kidPct =
    totalInPark > 0 ? Math.round((data.kidTickets / totalInPark) * 100) : 0;
  const adultPct = 100 - kidPct;

  const bangkokDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const todayStr = `${bangkokDate.getFullYear()}-${String(bangkokDate.getMonth() + 1).padStart(2, "0")}-${String(bangkokDate.getDate()).padStart(2, "0")}`;
  const isToday = date === todayStr;
  const hasOngoing = (data as any).ongoingTotal > 0;
  const showOngoing = isToday && hasOngoing;

  const ongoingKids = (data as any).ongoingKids || 0;
  const ongoingAdults = (data as any).ongoingAdults || 0;
  const ongoingTotal = (data as any).ongoingTotal || 0;

  const content = (
    <div className="space-y-4">
      {showOngoing && (
        <div className="neu-card p-4 relative overflow-hidden border border-emerald-500/20">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-emerald-400/5 to-transparent pointer-events-none" />
          <div className="relative">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  Currently Inside
                </span>
              </div>
              <span className="text-3xl font-bold text-emerald-800 dark:text-emerald-200 metric-value" data-testid="metric-ongoing-total">
                {ongoingTotal}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <div>
                  <span className="text-lg font-bold text-blue-800 dark:text-blue-200">{ongoingKids}</span>
                  <span className="text-xs text-muted-foreground ml-1">kids</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div>
                  <span className="text-lg font-bold text-green-800 dark:text-green-200">{ongoingAdults}</span>
                  <span className="text-xs text-muted-foreground ml-1">adults</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={showOngoing ? "" : ""}>
        {showOngoing && (
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Total Visitors Today</p>
        )}
        <div className="grid grid-cols-3 gap-3">
          <div
            className={cn("neu-card p-3 relative overflow-hidden", onGraphFilter && "cursor-pointer hover:ring-2 hover:ring-blue-400/40 transition-all")}
            onClick={() => onGraphFilter?.({ type: "headcount", key: "kids", label: "Kids" })}
            data-testid="card-headcount-kids"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/8 via-blue-400/3 to-transparent pointer-events-none" />
            <div className="relative">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                  Kids
                </span>
              </div>
              <p
                className="text-xl font-bold text-blue-800 dark:text-blue-200 metric-value"
                data-testid="metric-kids-count"
              >
                {data.kidTickets}
              </p>
              <p className="text-xs text-blue-600/70 dark:text-blue-400/70">
                ฿
                {data.kidRevenue.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}{" "}
                rev
              </p>
              {compData && <ComparisonDelta current={data.kidTickets} previous={compData.kidTickets} compact deltaMode={deltaMode} />}
            </div>
          </div>
          <div
            className={cn("neu-card p-3 relative overflow-hidden", onGraphFilter && "cursor-pointer hover:ring-2 hover:ring-emerald-400/40 transition-all")}
            onClick={() => onGraphFilter?.({ type: "headcount", key: "adults", label: "Adults" })}
            data-testid="card-headcount-adults"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/8 via-emerald-400/3 to-transparent pointer-events-none" />
            <div className="relative">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-medium text-green-700 dark:text-green-300">
                  Adults
                </span>
              </div>
              <p
                className="text-xl font-bold text-green-800 dark:text-green-200 metric-value"
                data-testid="metric-adults-count"
              >
                {data.estimatedTotalAdults}
              </p>
              <p className="text-xs text-green-600/70 dark:text-green-400/70">
                ฿{data.adultRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} rev
              </p>
              <p className="text-xs text-green-600/70 dark:text-green-400/70">
                {data.adultTickets} paid · {data.estimatedTotalAdults - data.adultTickets} free
              </p>
              {compData && <ComparisonDelta current={data.estimatedTotalAdults} previous={compData.estimatedTotalAdults || compData.adultTickets} compact deltaMode={deltaMode} />}
            </div>
          </div>
          <div className="neu-card p-3 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-purple-500/8 via-purple-400/3 to-transparent pointer-events-none" />
            <div className="relative">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-medium text-purple-700 dark:text-purple-300">
                  Total
                </span>
              </div>
              <p
                className="text-xl font-bold text-purple-800 dark:text-purple-200 metric-value"
                data-testid="metric-total-in-park"
              >
                {totalInPark}
              </p>
              <p className="text-xs text-purple-600/70 dark:text-purple-400/70">
                Kids + adults
              </p>
              {compData && (() => {
                const compTotal = compData.totalInPark || (compData.kidTickets + (compData.estimatedTotalAdults || compData.adultTickets));
                return <ComparisonDelta current={totalInPark} previous={compTotal} compact deltaMode={deltaMode} />;
              })()}
            </div>
          </div>
        </div>
      </div>

      {customerTypeSplit && customerTypeSplit.length > 0 && (() => {
        const ctColorMap: Record<string, string> = {
          Tourist: "#3b82f6",
          Thai: "#22c55e",
          Expat: "#f97316",
          Indian: "#eab308",
          Special: "#a855f7",
          "Eat & Play Package": "#a855f7",
          Other: "#6b7280",
        };
        const ctGradientMap: Record<string, string> = {
          Tourist: "from-blue-600 to-indigo-500",
          Thai: "from-emerald-500 to-teal-500",
          Expat: "from-amber-500 to-orange-500",
          Indian: "from-yellow-500 to-amber-500",
          Special: "from-violet-600 to-purple-500",
          "Eat & Play Package": "from-violet-600 to-purple-500",
          Other: "from-gray-500 to-slate-500",
        };

        const ctKidsSum = customerTypeSplit.reduce((s, d) => s + d.kidTickets, 0);
        const ctAdultsSum = customerTypeSplit.reduce((s, d) => s + d.adultTickets, 0);
        const ctTotalGuestsSum = customerTypeSplit.reduce((s, d) => s + (d.totalGuests || d.kidTickets + d.adultTickets), 0);
        const ctRevenueSum = customerTypeSplit.reduce((s, d) => s + d.revenue, 0);

        const headcountKids = data.kidTickets || 0;
        const headcountAdults = data.estimatedTotalAdults || 0;
        const headcountTotal = totalInPark;

        const remainingKids = Math.max(0, headcountKids - ctKidsSum);
        const remainingAdults = Math.max(0, headcountAdults - ctAdultsSum);
        const remainingTotal = remainingKids + remainingAdults;

        const allTypes: CustomerTypeData[] = [...customerTypeSplit];
        if (remainingTotal > 0) {
          const remainingRevenue = Math.max(0, (data.kidRevenue + data.adultRevenue) - ctRevenueSum);
          allTypes.push({
            type: "Other",
            revenue: remainingRevenue,
            orders: 0,
            kidTickets: remainingKids,
            adultTickets: remainingAdults,
            totalGuests: remainingTotal,
          });
        }

        const ctSorted = allTypes.filter(d => d.type !== "Other" && (d.revenue > 0 || (d.totalGuests || 0) > 0)).sort((a, b) => b.revenue - a.revenue);
        const ctTotalRevenue = allTypes.reduce((s, d) => s + d.revenue, 0);
        return (
          <div className="space-y-1.5">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Customer Types</p>
            <div className="grid grid-cols-2 gap-2">
              {ctSorted.map((d) => {
                const revPct = ctTotalRevenue > 0 ? Math.round((d.revenue / ctTotalRevenue) * 100) : 0;
                const grad = ctGradientMap[d.type] || "from-gray-500 to-slate-500";
                const typeColor = ctColorMap[d.type] || "#6b7280";
                const freeAdults = d.freeAdults || 0;
                return (
                  <div
                    key={d.type}
                    className={cn("relative overflow-hidden rounded-lg border border-white/5 neu-card p-2.5", onGraphFilter && "cursor-pointer hover:ring-2 hover:ring-white/20 transition-all")}
                    onClick={() => onGraphFilter?.({ type: "customerType", key: d.type, label: d.type })}
                    data-testid={`customer-type-${d.type.toLowerCase()}`}
                  >
                    <div className={cn("absolute inset-0 bg-gradient-to-br opacity-10 dark:opacity-15", grad)} />
                    <div className="relative space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
                          <span className="text-xs font-semibold">{d.type}</span>
                        </div>
                        <span className="neu-badge px-1.5 py-0.5 text-[10px]">{revPct}%</span>
                      </div>
                      <div className="neu-inset h-2.5 overflow-hidden rounded-full">
                        <div className={cn("h-full bg-gradient-to-r rounded-full", grad)} style={{ width: `${revPct}%` }} />
                      </div>
                      <div className="flex items-end justify-between text-[10px]">
                        <div className="flex flex-col gap-0.5 text-muted-foreground">
                          <span>K: {d.kidTickets} · A: {d.adultTickets}{d.type === "Thai" ? ` paid ${freeAdults} free` : ""}</span>
                        </div>
                        <span className="font-bold metric-value text-xs shrink-0">
                          ฿{d.revenue >= 1000 ? `${(d.revenue / 1000).toFixed(0)}k` : d.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      {compCustomerTypes && (() => {
                        const compCt = compCustomerTypes.find(c => c.type === d.type);
                        const compRev = compCt?.revenue || 0;
                        return <ComparisonDelta current={d.revenue} previous={compRev} format="baht" compact deltaMode={deltaMode} />;
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {(() => {
        const stay = data.stayDistribution || [];
        const totalStay = stay.reduce((s, d) => s + d.count, 0);
        const compStay = compData?.stayDistribution || [];
        const compAvg = compData?.avgStayHours;
        const stayColors: Record<string, string> = {
          "1 Hour": "from-sky-400 to-blue-500",
          "2 Hours": "from-amber-400 to-orange-500",
          "3 Hours": "from-purple-400 to-purple-600",
          "4 Hours": "from-rose-400 to-rose-600",
          "Full Day": "from-emerald-400 to-green-600",
        };
        const stayHexColors: Record<string, string> = {
          "1 Hour": "#38bdf8",
          "2 Hours": "#f59e0b",
          "3 Hours": "#a855f7",
          "4 Hours": "#fb7185",
          "Full Day": "#10b981",
        };
        return (
          <div className="neu-card p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stay Duration</p>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold metric-value">{(data.avgStayHours ?? 0).toFixed(1)}h</span>
                <span className="text-xs text-muted-foreground">avg</span>
                {compAvg != null && compAvg > 0 && (
                  <ComparisonDelta current={data.avgStayHours || 0} previous={compAvg} format="number" compact deltaMode={deltaMode} />
                )}
              </div>
            </div>
            {stay.length > 0 && (
              <div className={`grid gap-2 ${stay.length <= 3 ? "grid-cols-3" : stay.length <= 4 ? "grid-cols-4" : "grid-cols-5"}`}>
                {stay.map((s) => {
                  const pct = totalStay > 0 ? Math.round((s.count / totalStay) * 100) : 0;
                  const grad = stayColors[s.label] || "from-gray-400 to-gray-600";
                  const compBucket = compStay.find((cs: any) => cs.label === s.label);
                  return (
                    <div key={s.label} className="text-center space-y-1.5">
                      <div className="text-[10px] text-muted-foreground font-medium">{s.label}</div>
                      <div className="relative mx-auto w-12 h-12">
                        <svg viewBox="0 0 36 36" className="w-12 h-12 -rotate-90">
                          <circle cx="18" cy="18" r="14" fill="none" className="stroke-muted" strokeWidth="3" />
                          <circle cx="18" cy="18" r="14" fill="none" className="stroke-current"
                            strokeWidth="3" strokeDasharray={`${pct * 0.88} 100`} strokeLinecap="round"
                            style={{ color: stayHexColors[s.label] || "#6b7280" }} />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold metric-value">{s.count}</span>
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground">{pct}%</div>
                      {compBucket && (
                        <ComparisonDelta current={s.count} previous={compBucket.count} format="number" compact deltaMode={deltaMode} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}


    </div>
  );

  if (embedded) return content;

  return (
    <div className="neu-card">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          Headcount
        </div>
      </div>
      <div className="px-4 pb-4">{content}</div>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-2 border-t">
      <button
        className="flex items-center gap-1 w-full text-left text-xs text-muted-foreground font-medium hover:text-foreground transition-colors btn-press"
        onClick={() => setOpen(!open)}
        data-testid={`collapsible-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : "-rotate-90"}`}
        />
        {title}
        {count !== undefined && ` (${count})`}
      </button>
      {open && <div className="space-y-1 mt-1 animate-fade-in">{children}</div>}
    </div>
  );
}

function CollapsibleCard({
  title,
  subtitle,
  icon: Icon,
  defaultOpen = false,
  headerExtras,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: any;
  defaultOpen?: boolean;
  headerExtras?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="neu-card neu-card-interactive">
      <div
        className="p-4 pb-3 select-none transition-colors duration-200"
        onClick={() => setOpen(!open)}
        data-testid={`collapsible-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-2 text-sm sm:text-base font-bold">
          <div className="flex flex-col min-w-0">
            <span className="truncate">{title}</span>
            {subtitle && (
              <span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground privacy-sensitive truncate">
                {subtitle}
              </span>
            )}
          </div>
          {headerExtras && (
            <div
              className="ml-auto flex items-center gap-2 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {headerExtras}
            </div>
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-200",
              !headerExtras && "ml-auto",
              open && "rotate-180",
            )}
          />
        </div>
      </div>
      {open && <div className="px-4 pb-4 animate-fade-in">{children}</div>}
    </div>
  );
}

function SubGroupRow({
  label,
  count,
  countSuffix = "items",
  value,
  defaultOpen = false,
  testId,
  variant = "default",
  children,
}: {
  label: React.ReactNode;
  count?: number;
  countSuffix?: string;
  value: React.ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  variant?: "default" | "subtle";
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = !!children;
  return (
    <div data-testid={testId}>
      <div
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : -1}
        aria-expanded={hasChildren ? open : undefined}
        onClick={() => hasChildren && setOpen(!open)}
        onKeyDown={(e) => {
          if (!hasChildren) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        className={cn(
          "dash-subgroup-row",
          !hasChildren && "cursor-default hover:bg-transparent",
          variant === "subtle" && "py-1 px-1.5",
        )}
      >
        {hasChildren ? (
          <ChevronRight
            className="dash-subgroup-chevron h-3.5 w-3.5"
            data-open={open}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span
          className={cn(
            "flex-1 truncate",
            variant === "subtle" ? "dash-row-sublabel" : "dash-row-label",
          )}
        >
          {label}
        </span>
        {typeof count === "number" && (
          <span className="dash-meta shrink-0">
            {count} {countSuffix}
          </span>
        )}
        <span className="shrink-0 flex items-center gap-2">{value}</span>
      </div>
      {hasChildren && open && (
        <div className="pl-6 pr-1 pt-1 pb-1.5 animate-fade-in">{children}</div>
      )}
    </div>
  );
}

interface BirthdayLinkProposal {
  partyOrderCode: string;
  partyOrderId: string;
  partyCreatedAt: string | null;
  partyPackages: string[];
  partyPackageRevenue: number;
  partyPackageRevenueCash?: number;
  fnbRevenueCash?: number;
  fnbOrderCode: string;
  fnbOrderId: string;
  fnbCreatedAt: string | null;
  fnbRevenue: number;
  lineCount: number;
  totalQty: number;
  fnbRev: number;
  kidSignalQty: number;
  hasJug: boolean;
  hasCake: boolean;
  minutesGap: number | null;
  score: number;
  signals: string[];
}

interface BirthdayLinksData {
  partyPackageRevenue: number;
  bdTickets?: number;
  partyFnbRevenue: number;
  combinedBirthdayTotal: number;
  linkedOrderCount: number;
  partyOrderCount: number;
  unresolvedNoteCodes: Array<{ partyOrderCode: string; missingCode: string }>;
  links?: BirthdayLinkProposal[];
  unmatchedPartyOrders?: Array<{
    partyOrderCode: string;
    partyOrderId: string;
    partyCreatedAt: string | null;
    partyPackages: string[];
    partyPackageRevenue: number;
    partyPackageRevenueCash?: number;
  }>;
}

interface CategoryData {
  revenue: number;
  quantity: number;
  items: Array<{
    name: string;
    category: string;
    revenue: number;
    quantity: number;
    // task-136: when this item belongs to the "Other (Unattributed)" bucket,
    // these optional fields describe the contributing order so the drill-down
    // can render a per-order list and open the order detail modal.
    orderId?: string;
    orderCode?: string;
    reason?: string;
    createdAt?: string | null;
    paymentStatus?: string;
  }>;
  subCategories?: Record<
    string,
    {
      revenue: number;
      quantity: number;
      items: Array<{
        name: string;
        category: string;
        revenue: number;
        quantity: number;
      }>;
    }
  >;
}

const UNATTRIBUTED_BUCKET_NAME = "Other (Unattributed)";

const CHART_COLORS = [
  "#3b82f6",
  "#f97316",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
  "#6b7280",
];

function CategoryDetailPanel({
  catName,
  info,
}: {
  catName: string;
  info: CategoryData;
}) {
  const hasSubCategories = !!(
    info.subCategories && Object.keys(info.subCategories).length > 0
  );

  return (
    <div className="mt-2 neu-inset rounded-xl p-3 animate-fade-in" data-testid={`cat-detail-${catName.toLowerCase().replace(/\s+/g, "-")}`}>
      {hasSubCategories ? (
        <div className="space-y-1">
          {Object.entries(info.subCategories!)
            .filter(([, sub]) => sub.revenue > 0)
            .sort((a, b) => b[1].revenue - a[1].revenue)
            .map(([subName, sub]) => (
              <SubGroupRow
                key={subName}
                label={subName}
                count={sub.items.length}
                value={
                  <span className="dash-row-value">
                    ฿
                    {sub.revenue.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                }
                testId={`subcat-row-${subName.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <ProductList items={sub.items} />
              </SubGroupRow>
            ))}
        </div>
      ) : (
        info.items && info.items.length > 0 && <ProductList items={info.items} />
      )}
    </div>
  );
}

// task-136: drill-down for the "Other (Unattributed)" bucket on Revenue by
// Category. Lists each contributing order (order_code, status, time, amount
// counted, reason) and opens a single-order detail dialog when clicked.
function UnattributedDrillDownPanel({
  items,
  totalRevenue,
}: {
  items: CategoryData["items"];
  totalRevenue: number;
}) {
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [openOrderCode, setOpenOrderCode] = useState<string | null>(null);
  const fmtTime = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString("en-GB", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };
  const ordered = [...items].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  return (
    <div
      className="mt-2 neu-inset rounded-xl p-3 space-y-2 animate-fade-in"
      data-testid="unattributed-drilldown-panel"
    >
      <p className="text-[11px] text-muted-foreground">
        Orders that paid but couldn't be auto-attributed to a category.
        Partially-paid orders with line items are already split into their
        real categories — only the residual lists here.
      </p>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          No order-level residuals (likely rounding only — ฿
          {Math.round(totalRevenue).toLocaleString()}).
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="list-unattributed-orders">
          {ordered.map((it, i) => {
            const code = it.orderCode || it.name;
            const clickable = !!it.orderId;
            const onClick = () => {
              if (!clickable) return;
              setOpenOrderId(it.orderId!);
              setOpenOrderCode(code);
            };
            return (
              <div
                key={`${code}-${i}`}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable ? `Show details for order ${code}` : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onClick();
                }}
                onKeyDown={(e) => {
                  if (clickable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onClick();
                  }
                }}
                className={cn(
                  "flex items-baseline gap-3 p-2 rounded-lg bg-foreground/5 transition-colors text-xs",
                  clickable &&
                    "cursor-pointer hover:bg-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                data-testid={`row-unattributed-${code}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{code}</span>
                    {it.paymentStatus && it.paymentStatus !== "—" && (
                      <span
                        className="px-1.5 py-0 rounded text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        data-testid={`badge-status-${code}`}
                      >
                        {it.paymentStatus}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {fmtTime(it.createdAt)}
                    {it.reason ? ` · ${it.reason}` : ""}
                  </div>
                </div>
                <span
                  className="dash-row-value-emph shrink-0 tabular-nums"
                  data-testid={`text-unattributed-amount-${code}`}
                >
                  ฿{Math.round(it.revenue).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <UnattributedOrderDialog
        orderId={openOrderId}
        orderCode={openOrderCode}
        onClose={() => {
          setOpenOrderId(null);
          setOpenOrderCode(null);
        }}
      />
    </div>
  );
}

function UnattributedOrderDialog({
  orderId,
  orderCode,
  onClose,
}: {
  orderId: string | null;
  orderCode: string | null;
  onClose: () => void;
}) {
  const open = orderId !== null;
  const query = useQuery<FuntopiaOrderDetail>({
    queryKey: ["/api/funtopia/order", orderId],
    enabled: open && !!orderId,
    staleTime: 60_000,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="dialog-unattributed-order"
      >
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-2">
            <span>
              Order{" "}
              <span className="text-muted-foreground font-normal">
                {orderCode}
              </span>
            </span>
            {query.data && (
              <span className="dash-row-value-emph tabular-nums text-base">
                ฿{Math.round(query.data.order.totalAmount).toLocaleString()}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        {query.isLoading && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}
        {query.isError && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            Could not load order details.
          </div>
        )}
        {query.data && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <DetailRow label="Customer" value={query.data.order.customerName} />
              <DetailRow label="Phone" value={query.data.order.customerPhone} />
              <DetailRow label="Email" value={query.data.order.customerEmail} />
              <DetailRow label="Created" value={query.data.order.createdAt} />
              <DetailRow label="Channel" value={query.data.order.channel} />
              <DetailRow label="Source" value={query.data.order.source} />
            </div>
            {query.data.order.note && (
              <div>
                <span className="text-muted-foreground">Note: </span>
                <span className="whitespace-pre-wrap">{query.data.order.note}</span>
              </div>
            )}
            {query.data.items.length > 0 && (
              <div className="neu-inset rounded-md p-2 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Line items
                </div>
                {query.data.items.map((it, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2"
                    data-testid={`row-detail-item-${i}`}
                  >
                    <span className="truncate">
                      {it.productName}
                      <span className="text-muted-foreground"> × {it.quantity}</span>
                    </span>
                    <span className="tabular-nums shrink-0">
                      ฿{Math.round(it.subtotal).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {query.data.payments.length > 0 && (
              <div className="neu-inset rounded-md p-2 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Payments
                </div>
                {query.data.payments.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2"
                    data-testid={`row-detail-payment-${i}`}
                  >
                    <span className="truncate">
                      {p.paymentName || p.payMethod || "Payment"}
                    </span>
                    <span className="tabular-nums shrink-0">
                      ฿{Math.round(p.payAmount).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CategoryRevenueBreakdown({
  data,
  voucherMode = "tickets",
  voucherAmount = 0,
  bdShift = null,
  onGraphFilter,
  compData,
  compLabel,
  compVoucherAmount = 0,
  deltaMode = "pct",
  birthdayLinks,
  branchKey = "floresta",
  birthdayMovedAmount: birthdayMovedAmountFromServer = 0,
}: {
  data: Record<string, CategoryData>;
  voucherMode?: "tickets" | "fnb";
  voucherAmount?: number;
  bdShift?: { amount: number; from: string; to: string } | null;
  onGraphFilter?: (filter: PerfGraphFilter) => void;
  compData?: Record<string, CategoryData> | null;
  compLabel?: string;
  compVoucherAmount?: number;
  deltaMode?: CompDeltaMode;
  birthdayLinks?: BirthdayLinksData | null;
  branchKey?: string;
  birthdayMovedAmount?: number;
}) {
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  // Server-backed birthday allocation preference (per branch).
  // We always read/write the floresta value because Chalong has no birthday
  // F&B and the chip only shows up when partyFnbRevenue > 0 (Pisell only).
  const allocationBranch = "floresta";
  const allocationQueryKey = ["/api/funtopia/preferences/birthday-allocation", allocationBranch] as const;
  const { data: allocationPref } = useQuery<{ branch: string; allocation: "fnb" | "events" }>({
    queryKey: allocationQueryKey,
    queryFn: () =>
      fetch(`/api/funtopia/preferences/birthday-allocation?branch=${allocationBranch}`).then((r) =>
        r.json(),
      ),
    staleTime: 60_000,
  });
  const allocateBirthdayToEvents = allocationPref?.allocation === "events";
  const allocationMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const allocation = next ? "events" : "fnb";
      return apiRequest("PUT", "/api/funtopia/preferences/birthday-allocation", {
        branch: allocationBranch,
        allocation,
      }).then((r) => r.json());
    },
    onSuccess: () => {
      // Re-fetch the preference and any data view that depends on it.
      queryClient.invalidateQueries({ queryKey: allocationQueryKey });
      queryClient.invalidateQueries({ queryKey: ["/api/branch/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/branch/range"] });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/range"] });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/chart-builder"] });
    },
  });
  const handleAllocatedChange = (v: boolean) => {
    allocationMutation.mutate(v);
  };

  const applyVoucherAdjustment = (src: Record<string, CategoryData>, amt: number): Record<string, CategoryData> => {
    if (amt <= 0 || voucherMode === "tickets") return src;
    const adjusted = { ...src };
    const ticketsKey = "Tickets & Packages";
    const ticketsEntry = adjusted[ticketsKey];
    if (!ticketsEntry || ticketsEntry.revenue <= 0 || !adjusted["F&B"]) return src;
    const voucherToMove = Math.min(amt, ticketsEntry.revenue);
    adjusted[ticketsKey] = { ...ticketsEntry, revenue: ticketsEntry.revenue - voucherToMove };
    adjusted["F&B"] = { ...adjusted["F&B"], revenue: adjusted["F&B"].revenue + voucherToMove };
    return adjusted;
  };

  // Transient BD pill toggle. The shift plan (source/destination/amount) is
  // computed once at the dashboard level so the category card and the
  // performance chart move revenue identically; we just apply it here.
  // Independent of the persisted "Count under Events / Birthdays" preference,
  // though the plan's source key depends on it (server has already moved
  // partyFnbRevenue out of F&B in events mode, so we read from there instead).
  const applyBirthdayAdjustment = (src: Record<string, CategoryData>): Record<string, CategoryData> => {
    if (!bdShift || bdShift.amount <= 0 || bdShift.from === bdShift.to) return src;
    const fromEntry = src[bdShift.from];
    const toEntry = src[bdShift.to];
    if (!fromEntry || fromEntry.revenue <= 0 || !toEntry) return src;
    const toMove = Math.min(bdShift.amount, fromEntry.revenue);
    return {
      ...src,
      [bdShift.from]: { ...fromEntry, revenue: fromEntry.revenue - toMove },
      [bdShift.to]: { ...toEntry, revenue: toEntry.revenue + toMove },
    };
  };

  const voucherAdjustedData = useMemo(
    () => applyVoucherAdjustment(data, voucherAmount),
    [data, voucherMode, voucherAmount],
  );

  // Server has already moved the amount when allocation === "events";
  // we just surface the moved value so the BirthdayLinksPanel can recover the
  // pure "Events" subtotal for display (info.revenue - birthdayMovedAmount).
  const birthdayMovedAmount = allocateBirthdayToEvents ? birthdayMovedAmountFromServer || 0 : 0;
  const adjustedData = useMemo(
    () => applyBirthdayAdjustment(voucherAdjustedData),
    [voucherAdjustedData, bdShift],
  );
  const adjustedCompData = useMemo(
    () => (compData ? applyVoucherAdjustment(compData, compVoucherAmount) : null),
    [compData, voucherMode, compVoucherAmount],
  );

  const FNB_SUBCATEGORIES = new Set(["Food", "Drinks"]);
  const ALWAYS_SHOW_CATEGORIES = new Set(["Tickets & Packages", "F&B", "Extras", "Events / Birthdays", "Nanny & Drop-off", "Merchandise", "Workshop"]);
  // Hide "Other (Unattributed)" from the Revenue by Category list: partially-
  // paid orders are already proportionally split into their real categories
  // (task-136 v25), so the residual bucket would just double-show money that
  // is already accounted for elsewhere.
  const allCategoryKeys = new Set([
    ...Object.keys(adjustedData).filter(k => k !== UNATTRIBUTED_BUCKET_NAME && !FNB_SUBCATEGORIES.has(k) && ((adjustedData[k]?.revenue || 0) > 0 || ALWAYS_SHOW_CATEGORIES.has(k))),
    ...(adjustedCompData ? Object.keys(adjustedCompData).filter(k => k !== UNATTRIBUTED_BUCKET_NAME && !FNB_SUBCATEGORIES.has(k) && ((adjustedCompData[k]?.revenue || 0) > 0 || ALWAYS_SHOW_CATEGORIES.has(k))) : []),
  ]);
  const emptyCat: CategoryData = { revenue: 0, quantity: 0, items: [] };
  const entries = Array.from(allCategoryKeys)
    .map(k => [k, adjustedData[k] || emptyCat] as [string, CategoryData])
    .sort((a, b) => b[1].revenue - a[1].revenue);
  const total = entries.reduce((s, [, v]) => s + v.revenue, 0);

  if (!entries.length)
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No category data
      </p>
    );

  return (
    <div className="space-y-3">
      {entries.map(([name, info]) => {
        const cfg = CATEGORY_CONFIG[name] || {
          icon: Package,
          color: "text-slate-600 dark:text-slate-500",
          bgColor: "bg-slate-50 dark:bg-gray-950/20",
        };
        const CatIcon = cfg.icon;
        const pct = total > 0 ? Math.round((info.revenue / total) * 100) : 0;
        const gradient =
          CATEGORY_GRADIENTS[name] || "from-gray-500 to-slate-400";
        const isSelected = selectedCat === name;

        const itemCount = data[name]?.items?.length || 0;
        const subCatCount = data[name]?.subCategories ? Object.keys(data[name].subCategories).length : 0;
        // task-136: the Unattributed bucket has a drill-down even when items[]
        // is empty (rounding-only days), so the chevron + click affordance
        // always renders for that row.
        const isUnattributed = name === UNATTRIBUTED_BUCKET_NAME;
        const hasDetail = itemCount > 0 || subCatCount > 0 || isUnattributed;
        const totalUnits = data[name]?.items?.reduce((s, it) => s + (it.quantity || 0), 0) || 0;

        const handleToggle = () => {
          setSelectedCat(isSelected ? null : name);
          if (onGraphFilter) {
            onGraphFilter(isSelected ? null : { type: "category", key: name, label: getCategoryDisplayName(name) });
          }
        };

        return (
          <div key={name} data-testid={`cat-row-${name.toLowerCase().replace(/\s+/g, "-")}`}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isSelected}
              onClick={handleToggle}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleToggle();
                }
              }}
              className="cursor-pointer rounded-lg px-1 py-1 -mx-1 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <div className="flex items-center gap-2.5 mb-1.5">
                {hasDetail ? (
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform",
                      isSelected && "rotate-90",
                    )}
                  />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="flex-1 dash-row-label truncate">
                  {getCategoryDisplayName(name)}
                </span>
                <span className="dash-meta neu-badge px-2 py-0.5">
                  {pct}%
                </span>
                <AnimatedBaht
                  value={Math.round(info.revenue)}
                  className="dash-row-value-emph shrink-0"
                />
                {adjustedCompData && adjustedCompData[name] && (
                  <ComparisonDelta current={info.revenue} previous={adjustedCompData[name].revenue} format="baht" compact deltaMode={deltaMode} />
                )}
              </div>
              <div className="neu-inset h-4 overflow-hidden">
                <div
                  className={`h-full bg-gradient-to-r ${gradient} neu-progress-fill`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
            {isSelected && name === "Events / Birthdays" && birthdayLinks && (birthdayLinks.partyOrderCount > 0 || birthdayLinks.partyFnbRevenue > 0 || birthdayLinks.unresolvedNoteCodes.length > 0) && (
              <BirthdayLinksPanel links={birthdayLinks} />
            )}
            {isSelected && isUnattributed && (
              <UnattributedDrillDownPanel
                items={data[name]?.items || []}
                totalRevenue={info.revenue}
              />
            )}
            {isSelected && !isUnattributed && data[name] && hasDetail && (
              name === "Events / Birthdays" ? (
                <CollapsibleItemizedPanel catName={name} info={data[name]} />
              ) : (
                <CategoryDetailPanel
                  catName={name}
                  info={data[name]}
                />
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

function BirthdayLinksPanel({
  links,
}: {
  links: BirthdayLinksData;
}) {
  type PartyCard = {
    id: string;
    partyOrderCode: string;
    partyPackages: string[];
    combined: number;
    packageRev: number;
    link: BirthdayLinkProposal | null;
  };

  const cards: PartyCard[] = [];
  // v23: dashboard card values are CASH-BASIS so the sum of cards matches
  // the Events / Birthdays bar (also cash-basis). Server emits
  // partyPackageRevenueCash / fnbRevenueCash; fall back to the booking-value
  // fields for old cached days that haven't been re-summarised yet.
  if (links.links) {
    for (const l of links.links) {
      const pkg = l.partyPackageRevenueCash ?? l.partyPackageRevenue ?? 0;
      const fnb = l.fnbRevenueCash ?? l.fnbRevenue ?? 0;
      cards.push({
        id: l.partyOrderId,
        partyOrderCode: l.partyOrderCode,
        partyPackages: l.partyPackages,
        packageRev: pkg,
        combined: pkg + fnb,
        link: l,
      });
    }
  }
  if (links.unmatchedPartyOrders) {
    for (const u of links.unmatchedPartyOrders) {
      const pkg = u.partyPackageRevenueCash ?? u.partyPackageRevenue ?? 0;
      cards.push({
        id: u.partyOrderId,
        partyOrderCode: u.partyOrderCode,
        partyPackages: u.partyPackages,
        packageRev: pkg,
        combined: pkg,
        link: null,
      });
    }
  }
  cards.sort((a, b) => b.combined - a.combined);

  const [openCard, setOpenCard] = useState<PartyCard | null>(null);

  return (
    <div
      className="mt-2 neu-inset rounded-xl p-3 animate-fade-in"
      data-testid="birthday-links-panel"
    >
      {cards.length > 0 && (
        <div className="space-y-2" data-testid="list-birthday-cards">
          {cards.map((c) => {
            const onKey = (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpenCard(c);
              }
            };
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-label={`Show details for birthday order ${c.partyOrderCode}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenCard(c);
                }}
                onKeyDown={onKey}
                className="flex items-baseline justify-between gap-3 cursor-pointer select-none p-2 rounded-lg bg-foreground/5 hover:bg-foreground/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`card-birthday-${c.partyOrderCode}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[12px] font-medium truncate">
                    {c.partyOrderCode}{" "}
                    <span className="text-muted-foreground font-normal">
                      ({c.partyPackages[0] || "Party"})
                    </span>
                  </span>
                </div>
                <span
                  className="dash-row-value-emph shrink-0"
                  data-testid={`text-birthday-card-value-${c.partyOrderCode}`}
                >
                  ฿{Math.round(c.combined).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {links.unresolvedNoteCodes.length > 0 && (
        <div
          className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="text-birthday-unresolved"
        >
          ⚠ {links.unresolvedNoteCodes.length} unresolved note {links.unresolvedNoteCodes.length === 1 ? "code" : "codes"}:
          {" "}
          {links.unresolvedNoteCodes.slice(0, 5).map((u) => u.missingCode).join(", ")}
          {links.unresolvedNoteCodes.length > 5 ? "…" : ""}
        </div>
      )}
      <BirthdayOrderDialog
        card={openCard}
        onClose={() => setOpenCard(null)}
      />
    </div>
  );
}

interface FuntopiaOrderDetail {
  order: {
    orderId: string;
    orderCode: string | null;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    note: string | null;
    createdAt: string | null;
    source: string | null;
    channel: string | null;
    totalAmount: number;
    orderDate: string | null;
  };
  items: Array<{
    productName: string | null;
    productCategory: string | null;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    discount: number;
  }>;
  payments: Array<{
    payMethod: string | null;
    paymentName: string | null;
    payAmount: number;
    paymentAt: string | null;
  }>;
}

function BirthdayOrderDialog({
  card,
  onClose,
}: {
  card: {
    id: string;
    partyOrderCode: string;
    partyPackages: string[];
    combined: number;
    packageRev: number;
    link: BirthdayLinkProposal | null;
  } | null;
  onClose: () => void;
}) {
  const open = card !== null;
  const partyId = card?.id ?? null;
  const fnbId = card?.link?.fnbOrderId ?? null;

  const partyQuery = useQuery<FuntopiaOrderDetail>({
    queryKey: ["/api/funtopia/order", partyId],
    enabled: open && !!partyId,
    staleTime: 60_000,
  });
  const fnbQuery = useQuery<FuntopiaOrderDetail>({
    queryKey: ["/api/funtopia/order", fnbId],
    enabled: open && !!fnbId,
    staleTime: 60_000,
  });

  const renderSection = (
    title: string,
    code: string | null | undefined,
    query: ReturnType<typeof useQuery<FuntopiaOrderDetail>>,
  ) => {
    if (!code) return null;
    return (
      <div
        className="neu-inset rounded-xl p-3 space-y-2"
        data-testid={`order-detail-section-${code}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-semibold text-sm">
            {title}
            <span className="text-muted-foreground font-normal ml-2">
              {code}
            </span>
          </div>
          {query.data && (
            <div className="dash-row-value-emph tabular-nums">
              ฿{Math.round(query.data.order.totalAmount).toLocaleString()}
            </div>
          )}
        </div>
        {query.isLoading && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}
        {query.isError && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            Could not load order details.
          </div>
        )}
        {query.data && (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <DetailRow label="Customer" value={query.data.order.customerName} />
              <DetailRow label="Phone" value={query.data.order.customerPhone} />
              <DetailRow label="Email" value={query.data.order.customerEmail} />
              <DetailRow label="Created" value={query.data.order.createdAt} />
              <DetailRow label="Channel" value={query.data.order.channel} />
              <DetailRow label="Source" value={query.data.order.source} />
            </div>
            {query.data.order.note && (
              <div className="text-xs">
                <span className="text-muted-foreground">Note: </span>
                <span className="whitespace-pre-wrap">{query.data.order.note}</span>
              </div>
            )}
            {query.data.items.length > 0 && (
              <div className="mt-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Items
                </div>
                <div className="space-y-1">
                  {query.data.items.map((it, i) => (
                    <div
                      key={`${code}-item-${i}`}
                      className="flex items-baseline justify-between gap-2 text-xs"
                      data-testid={`order-item-${code}-${i}`}
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground mr-1">
                          ×{it.quantity}
                        </span>
                        {it.productName || "—"}
                        {it.productCategory && (
                          <span className="text-muted-foreground ml-1">
                            ({it.productCategory})
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums shrink-0">
                        ฿{Math.round(it.subtotal).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {query.data.payments.length > 0 && (
              <div className="mt-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Payments
                </div>
                <div className="space-y-1">
                  {query.data.payments.map((p, i) => (
                    <div
                      key={`${code}-pay-${i}`}
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="truncate">
                        {p.paymentName || p.payMethod || "—"}
                      </span>
                      <span className="tabular-nums shrink-0">
                        ฿{Math.round(p.payAmount).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="dialog-birthday-order"
      >
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-2">
            <span>
              Birthday order{" "}
              <span className="text-muted-foreground font-normal">
                {card?.partyOrderCode}
              </span>
            </span>
            {card && (
              <span className="dash-row-value-emph tabular-nums text-base">
                ฿{Math.round(card.combined).toLocaleString()}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {card?.partyPackages && card.partyPackages.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {card.partyPackages.join(" · ")}
            </div>
          )}
          {renderSection("Party package", card?.partyOrderCode, partyQuery)}
          {card?.link
            ? renderSection("Linked F&B", card.link.fnbOrderCode, fnbQuery)
            : card && (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  No F&amp;B order matched to this party.
                </div>
              )}
          {card?.link && (
            <div className="text-xs text-muted-foreground">
              <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] mr-1.5">
                match score {card.link.score}
              </span>
              {card.link.signals.join(" · ")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="truncate">{value || "—"}</span>
    </div>
  );
}

function CollapsibleItemizedPanel({
  catName,
  info,
}: {
  catName: string;
  info: CategoryData;
}) {
  const [open, setOpen] = useState(false);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  };
  return (
    <div
      className="mt-2 neu-inset rounded-xl p-3 animate-fade-in"
      data-testid={`itemized-panel-${catName.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={`itemized-panel-content-${catName.toLowerCase().replace(/\s+/g, "-")}`}
        aria-label={open ? "Hide itemized breakdown" : "Show itemized breakdown"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={onKey}
        className="flex items-center justify-between gap-2 cursor-pointer select-none rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`btn-itemized-toggle-${catName.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
          <span className="text-xs text-muted-foreground">
            Itemized breakdown
          </span>
        </div>
      </div>
      {open && (
        <div
          id={`itemized-panel-content-${catName.toLowerCase().replace(/\s+/g, "-")}`}
          className="mt-2"
        >
          <CategoryDetailPanel catName={catName} info={info} />
        </div>
      )}
    </div>
  );
}

interface SourceVariantEntry {
  name: string;
  orders: number;
  revenue: number;
  discount: number;
}

interface SourceBreakdownEntry {
  source: string;
  orders: number;
  revenue: number;
  discount: number;
  variants: SourceVariantEntry[];
}

const SOURCE_GRADIENTS: Record<string, string> = {
  Birthdays: "from-pink-500 to-fuchsia-400",
  Airport: "from-sky-500 to-cyan-400",
  School: "from-emerald-500 to-green-400",
  Mascot: "from-fuchsia-500 to-pink-400",
  "Sales Booth": "from-amber-500 to-orange-400",
  "Sales-booth": "from-amber-500 to-orange-400",
  "Tops Daily": "from-red-500 to-rose-400",
  "Department Store": "from-indigo-500 to-blue-400",
  "Review Rewards": "from-yellow-500 to-amber-400",
  "Staff Rewards": "from-purple-500 to-indigo-400",
  "Free Coffee": "from-amber-700 to-orange-500",
  "Free Ice Cream": "from-rose-300 to-pink-200",
  Open: "from-yellow-500 to-amber-400",
  Comp: "from-violet-500 to-purple-400",
  Credit: "from-teal-500 to-cyan-400",
  Camp: "from-lime-500 to-green-400",
  Other: "from-emerald-700 to-teal-600",
  "Walk-in": "from-blue-600 to-blue-500",
  Unattributed: "from-blue-600 to-blue-500",
};

const UNATTRIBUTED_SOURCES = new Set(["Walk-in", "Unattributed"]);
const FNB_PERK_SOURCES = new Set(["Free Coffee", "Free Ice Cream"]);

function getSourceGradient(source: string): string {
  if (SOURCE_GRADIENTS[source]) return SOURCE_GRADIENTS[source];
  if (/credit/i.test(source)) return SOURCE_GRADIENTS["Credit"];
  return "from-emerald-700 to-teal-600";
}

interface VoucherMappingItem {
  face_value: number;
  times_used: number;
  total_value: number;
  first_seen: string | null;
  last_seen: string | null;
  channels: string[];
  ignored: boolean;
  note: string;
  mapped: boolean;
}

const STANDARD_CHANNELS = [
  "Airport",
  "School",
  "Mascot",
  "Sales-booth",
  "Tops Daily",
  "Department Store",
  "Review Rewards",
  "Staff Rewards",
  "Indian Package",
];

function arraysEqualIgnoreOrder(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.every((v, i) => v === bb[i]);
}

// task-139 (v26): Floresta product registry panel — read-only table of every
// Pisell SKU we've seen with its resolved Revenue Category and how the
// decision was made (Pisell category / keyword rescue / manual override /
// unclassified). "Needs review" filter floats unclassified SKUs to the top
// so staff can spot a brand-new "Open Item / Misc" charge that we don't yet
// know how to bucket. Override is the safety valve — most rows should never
// need it.
interface ProductRegistryItem {
  productKey: string;
  productId: string | null;
  variantId: string | null;
  latestName: string;
  latestCategoryTitle: string | null;
  revenueCategory: string;
  fnbSubCategory: "Food" | "Drinks" | null;
  decisionSource: "pisell_category" | "keyword_rescue" | "manual_override" | "unclassified";
  manualOverride: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

const PRODUCT_REGISTRY_CATEGORIES: { value: string; label: string }[] = [
  { value: "Tickets & Packages", label: "Tickets & Packages" },
  { value: "F&B", label: "F&B" },
  { value: "Events / Birthdays", label: "Events / Birthdays" },
  { value: "Nanny & Drop-off", label: "Nanny & Drop-off" },
  { value: "Merchandise", label: "Merchandise" },
  { value: "Workshop", label: "Workshop" },
  { value: "Extras", label: "Extras" },
];

function DecisionSourceBadge({ source }: { source: ProductRegistryItem["decisionSource"] }) {
  const config: Record<ProductRegistryItem["decisionSource"], { label: string; className: string }> = {
    pisell_category: { label: "Pisell category", className: "border-blue-500/30 text-blue-700 dark:text-blue-300" },
    keyword_rescue: { label: "Keyword rescue", className: "border-amber-500/30 text-amber-700 dark:text-amber-300" },
    manual_override: { label: "Manual override", className: "border-purple-500/30 text-purple-700 dark:text-purple-300" },
    unclassified: { label: "Needs review", className: "border-red-500/40 text-red-700 dark:text-red-300" },
  };
  const c = config[source];
  return (
    <Badge variant="outline" className={`text-[10px] ${c.className}`} data-testid={`badge-decision-${source}`}>
      {c.label}
    </Badge>
  );
}

function ProductRegistryRow({ item, onChanged }: { item: ProductRegistryItem; onChanged: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [revCat, setRevCat] = useState<string>(item.revenueCategory);
  const [fnbSub, setFnbSub] = useState<"Food" | "Drinks">(item.fnbSubCategory || "Food");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("POST", `/api/funtopia/product-registry/${encodeURIComponent(item.productKey)}/override`, {
        revenueCategory: revCat,
        fnbSubCategory: revCat === "F&B" ? fnbSub : null,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/product-registry"] });
      toast({ title: "Override saved", description: `${item.latestName} → ${revCat}` });
      setEditing(false);
      onChanged();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await apiRequest("DELETE", `/api/funtopia/product-registry/${encodeURIComponent(item.productKey)}/override`);
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/product-registry"] });
      toast({ title: "Override cleared", description: `${item.latestName} re-bootstrapped` });
      setEditing(false);
      onChanged();
    } catch (err: any) {
      toast({ title: "Clear failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="py-3 border-b border-border/40 last:border-b-0 space-y-2"
      data-testid={`row-product-registry-${item.productKey}`}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <p className="font-medium text-sm" data-testid={`text-product-name-${item.productKey}`}>{item.latestName}</p>
          <p className="text-xs text-muted-foreground">
            Pisell category: {item.latestCategoryTitle || "—"}
            {item.productId ? ` · ID ${item.productId}${item.variantId ? `/${item.variantId}` : ""}` : " · (no product_id)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs" data-testid={`badge-revcat-${item.productKey}`}>
            {item.revenueCategory}{item.fnbSubCategory ? ` · ${item.fnbSubCategory}` : ""}
          </Badge>
          <DecisionSourceBadge source={item.decisionSource} />
          {!editing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setEditing(true)}
              data-testid={`button-override-${item.productKey}`}
            >
              Override
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <div className="flex items-center gap-2 flex-wrap pl-1">
          <select
            value={revCat}
            onChange={(e) => setRevCat(e.target.value)}
            className="text-xs rounded-md border border-input bg-background px-2 py-1"
            data-testid={`select-revcat-${item.productKey}`}
          >
            {PRODUCT_REGISTRY_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {revCat === "F&B" && (
            <select
              value={fnbSub}
              onChange={(e) => setFnbSub(e.target.value as "Food" | "Drinks")}
              className="text-xs rounded-md border border-input bg-background px-2 py-1"
              data-testid={`select-fnbsub-${item.productKey}`}
            >
              <option value="Food">Food</option>
              <option value="Drinks">Drinks</option>
            </select>
          )}
          <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={handleSave} data-testid={`button-save-override-${item.productKey}`}>
            Save
          </Button>
          {item.manualOverride && (
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={saving} onClick={handleClear} data-testid={`button-clear-override-${item.productKey}`}>
              Clear override
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditing(false); setRevCat(item.revenueCategory); }}>
            Cancel
          </Button>
          <p className="text-[11px] text-muted-foreground basis-full">
            Note: override applies on next re-sync of affected dates.
          </p>
        </div>
      )}
    </div>
  );
}

function FlorestaProductRegistryPanel() {
  const [search, setSearch] = useState("");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const { data, isLoading, refetch } = useQuery<{ items: ProductRegistryItem[]; counts: Record<string, number>; total: number }>({
    queryKey: ["/api/funtopia/product-registry"],
  });

  const items = data?.items || [];
  const counts = data?.counts || {};
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (needsReviewOnly && it.decisionSource !== "unclassified") return false;
      if (!q) return true;
      return (
        it.latestName.toLowerCase().includes(q) ||
        (it.latestCategoryTitle || "").toLowerCase().includes(q) ||
        (it.productId || "").toLowerCase().includes(q) ||
        it.revenueCategory.toLowerCase().includes(q)
      );
    });
  }, [items, search, needsReviewOnly]);

  const visible = filtered.slice(0, 200);

  return (
    <div className="neu-card" data-testid="panel-product-registry">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <Package className="h-4 w-4 text-orange-500" />
          Floresta — Products (Pisell)
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Each Pisell SKU's Revenue Category is locked to its <code>product_id</code> (task-139).
          Renaming a SKU or staff using an off-whitelist category won't drift the classification.
          Override is a safety valve and applies on the next re-sync of affected dates.
        </p>
      </div>
      <div className="px-4 pb-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-muted-foreground">Total: <span className="font-semibold text-foreground" data-testid="text-product-registry-total">{data?.total ?? 0}</span></span>
          <span className="text-muted-foreground">Pisell: <span className="font-semibold text-foreground">{counts.pisell_category || 0}</span></span>
          <span className="text-muted-foreground">Keyword: <span className="font-semibold text-foreground">{counts.keyword_rescue || 0}</span></span>
          <span className="text-muted-foreground">Override: <span className="font-semibold text-foreground">{counts.manual_override || 0}</span></span>
          <span className="text-muted-foreground">Needs review: <span className={`font-semibold ${(counts.unclassified || 0) > 0 ? "text-red-600" : "text-foreground"}`} data-testid="text-product-registry-needs-review">{counts.unclassified || 0}</span></span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, category, or product ID…"
            className="flex-1 min-w-[200px] text-sm rounded-md border border-input bg-background px-3 py-1.5"
            data-testid="input-product-registry-search"
          />
          <Button
            variant={needsReviewOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setNeedsReviewOnly((v) => !v)}
            data-testid="button-toggle-needs-review"
          >
            Needs review only
          </Button>
          <Button variant="ghost" size="sm" onClick={() => refetch()} data-testid="button-refresh-product-registry">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="border-t border-border/40">
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading product registry…</div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No products match.</div>
          ) : (
            <>
              {visible.map((it) => (
                <ProductRegistryRow key={it.productKey} item={it} onChanged={() => refetch()} />
              ))}
              {filtered.length > visible.length && (
                <p className="pt-3 text-xs text-muted-foreground text-center">
                  Showing first {visible.length} of {filtered.length} matches — refine search to see more.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VoucherMappingRow({ item, onSaved }: { item: VoucherMappingItem; onSaved: () => void }) {
  const { toast } = useToast();
  const [selectedChannels, setSelectedChannels] = useState<string[]>(item.channels || []);
  const [customChannel, setCustomChannel] = useState<string>("");
  const [ignored, setIgnored] = useState<boolean>(item.ignored);
  const [note, setNote] = useState<string>(item.note || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty =
    (ignored !== item.ignored) ||
    (note !== (item.note || "")) ||
    !arraysEqualIgnoreOrder(selectedChannels, item.channels || []);

  const canSave = dirty && (ignored || selectedChannels.length > 0) && !saving;

  const toggleChannel = (ch: string) => {
    setSelectedChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  };

  const addCustomChannel = () => {
    const v = customChannel.trim();
    if (!v) return;
    if (!selectedChannels.includes(v)) {
      setSelectedChannels((prev) => [...prev, v]);
    }
    setCustomChannel("");
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/funtopia/voucher-mappings", {
        face_value: item.face_value,
        channels: ignored ? [] : selectedChannels,
        ignored,
        note: note || null,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/voucher-mappings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/summary"] });
      const desc = ignored
        ? "Ignored"
        : selectedChannels.length > 1
          ? `${selectedChannels.join(" + ")} (split ${selectedChannels.length} ways)`
          : selectedChannels[0];
      toast({ title: "Saved", description: `฿${item.face_value.toFixed(2)} → ${desc}` });
      onSaved();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item.mapped || deleting) return;
    setDeleting(true);
    try {
      await apiRequest("DELETE", `/api/funtopia/voucher-mappings/${item.face_value}`);
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia/voucher-mappings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/summary"] });
      toast({ title: "Removed", description: `Mapping for ฿${item.face_value.toFixed(2)} cleared` });
      onSaved();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const usageLabel = item.times_used > 0
    ? `${item.times_used.toLocaleString()}× · ฿${item.total_value.toLocaleString(undefined, { maximumFractionDigits: 0 })} total`
    : "No usage in last 180d";

  const customsList = selectedChannels.filter((c) => !STANDARD_CHANNELS.includes(c));

  return (
    <div
      className="py-3 border-b border-border/40 last:border-b-0 space-y-2"
      data-testid={`row-voucher-mapping-${item.face_value}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-base min-w-[80px]" data-testid={`text-voucher-face-value-${item.face_value}`}>
          ฿{item.face_value.toFixed(2)}
        </span>
        <span className="text-xs text-muted-foreground">{usageLabel}</span>
        {item.mapped && (
          <Badge
            variant="outline"
            className={`text-[10px] px-1.5 py-0 ${
              ignored
                ? "border-amber-500/40 text-amber-500"
                : selectedChannels.length === 0
                  ? "border-sky-500/40 text-sky-500"
                  : "border-emerald-500/40 text-emerald-500"
            }`}
          >
            {ignored
              ? "Ignored"
              : selectedChannels.length === 0
                ? "Pick a channel"
                : selectedChannels.length > 1
                  ? `Split ${selectedChannels.length}-ways`
                  : "Mapped"}
          </Badge>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none ml-auto">
          <input
            type="checkbox"
            checked={ignored}
            onChange={(e) => setIgnored(e.target.checked)}
            disabled={saving}
            className="h-4 w-4 rounded border-border accent-amber-500"
            data-testid={`checkbox-voucher-ignored-${item.face_value}`}
            aria-label="Mark as ignored (e.g. F&B voucher)"
          />
          Ignore (not a campaign)
        </label>
      </div>

      {!ignored && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {STANDARD_CHANNELS.map((ch) => {
            const active = selectedChannels.includes(ch);
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                disabled={saving}
                className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                  active
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                    : "bg-background border-border text-muted-foreground hover:border-emerald-500/40"
                }`}
                data-testid={`btn-voucher-channel-${item.face_value}-${ch}`}
              >
                {active ? "✓ " : ""}{ch}
              </button>
            );
          })}
          {customsList.map((ch) => (
            <span
              key={ch}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
            >
              ✓ {ch}
              <button
                type="button"
                onClick={() => toggleChannel(ch)}
                className="hover:text-red-500"
                data-testid={`btn-voucher-remove-custom-${item.face_value}-${ch}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder="+ custom channel"
            value={customChannel}
            onChange={(e) => setCustomChannel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomChannel(); } }}
            disabled={saving}
            className="text-xs px-2 py-1 rounded-full border border-dashed border-border bg-background w-32 focus:outline-none focus:border-emerald-500/50"
            data-testid={`input-voucher-custom-channel-${item.face_value}`}
          />
          {customChannel.trim() && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="h-6 px-2 text-xs"
              onClick={addCustomChannel}
              data-testid={`btn-voucher-add-custom-${item.face_value}`}
            >
              Add
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-xs"
          placeholder="Note (optional, e.g. why this is split)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={saving}
          data-testid={`input-voucher-note-${item.face_value}`}
        />
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          onClick={handleSave}
          disabled={!canSave}
          className="h-7 px-3"
          data-testid={`btn-voucher-save-${item.face_value}`}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Save className="h-3 w-3 mr-1" />Save</>}
        </Button>
        {item.mapped && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={deleting}
            className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-500/10"
            data-testid={`btn-voucher-delete-${item.face_value}`}
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </Button>
        )}
      </div>

      {!ignored && selectedChannels.length > 1 && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 italic pl-1">
          Same face value used by multiple campaigns — order revenue is split evenly across {selectedChannels.length} channels.
        </div>
      )}
    </div>
  );
}

function VoucherChannelMappings() {
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<"all" | "unmapped" | "mapped" | "ignored">("all");

  const { data, isLoading, refetch } = useQuery<{ items: VoucherMappingItem[] }>({
    queryKey: ["/api/funtopia/voucher-mappings"],
  });

  const items = data?.items || [];
  // A row is treated as "needs attention" when it has no channels and isn't
  // explicitly ignored — this covers both newly discovered face values and
  // pre-seeded entries (e.g. Indian package face values) awaiting a channel.
  const needsChannel = (i: VoucherMappingItem) =>
    !i.ignored && (i.channels || []).length === 0;
  const stats = useMemo(() => {
    const mapped = items.filter((i) => i.mapped && !i.ignored && (i.channels || []).length > 0).length;
    const ignored = items.filter((i) => i.mapped && i.ignored).length;
    const unmapped = items.filter((i) => needsChannel(i) && (i.times_used > 0 || i.mapped)).length;
    return { mapped, ignored, unmapped, total: items.length };
  }, [items]);

  const filtered = useMemo(() => {
    let arr = items;
    if (filter === "unmapped") arr = arr.filter((i) => needsChannel(i) && (i.times_used > 0 || i.mapped));
    else if (filter === "mapped") arr = arr.filter((i) => i.mapped && !i.ignored && (i.channels || []).length > 0);
    else if (filter === "ignored") arr = arr.filter((i) => i.mapped && i.ignored);
    arr = [...arr].sort((a, b) => {
      if (a.mapped !== b.mapped) return a.mapped ? 1 : -1;
      return b.times_used - a.times_used;
    });
    return showAll ? arr : arr.slice(0, 15);
  }, [items, filter, showAll]);

  return (
    <div className="neu-card-inner p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Ticket className="h-4 w-4 text-orange-500" />
            Voucher → Channel Mapping
          </div>
          <p className="text-xs text-muted-foreground max-w-xl">
            Pisell doesn't transmit channel info, but each marketing QR creates a voucher with a unique face value.
            Map each face value below to its source channel (or mark generic ones like F&B vouchers as Ignored).
            Saved mappings update the "Revenue by Source" card automatically.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500">
            {stats.mapped} mapped
          </Badge>
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500">
            {stats.ignored} ignored
          </Badge>
          <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-500">
            {stats.unmapped} unmapped
          </Badge>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "unmapped", "mapped", "ignored"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="h-7 px-3 text-xs capitalize"
            data-testid={`btn-voucher-filter-${f}`}
          >
            {f}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading voucher data…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center">
          {items.length === 0
            ? "No voucher payments found in the last 180 days. Sync data first, then return here."
            : `No vouchers match the "${filter}" filter.`}
        </div>
      ) : (
        <>
          <div className="text-[10px] text-muted-foreground grid grid-cols-12 gap-2 px-1 hidden sm:grid">
            <div className="col-span-2">Face value</div>
            <div className="col-span-3">Usage (180d)</div>
            <div className="col-span-4">Channel</div>
            <div className="col-span-2">Note</div>
            <div className="col-span-1 text-right">Actions</div>
          </div>
          <div className="divide-y divide-border/40">
            {filtered.map((it) => (
              <VoucherMappingRow key={it.face_value} item={it} onSaved={() => refetch()} />
            ))}
          </div>
          {!showAll && items.length > 15 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowAll(true)}
              className="w-full text-xs"
              data-testid="btn-voucher-show-all"
            >
              Show all {items.length} face values
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function SourceRevenueBreakdown({
  data,
  compData,
  deltaMode = "pct",
}: {
  data: SourceBreakdownEntry[];
  compData?: SourceBreakdownEntry[] | null;
  deltaMode?: CompDeltaMode;
}) {
  const compMap = useMemo(() => {
    const m = new Map<string, SourceBreakdownEntry>();
    if (compData) {
      for (const c of compData) m.set(c.source, c);
    }
    return m;
  }, [compData]);

  const [metric, setMetric] = useState<"revenue" | "orders">("revenue");

  const attributed = data.filter((d) => !UNATTRIBUTED_SOURCES.has(d.source));
  // Roll up any "Unattributed" + "Walk-in" entries into a single Walk-in bucket so
  // backward-compatible cached data is displayed correctly during the transition.
  const walkInEntries = data.filter((d) => UNATTRIBUTED_SOURCES.has(d.source));
  const walkIn: SourceBreakdownEntry | undefined = walkInEntries.length > 0
    ? {
        source: "Walk-in",
        orders: walkInEntries.reduce((s, e) => s + e.orders, 0),
        revenue: walkInEntries.reduce((s, e) => s + e.revenue, 0),
        discount: walkInEntries.reduce((s, e) => s + e.discount, 0),
        variants: [],
      }
    : undefined;

  // F&B perk vouchers (Free Coffee / Free Ice Cream) typically redeem on
  // F&B-only orders with ฿0 ticket revenue, so they get a compact chip
  // instead of a full row + progress bar.
  const attributedRows = attributed.filter((d) => !FNB_PERK_SOURCES.has(d.source));
  const allRows: SourceBreakdownEntry[] = [
    ...attributedRows,
    ...(walkIn ? [walkIn] : []),
  ].filter((d) => d.revenue > 0 || d.orders > 0);
  const visibleAll = attributed.filter((d) => d.revenue > 0 || d.orders > 0);
  const visible = visibleAll.filter((d) => !FNB_PERK_SOURCES.has(d.source));
  const hasAnyRow =
    allRows.length > 0 ||
    data.some((d) => FNB_PERK_SOURCES.has(d.source) && (d.revenue > 0 || d.orders > 0));

  if (!hasAnyRow) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-source-empty">
        No QR-attributed sales in this period
      </p>
    );
  }

  const valueOf = (e: SourceBreakdownEntry) =>
    metric === "revenue" ? e.revenue : e.orders;

  const attributedTotal = visible.reduce((s, v) => s + valueOf(v), 0);
  const walkInValue = walkIn ? valueOf(walkIn) : 0;
  const sortedRows = allRows
    .slice()
    .sort((a, b) => valueOf(b) - valueOf(a));
  // Denominator = total ticket revenue (attributed channels + walk-in
  // remainder). When the toggle is on Orders this becomes the total order
  // count for the period.
  const sharedDenom = walkInValue + attributedTotal;

  const renderRow = (entry: SourceBreakdownEntry, isWalkIn: boolean) => {
    const denom = sharedDenom > 0 ? sharedDenom : 1;
    const value = valueOf(entry);
    const pct = Math.round((value / denom) * 100);
    const gradient = isWalkIn ? SOURCE_GRADIENTS["Walk-in"] : getSourceGradient(entry.source);
    const hasVariants = entry.variants.length > 1;
    const comp = compMap.get(entry.source);
    const slug = entry.source.toLowerCase().replace(/\s+/g, "-");

    const valueNode = (
      <>
        {metric === "revenue" ? (
          <span
            className="dash-meta"
            data-testid={`text-source-orders-${slug}`}
          >
            {Math.round(entry.orders)} {Math.round(entry.orders) === 1 ? "order" : "orders"}
          </span>
        ) : (
          <span
            className="dash-meta"
            data-testid={`text-source-revenue-${slug}`}
          >
            ฿{Math.round(entry.revenue).toLocaleString()}
          </span>
        )}
        {entry.discount > 0 && (
          <span
            className="dash-meta text-amber-600 dark:text-amber-400"
            title="Discount given"
            data-testid={`text-source-discount-${slug}`}
          >
            −฿{entry.discount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        )}
        <span className="dash-meta neu-badge px-2 py-0.5">{pct}%</span>
        {metric === "revenue" ? (
          <AnimatedBaht
            value={Math.round(entry.revenue)}
            className="dash-row-value-emph"
          />
        ) : (
          <span className="dash-row-value-emph" data-testid={`text-source-orders-emph-${slug}`}>
            {Math.round(entry.orders).toLocaleString()}
          </span>
        )}
        {comp && (
          <ComparisonDelta
            current={metric === "revenue" ? entry.revenue : entry.orders}
            previous={metric === "revenue" ? comp.revenue : comp.orders}
            format={metric === "revenue" ? "baht" : "number"}
            compact
            deltaMode={deltaMode}
          />
        )}
      </>
    );

    const renderVariant = (v: { name: string; orders: number; revenue: number; discount: number }) => (
      <div
        key={v.name}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-muted/40 transition-colors"
        data-testid={`source-variant-${v.name.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="dash-row-sublabel flex-1 truncate">{v.name}</span>
        <span className="dash-meta shrink-0">
          {Math.round(v.orders)} {Math.round(v.orders) === 1 ? "order" : "orders"}
        </span>
        {v.discount > 0 && (
          <span className="dash-meta text-amber-600 dark:text-amber-400 shrink-0">
            −฿{v.discount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        )}
        <span className="dash-row-value shrink-0">
          ฿{v.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      </div>
    );

    const variantChildren = hasVariants ? (
      <div className="neu-inset rounded-xl p-2">
        <div className="space-y-0.5">
          {entry.variants
            .slice()
            .sort((a, b) => b.revenue - a.revenue)
            .map(renderVariant)}
        </div>
      </div>
    ) : undefined;

    return (
      <div
        key={entry.source}
        className="space-y-1.5"
        data-testid={`source-row-${slug}`}
      >
        <SubGroupRow
          label={entry.source}
          value={valueNode}
          testId={`source-subgroup-${slug}`}
        >
          {variantChildren}
        </SubGroupRow>
        <div className="neu-inset h-4 overflow-hidden mx-1">
          <div
            className={`h-full bg-gradient-to-r ${gradient} neu-progress-fill`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="source-revenue-breakdown">
      {/* Revenue/Orders metric toggle. The attributed-total summary line was
          removed because the card title already explains what's shown and the
          breakdown rows below carry the actual numbers. */}
      <div className="flex justify-end">
        <div
          className="dash-segmented"
          role="group"
          aria-label="Source metric toggle"
        >
          <button
            type="button"
            className="dash-segmented-btn"
            data-active={metric === "revenue"}
            aria-pressed={metric === "revenue"}
            onClick={(e) => { e.stopPropagation(); setMetric("revenue"); }}
            data-testid="btn-source-metric-revenue"
          >
            Revenue
          </button>
          <button
            type="button"
            className="dash-segmented-btn"
            data-active={metric === "orders"}
            aria-pressed={metric === "orders"}
            onClick={(e) => { e.stopPropagation(); setMetric("orders"); }}
            data-testid="btn-source-metric-orders"
          >
            Orders
          </button>
        </div>
      </div>

      {sortedRows.map((entry) => renderRow(entry, entry.source === "Walk-in"))}
      <SourcePerkChips data={data} />
    </div>
  );
}

function SourcePerkChips({ data }: { data: SourceBreakdownEntry[] }) {
  const perks = data
    .filter((d) => FNB_PERK_SOURCES.has(d.source) && (d.orders > 0 || d.revenue > 0))
    .sort((a, b) => b.orders - a.orders);
  if (perks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="source-perk-chips">
      {perks.map((p) => {
        const slug = p.source.toLowerCase().replace(/\s+/g, "-");
        return (
          <div
            key={p.source}
            className="neu-inset rounded-lg px-2.5 py-1 flex items-center gap-1.5 text-[11px]"
            data-testid={`source-perk-${slug}`}
          >
            <span className="font-medium whitespace-nowrap">{p.source}</span>
            <span className="text-muted-foreground whitespace-nowrap">
              {Math.round(p.orders)} {Math.round(p.orders) === 1 ? "order" : "orders"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DailyRevenueChart({
  data,
  cashData,
  compData: compDailyData,
  compLabel,
}: {
  data: Array<{ date: string; revenue: number; orders: number }>;
  cashData?: Array<{ date: string; revenue: number; florestaRevenue: number }>;
  compData?: Array<{ date: string; revenue: number; orders: number }> | null;
  compLabel?: string;
}) {
  const merged = useMemo(() => {
    const cashMap = new Map<string, { revenue: number }>();
    if (cashData) {
      for (const c of cashData) {
        cashMap.set(c.date, { revenue: c.florestaRevenue || c.revenue });
      }
    }

    const apiMap = new Map<string, { revenue: number; orders: number }>();
    if (data) {
      for (const d of data) {
        apiMap.set(d.date, { revenue: d.revenue, orders: d.orders });
      }
    }

    const allDates = new Set([...cashMap.keys(), ...apiMap.keys()]);
    const result: Array<{
      date: string;
      cashRevenue: number;
      apiRevenue: number;
      orders: number;
      hasCash: boolean;
    }> = [];

    for (const date of allDates) {
      const cash = cashMap.get(date);
      const api = apiMap.get(date);
      result.push({
        date,
        cashRevenue: cash?.revenue || 0,
        apiRevenue: api?.revenue || 0,
        orders: api?.orders || 0,
        hasCash: !!cash,
      });
    }

    return result.sort((a, b) => a.date.localeCompare(b.date));
  }, [data, cashData]);

  const compMap = useMemo(() => {
    if (!compDailyData) return null;
    const m = new Map<number, { revenue: number; orders: number }>();
    compDailyData.forEach((d, i) => m.set(i, { revenue: d.revenue, orders: d.orders }));
    return m;
  }, [compDailyData]);

  if (!merged.length) return null;

  const compMax = compDailyData ? Math.max(...compDailyData.map(d => d.revenue), 0) : 0;
  const maxRevenue = Math.max(
    ...merged.map((d) => Math.max(d.cashRevenue, d.apiRevenue)),
    compMax,
    1,
  );

  return (
    <div className="space-y-1.5">
      {merged.map((d) => {
        const shortDate =
          d.date.length >= 10
            ? `${d.date.substring(8, 10)}/${d.date.substring(5, 7)}`
            : d.date;
        const displayRevenue = d.hasCash ? d.cashRevenue : d.apiRevenue;
        const barWidth = (displayRevenue / maxRevenue) * 100;

        const allHols = getAllHolidaysForDate(d.date);
        const holiday = allHols.length > 0 ? allHols[0] : null;
        const holidayColor = holiday ? HOLIDAY_COLORS[holiday.type].text : "";

        return (
          <div
            key={d.date}
            className="flex items-center gap-2 text-sm"
            data-testid={`daily-rev-row-${d.date}`}
          >
            <span className="w-12 text-muted-foreground shrink-0 text-xs">
              {shortDate}
            </span>
            {allHols.length > 0 ? (
              <span
                className={cn("shrink-0 flex items-center gap-0.5")}
                title={allHols.map(h => h.name).join(" + ")}
              >
                {allHols.map((h, idx) => (
                  <span key={idx} className={cn("w-2 h-2 rounded-full", HOLIDAY_COLORS[h.type].dot)} />
                ))}
              </span>
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <div className="flex-1 h-6 bg-muted/60 rounded-md overflow-hidden relative flex">
              {compMap && (() => {
                const compEntry = compMap.get(merged.indexOf(d));
                if (!compEntry) return null;
                const compWidth = (compEntry.revenue / maxRevenue) * 100;
                return (
                  <div
                    className="absolute inset-y-0 left-0 h-full rounded-md bg-violet-400/25 dark:bg-violet-400/20 border-r-2 border-dashed border-violet-400/50"
                    style={{ width: `${compWidth}%` }}
                    title={`${compLabel}: ฿${compEntry.revenue.toLocaleString()}`}
                  />
                );
              })()}
              <div
                className={cn(
                  "h-full progress-bar-fill rounded-md relative z-10",
                  d.hasCash ? "bg-emerald-500/80" : "bg-primary/60",
                )}
                style={{ width: `${barWidth}%` }}
                title={`${d.hasCash ? "Cash Report" : "POS API"}: ฿${displayRevenue.toLocaleString()}`}
              />
            </div>
            <span className="w-24 text-right font-medium shrink-0 text-xs">
              ฿
              {displayRevenue.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
            {d.orders > 0 && (
              <span className="w-14 text-right text-muted-foreground shrink-0 text-xs">
                {d.orders} txn
              </span>
            )}
          </div>
        );
      })}
      {(cashData?.length || (data?.length ?? 0) > 0) && (
        <div className="flex items-center gap-3 pt-2 text-xs text-muted-foreground border-t mt-2 flex-wrap">
          {cashData && cashData.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-emerald-500/80 inline-block" />{" "}
              Cash Report
            </span>
          )}
          {data && data.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-primary/60 inline-block" />{" "}
              POS API
            </span>
          )}
          <span className="flex items-center gap-1 text-orange-500">
            <CalendarHeart className="h-3 w-3" /> Thai Holiday
          </span>
          <span className="flex items-center gap-1 text-blue-500">
            <CalendarHeart className="h-3 w-3" /> International
          </span>
          <span className="flex items-center gap-1 text-purple-500">
            <CalendarHeart className="h-3 w-3" /> School Break
          </span>
        </div>
      )}
    </div>
  );
}

interface HourlyBucket {
  hour: number;
  label: string;
  orders: number;
  revenue: number;
  ticketsSold: number;
  summerCamp?: { orders: number; revenue: number; ticketsSold: number };
  categories?: Record<string, number>;
  customerTypes?: Record<string, { kids: number; adults: number }>;
}

type HeatmapMetric = "orders" | "revenue" | "ticketsSold";

type HourlyViewMode = "momentum" | "line" | "bar";

function getMomentumGradient(pct: number): string {
  if (pct <= 0) return "transparent";
  if (pct <= 0.2) return "#ef4444";
  if (pct <= 0.35) return "#f97316";
  if (pct <= 0.5) return "#eab308";
  if (pct <= 0.7) return "#84cc16";
  if (pct <= 0.85) return "#22c55e";
  return "#16a34a";
}

function getMomentumBarStyle(pct: number): React.CSSProperties {
  if (pct <= 0) return { width: "0%" };
  return {
    width: `${pct * 100}%`,
    background: `linear-gradient(to right, #ef4444, #f97316 ${Math.min(25, 100)}%, #eab308 ${Math.min(50, 100)}%, #22c55e ${Math.min(80, 100)}%, #16a34a 100%)`,
    backgroundSize: `${100 / pct}% 100%`,
  };
}

function HourlyActivityHeatmap({
  data,
  date,
}: {
  data: HourlyBucket[];
  date: string;
}) {
  const [metric, setMetric] = useState<HeatmapMetric>("revenue");
  const [viewMode, setViewMode] = useState<HourlyViewMode>("momentum");

  const collapsed = useMemo(() => {
    if (data.length <= 24) return data;
    const hourMap: Record<number, HourlyBucket> = {};
    for (let h = 0; h < 24; h++) {
      hourMap[h] = { hour: h, label: `${h.toString().padStart(2, "0")}:00`, orders: 0, revenue: 0, ticketsSold: 0, categories: {}, customerTypes: {} };
    }
    for (const b of data) {
      const h = Math.floor(b.hour / 3);
      if (h < 0 || h > 23) continue;
      hourMap[h].orders += b.orders;
      hourMap[h].revenue += b.revenue;
      hourMap[h].ticketsSold += b.ticketsSold;
      if (b.categories) {
        for (const [k, v] of Object.entries(b.categories)) {
          hourMap[h].categories![k] = (hourMap[h].categories![k] || 0) + v;
        }
      }
      if (b.customerTypes) {
        for (const [k, v] of Object.entries(b.customerTypes)) {
          if (!hourMap[h].customerTypes![k]) hourMap[h].customerTypes![k] = { kids: 0, adults: 0 };
          hourMap[h].customerTypes![k].kids += v.kids;
          hourMap[h].customerTypes![k].adults += v.adults;
        }
      }
    }
    return Object.values(hourMap).sort((a, b) => a.hour - b.hour);
  }, [data]);

  const opHours = collapsed.filter((h) => h.hour >= 9 && h.hour <= 20);

  const maxVal = Math.max(...opHours.map((h) => h[metric]), 1);
  const totalOrders = opHours.reduce((s, h) => s + h.orders, 0);
  const totalRevenue = opHours.reduce((s, h) => s + h.revenue, 0);
  const totalTickets = opHours.reduce((s, h) => s + h.ticketsSold, 0);
  const peakHour = opHours.reduce(
    (best, h) => (h[metric] > best[metric] ? h : best),
    opHours[0],
  );
  const avgVal =
    opHours.length > 0
      ? opHours.reduce((s, h) => s + h[metric], 0) / opHours.length
      : 0;

  const metricLabels: Record<HeatmapMetric, string> = {
    orders: "Orders",
    revenue: "Revenue",
    ticketsSold: "Tickets",
  };

  const chartData = opHours.map((h) => ({
    label: h.label.replace(":00", "h"),
    value: h[metric],
    hour: h.hour,
    fill: getMomentumGradient(h[metric] / maxVal),
  }));

  const fmtTooltip = (val: number) =>
    metric === "revenue"
      ? `฿${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : String(val);

  const viewModes: {
    key: HourlyViewMode;
    icon: typeof Activity;
    label: string;
  }[] = [
    { key: "momentum", icon: Activity, label: "Momentum" },
    { key: "line", icon: LineChartLucide, label: "Line" },
    { key: "bar", icon: BarChartLucide, label: "Bar" },
  ];

  return (
    <div className="neu-card">
      <div className="p-4 pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-base font-semibold">
            Hourly Activity — {date}
          </div>
          <div className="flex items-center gap-1">
            {viewModes.map((vm) => (
              <Button
                key={vm.key}
                variant={viewMode === vm.key ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode(vm.key)}
                className="text-xs h-7 px-2"
                data-testid={`btn-hourly-view-${vm.key}`}
                title={vm.label}
              >
                <vm.icon className="h-3.5 w-3.5" />
              </Button>
            ))}
            <div className="w-px h-5 bg-border mx-0.5" />
            {(Object.keys(metricLabels) as HeatmapMetric[]).map((m) => (
              <Button
                key={m}
                variant={metric === m ? "default" : "outline"}
                size="sm"
                onClick={() => setMetric(m)}
                className="text-xs h-7 px-2"
                data-testid={`btn-heatmap-metric-${m}`}
              >
                {metricLabels[m]}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="px-4 pb-4">
        {viewMode === "momentum" && (
          <div className="space-y-1.5 mb-4">
            {opHours.map((h) => {
              const val = h[metric];
              const pct = maxVal > 0 ? val / maxVal : 0;
              const fmtVal =
                metric === "revenue"
                  ? `฿${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : String(val);

              return (
                <div
                  key={h.hour}
                  className="flex items-center gap-2 text-xs"
                  data-testid={`hourly-bar-${h.hour}`}
                >
                  <span className="w-10 text-muted-foreground shrink-0 font-medium">
                    {h.label.replace(":00", "h")}
                  </span>
                  <div className="flex-1 neu-inset h-4 overflow-hidden">
                    <div
                      className="h-full neu-progress-fill transition-all duration-500"
                      style={{
                        width: `${pct * 100}%`,
                        background: `linear-gradient(to right, #ef4444, #f97316 25%, #eab308 50%, #22c55e 80%, #16a34a 100%)`,
                        backgroundSize: `${pct > 0 ? 100 / pct : 100}% 100%`,
                      }}
                      title={`${h.label}: ${fmtVal}`}
                    />
                  </div>
                  <span className="w-16 text-right font-medium shrink-0">
                    {fmtVal}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {viewMode === "line" && (
          <div className="mb-4" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <defs>
                  <linearGradient
                    id="hourlyLineGradient"
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset="25%" stopColor="#f97316" />
                    <stop offset="50%" stopColor="#eab308" />
                    <stop offset="80%" stopColor="#22c55e" />
                    <stop offset="100%" stopColor="#16a34a" />
                  </linearGradient>
                  <linearGradient
                    id="hourlyAreaGradient"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  tickFormatter={(v) =>
                    metric === "revenue"
                      ? `฿${(v / 1000).toFixed(0)}k`
                      : String(v)
                  }
                />
                <Tooltip
                  formatter={(val: number) => [
                    fmtTooltip(val),
                    metricLabels[metric],
                  ]}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <ReferenceLine
                  y={avgVal}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  label={{
                    value: "Avg",
                    position: "right",
                    fontSize: 10,
                    fill: "#94a3b8",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="url(#hourlyLineGradient)"
                  strokeWidth={3}
                  dot={({ cx, cy, payload }: any) => {
                    const dotColor = getMomentumGradient(
                      (payload?.value || 0) / maxVal,
                    );
                    return (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill={dotColor}
                        stroke="none"
                      />
                    );
                  }}
                  activeDot={({ cx, cy, payload }: any) => {
                    const dotColor = getMomentumGradient(
                      (payload?.value || 0) / maxVal,
                    );
                    return (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={6}
                        fill={dotColor}
                        stroke="white"
                        strokeWidth={2}
                      />
                    );
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {viewMode === "bar" && (
          <div className="mb-4" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  tickFormatter={(v) =>
                    metric === "revenue"
                      ? `฿${(v / 1000).toFixed(0)}k`
                      : String(v)
                  }
                />
                <Tooltip
                  formatter={(val: number) => [
                    fmtTooltip(val),
                    metricLabels[metric],
                  ]}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <ReferenceLine
                  y={avgVal}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  label={{
                    value: "Avg",
                    position: "right",
                    fontSize: 10,
                    fill: "#94a3b8",
                  }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span>{totalOrders} orders</span>
            <span>
              ฿
              {totalRevenue.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{" "}
              revenue
            </span>
            <span>{totalTickets} tickets</span>
          </div>
          {peakHour && peakHour[metric] > 0 && (
            <span>
              Peak: {peakHour.label} (
              {metric === "revenue"
                ? `฿${peakHour.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : peakHour[metric]}
              )
            </span>
          )}
        </div>

        {viewMode === "momentum" && (
          <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground justify-end">
            <span>Low</span>
            <div className="w-24 h-3 rounded neu-inset overflow-hidden">
              <div
                className="w-full h-full"
                style={{
                  background:
                    "linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #16a34a)",
                }}
              />
            </div>
            <span>Peak</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface DailyHourlyData {
  date: string;
  dayOfWeek?: string;
  hourly?: HourlyBucket[];
  hourlyBreakdown?: HourlyBucket[];
}

function MultiDayHeatmap({
  dailyHourly,
  periodLabel,
  compDailyHourly,
  compLabel,
  voucherAmount = 0,
  compVoucherAmount = 0,
  metric: metricProp,
  onMetricChange,
}: {
  dailyHourly: DailyHourlyData[];
  periodLabel: string;
  compDailyHourly?: DailyHourlyData[];
  compLabel?: string;
  voucherAmount?: number;
  compVoucherAmount?: number;
  metric?: HeatmapMetric;
  onMetricChange?: (m: HeatmapMetric) => void;
}) {
  const [metricState, setMetricState] = useState<HeatmapMetric>("orders");
  const isControlled = metricProp !== undefined;
  const metric = isControlled ? metricProp : metricState;
  const setMetric = (m: HeatmapMetric) => {
    if (!isControlled) setMetricState(m);
    onMetricChange?.(m);
  };
  const getHourlyRaw = (d: DailyHourlyData) => d.hourly || d.hourlyBreakdown || [];
  const getDayOfWeek = (d: DailyHourlyData) =>
    d.dayOfWeek || (d.date ? DAY_NAMES[new Date(d.date).getDay()] : "");

  const collapseToHourly = (buckets: HourlyBucket[]): HourlyBucket[] => {
    if (buckets.length <= 24) return buckets;
    const hourMap: Record<number, HourlyBucket> = {};
    for (let h = 0; h < 24; h++) {
      hourMap[h] = { hour: h, label: `${h.toString().padStart(2, "0")}:00`, orders: 0, revenue: 0, ticketsSold: 0, categories: {}, customerTypes: {} };
    }
    for (const b of buckets) {
      const h = Math.floor(b.hour / 3);
      if (h < 0 || h > 23) continue;
      hourMap[h].orders += b.orders || 0;
      hourMap[h].revenue += b.revenue || 0;
      hourMap[h].ticketsSold += b.ticketsSold || 0;
      if (b.categories) {
        for (const [k, v] of Object.entries(b.categories)) {
          hourMap[h].categories![k] = (hourMap[h].categories![k] || 0) + v;
        }
      }
      if (b.customerTypes) {
        for (const [k, v] of Object.entries(b.customerTypes)) {
          if (!hourMap[h].customerTypes![k]) hourMap[h].customerTypes![k] = { kids: 0, adults: 0 };
          hourMap[h].customerTypes![k].kids += v.kids;
          hourMap[h].customerTypes![k].adults += v.adults;
        }
      }
    }
    return Object.values(hourMap).sort((a, b) => a.hour - b.hour);
  };

  const getHourly = (d: DailyHourlyData) => collapseToHourly(getHourlyRaw(d));
  const hours = Array.from({ length: 12 }, (_, i) => i + 9);

  const isRevenueMetric = metric === "revenue";
  const grossTotal = isRevenueMetric
    ? dailyHourly.reduce((s, d) => s + getHourly(d).reduce((ss, h) => ss + h.revenue, 0), 0)
    : 0;
  const voucherRatio = 1;
  const compVoucherRatio = 1;

  const getVal = (h: HourlyBucket, isComp: boolean) => {
    const raw = (h[metric] as number | undefined) ?? 0;
    if (!isRevenueMetric) return raw;
    return raw * (isComp ? compVoucherRatio : voucherRatio);
  };

  const allValues = [
    ...dailyHourly.flatMap((d) =>
      getHourly(d)
        .filter((h) => h.hour >= 9 && h.hour <= 20)
        .map((h) => getVal(h, false)),
    ),
    ...(compDailyHourly || []).flatMap((d) =>
      getHourly(d)
        .filter((h) => h.hour >= 9 && h.hour <= 20)
        .map((h) => getVal(h, true)),
    ),
  ];
  const maxVal = Math.max(...allValues, 1);

  const getColor = (value: number) => {
    if (value === 0) return "bg-muted";
    const ratio = value / maxVal;
    if (ratio > 0.75) return "bg-green-500 dark:bg-green-500";
    if (ratio > 0.5) return "bg-emerald-400 dark:bg-emerald-500";
    if (ratio > 0.25) return "bg-yellow-400 dark:bg-yellow-500";
    return "bg-orange-300 dark:bg-orange-500";
  };

  const getTextColor = (value: number) => {
    if (value === 0) return "text-muted-foreground/40";
    const ratio = value / maxVal;
    if (ratio > 0.5) return "text-white";
    return "text-foreground";
  };

  const metricLabels: Record<HeatmapMetric, string> = {
    orders: "Orders",
    revenue: "Revenue",
    ticketsSold: "Tickets",
  };

  const hasComparison = !!(compDailyHourly && compDailyHourly.length > 0 && compLabel);

  const totalByHour = getActivityHourlyTotals(
    [
      ...dailyHourly.map((day) => ({ ...day, hourly: undefined, hourlyBreakdown: getHourly(day) })),
      ...(hasComparison
        ? compDailyHourly!.map((day) => ({ ...day, hourly: undefined, hourlyBreakdown: getHourly(day) }))
        : []),
    ],
    metric,
    hours,
  );

  const renderRow = (day: DailyHourlyData, label: string, isComp: boolean) => (
    <tr key={`${isComp ? "comp-" : ""}${day.date}`} className={isComp ? "opacity-70" : ""}>
      <td className="p-1 whitespace-nowrap">
        <div className="flex items-center gap-1">
          {hasComparison && (
            <div className={cn("w-1 h-6 rounded-full shrink-0", isComp ? "bg-violet-500" : "bg-emerald-500")} />
          )}
          <div>
            <div className="font-medium text-[11px] leading-tight">{label}</div>
          </div>
        </div>
      </td>
      {hours.map((h) => {
        const bucket = getHourly(day).find((b) => b.hour === h);
        const val = bucket ? getVal(bucket, isComp) : 0;
        return (
          <td key={h} className="p-0.5">
            <div
              className={`rounded p-1 text-center ${getColor(val)} ${getTextColor(val)} min-w-[28px]`}
              title={`${label} ${h}:00 — ${metric === "revenue" ? `฿${Math.round(val || 0).toLocaleString()}` : (val || 0)}`}
            >
              {metric === "revenue"
                ? val >= 1000 ? `${(val / 1000).toFixed(0)}k` : Math.round(val) || ""
                : val || ""}
            </div>
          </td>
        );
      })}
    </tr>
  );

  const formatDayLabel = (day: DailyHourlyData) => {
    const dow = getDayOfWeek(day).substring(0, 3);
    const dateStr = day.date.substring(5);
    return `${dow} ${dateStr}`;
  };

  const interleavedRows = () => {
    const rows: JSX.Element[] = [];
    if (!hasComparison) {
      dailyHourly.filter(d => d.date).forEach((day) => {
        rows.push(renderRow(day, formatDayLabel(day), false));
      });
    } else {
      const isSingleDayComp = dailyHourly.length === 1 && compDailyHourly!.length === 1;
      if (isSingleDayComp) {
        const day = dailyHourly[0];
        const compDay = compDailyHourly![0];
        rows.push(renderRow(day, periodLabel, false));
        rows.push(renderRow(compDay, compLabel!, true));
      } else {
        dailyHourly.filter(d => d.date).forEach((day) => {
          rows.push(renderRow(day, formatDayLabel(day), false));
        });
        if (dailyHourly.length > 0 && compDailyHourly!.length > 0) {
          rows.push(
            <tr key="divider">
              <td colSpan={hours.length + 1} className="py-0.5">
                <div className="border-t border-dashed border-muted-foreground/20" />
              </td>
            </tr>
          );
        }
        compDailyHourly!.filter(d => d.date).forEach((day) => {
          rows.push(renderRow(day, formatDayLabel(day), true));
        });
      }
    }
    return rows;
  };

  const totalRow = (
    <tr className="border-t-2 border-border bg-muted/60" data-testid="activity-heatmap-total-row">
      <td className="p-1 font-semibold whitespace-nowrap">Total</td>
      {hours.map((hour) => {
        const value = totalByHour[hour] || 0;
        return (
          <td key={hour} className="p-0.5">
            <div
              className="min-w-[28px] rounded bg-background/70 p-1 text-center font-semibold text-foreground"
              title={`Total ${hour}:00 — ${metric === "revenue" ? `฿${Math.round(value).toLocaleString()}` : value}`}
            >
              {metric === "revenue"
                ? value >= 1000 ? `${(value / 1000).toFixed(0)}k` : Math.round(value) || ""
                : value || ""}
            </div>
          </td>
        );
      })}
    </tr>
  );

  const smartSummary = useMemo(() => {
    const hourTotals: Record<number, number> = {};
    const dayMap: Record<string, { name: string; total: number; count: number }> = {};
    for (const d of dailyHourly) {
      const dow = getDayOfWeek(d);
      const dayTotal = getHourly(d).reduce((s, h) => s + getVal(h, false), 0);
      if (dow) {
        if (!dayMap[dow]) dayMap[dow] = { name: dow, total: 0, count: 0 };
        dayMap[dow].total += dayTotal;
        dayMap[dow].count += 1;
      }
      for (const b of getHourly(d)) {
        if (b.hour < 9 || b.hour > 20) continue;
        hourTotals[b.hour] = (hourTotals[b.hour] || 0) + getVal(b, false);
      }
    }
    const hourEntries = Object.entries(hourTotals)
      .map(([h, v]) => ({ hour: Number(h), total: v }))
      .filter((e) => e.total > 0);
    if (hourEntries.length === 0) return null;
    const busiest = hourEntries.reduce((a, b) => (b.total > a.total ? b : a));
    const dayEntries = Object.values(dayMap)
      .map((d) => ({ name: d.name, avg: d.count > 0 ? d.total / d.count : 0 }))
      .filter((d) => d.avg > 0);
    let quietest: { name: string; avg: number } | null = null;
    if (dayEntries.length >= 2) {
      quietest = dayEntries.reduce((a, b) => (b.avg < a.avg ? b : a));
    }
    return { busiest, quietest };
  }, [dailyHourly, metric]);

  const fmtHourRange = (h: number) =>
    `${h.toString().padStart(2, "0")}:00–${(h + 1).toString().padStart(2, "0")}:00`;

  return (
    <div>
      {!isControlled && (
        <div className="flex items-center justify-end mb-3">
          <div className="dash-segmented" role="tablist" aria-label="Heatmap metric">
            {(Object.keys(metricLabels) as HeatmapMetric[]).map((m) => (
              <button
                key={m}
                type="button"
                className="dash-segmented-btn"
                data-active={metric === m}
                onClick={() => setMetric(m)}
                data-testid={`btn-multi-heatmap-${m}`}
              >
                {metricLabels[m]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left p-1 text-muted-foreground font-normal w-20">
                  {hasComparison ? "" : "Day"}
                </th>
                {hours.map((h) => (
                  <th key={h} className="p-1 text-muted-foreground font-normal text-center">{h}:00</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {interleavedRows()}
              {totalRow}
            </tbody>
          </table>
        </div>
        <div className="flex items-start justify-between gap-3 mt-3">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            {hasComparison && (
              <div className="flex items-center gap-3 dash-meta">
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-3 rounded-full bg-emerald-500" />
                  <span>{periodLabel}</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-3 rounded-full bg-violet-500" />
                  <span>{compLabel}</span>
                </div>
              </div>
            )}
            {smartSummary && (
              <div className="dash-meta truncate" data-testid="heatmap-smart-summary">
                <span className="font-medium text-foreground/80">Busiest hour:</span>{" "}
                {fmtHourRange(smartSummary.busiest.hour)}
                {smartSummary.quietest && (
                  <>
                    {" · "}
                    <span className="font-medium text-foreground/80">Quietest day:</span>{" "}
                    {smartSummary.quietest.name}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 dash-meta shrink-0">
            <span>Quiet</span>
            <div className="flex gap-0.5">
              <div className="w-3 h-2.5 rounded-sm bg-orange-300 dark:bg-orange-500" />
              <div className="w-3 h-2.5 rounded-sm bg-yellow-400 dark:bg-yellow-500" />
              <div className="w-3 h-2.5 rounded-sm bg-emerald-400 dark:bg-emerald-500" />
              <div className="w-3 h-2.5 rounded-sm bg-green-500 dark:bg-green-500" />
            </div>
            <span>Busy</span>
          </div>
        </div>
      </div>
  );
}

interface DiscountBreakdownData {
  totalOrders: number;
  ordersWithDiscount: number;
  totalDiscountAmount: number;
  orderDiscountCount: number;
  orderDiscountTotal: number;
  productDiscounts: Array<{
    name: string;
    count: number;
    totalDiscount: number;
  }>;
}

function DiscountBreakdownCard({ data }: { data: DiscountBreakdownData }) {
  const discountRate =
    data.totalOrders > 0
      ? Math.round((data.ordersWithDiscount / data.totalOrders) * 100)
      : 0;

  return (
    <div className="neu-card">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          Discount Analysis
        </div>
      </div>
      <div className="px-4 pb-4 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-3 neu-card">
            <p className="text-xs text-muted-foreground">Total Discounted</p>
            <p
              className="text-lg font-bold"
              data-testid="metric-total-discount"
            >
              ฿
              {data.totalDiscountAmount.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </p>
          </div>
          <div className="text-center p-3 neu-card">
            <p className="text-xs text-muted-foreground">Orders w/ Discount</p>
            <p
              className="text-lg font-bold"
              data-testid="metric-discount-orders"
            >
              {data.ordersWithDiscount} / {data.totalOrders}
            </p>
          </div>
          <div className="text-center p-3 neu-card">
            <p className="text-xs text-muted-foreground">Discount Rate</p>
            <p className="text-lg font-bold" data-testid="metric-discount-rate">
              {discountRate}%
            </p>
          </div>
        </div>

        {data.orderDiscountTotal > 0 && (
          <div className="text-sm">
            <span className="text-muted-foreground">
              Order-level discounts:{" "}
            </span>
            <span className="font-medium">
              ฿
              {data.orderDiscountTotal.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
            <span className="text-muted-foreground">
              {" "}
              across {data.orderDiscountCount} orders
            </span>
          </div>
        )}

        {data.productDiscounts && data.productDiscounts.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">
              Product-Level Discounts
            </p>
            {data.productDiscounts.map((pd, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs"
              >
                <span className="truncate flex-1">{pd.name}</span>
                <span className="text-muted-foreground shrink-0 ml-2">
                  ×{pd.count}
                </span>
                <span className="font-medium shrink-0 ml-2">
                  ฿
                  {pd.totalDiscount.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface CustomerTypeData {
  type: string;
  orders: number;
  revenue: number;
  kidTickets: number;
  adultTickets: number;
  totalGuests: number;
}

const CUSTOMER_TYPE_COLORS: Record<
  string,
  { bg: string; text: string; dot: string }
> = {
  Tourist: {
    bg: "bg-blue-50 dark:bg-blue-950/20",
    text: "text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  Thai: {
    bg: "bg-green-50 dark:bg-green-950/20",
    text: "text-green-700 dark:text-green-400",
    dot: "bg-green-500",
  },
  Expat: {
    bg: "bg-orange-50 dark:bg-orange-950/20",
    text: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  Special: {
    bg: "bg-purple-50 dark:bg-purple-950/20",
    text: "text-purple-700 dark:text-purple-400",
    dot: "bg-purple-500",
  },
  "Eat & Play Package": {
    bg: "bg-purple-50 dark:bg-purple-950/20",
    text: "text-purple-700 dark:text-purple-400",
    dot: "bg-purple-500",
  },
};
const DEFAULT_TYPE_COLOR = {
  bg: "bg-slate-50 dark:bg-gray-950/20",
  text: "text-slate-700 dark:text-gray-400",
  dot: "bg-slate-500",
};

function CustomerTypeSplitCard({
  data,
  embedded,
}: {
  data: CustomerTypeData[];
  embedded?: boolean;
}) {
  const totalRevenue = data.reduce((s, d) => s + d.revenue, 0);
  const totalKids = data.reduce((s, d) => s + d.kidTickets, 0);
  const totalAdults = data.reduce((s, d) => s + d.adultTickets, 0);

  const colorMap: Record<string, string> = {
    Tourist: "#3b82f6",
    Thai: "#22c55e",
    Expat: "#f97316",
    Special: "#a855f7",
    "Eat & Play Package": "#a855f7",
  };

  const gradientMap: Record<string, string> = {
    Tourist: "from-blue-600 to-indigo-500",
    Thai: "from-emerald-500 to-teal-500",
    Expat: "from-amber-500 to-orange-500",
    Special: "from-violet-600 to-purple-500",
    "Eat & Play Package": "from-violet-600 to-purple-500",
  };

  const sorted = [...data].filter((d) => d.revenue > 0).sort((a, b) => b.revenue - a.revenue);

  const bentoCell = (d: CustomerTypeData, i: number, size: "lg" | "md" | "sm") => {
    const revPct = totalRevenue > 0 ? Math.round((d.revenue / totalRevenue) * 100) : 0;
    const grad = gradientMap[d.type] || "from-gray-500 to-slate-500";
    const typeColor = colorMap[d.type] || "#6b7280";
    return (
      <div
        key={d.type}
        className={cn(
          "relative overflow-hidden rounded-xl border border-white/5 transition-all duration-200 hover:scale-[1.02] cursor-default",
          size === "lg" && "col-span-2 row-span-2",
          size === "md" && "col-span-1 row-span-2",
        )}
        data-testid={`customer-type-${d.type.toLowerCase()}`}
      >
        <div className={cn("absolute inset-0 bg-gradient-to-br opacity-15 dark:opacity-20", grad)} />
        <div className={cn("relative h-full flex flex-col justify-between", size === "lg" ? "p-4" : size === "md" ? "p-3" : "p-2.5")}>
          <div>
            <div className="flex items-start justify-between gap-1">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
                <span className={cn("font-semibold leading-tight", size === "lg" ? "text-sm" : "text-xs")}>{d.type}</span>
              </div>
              <span className={cn("neu-badge px-1.5 py-0.5 text-[10px] shrink-0")}>{revPct}%</span>
            </div>
          </div>
          <div className="mt-auto pt-2 space-y-1.5">
            <div className="neu-inset h-1.5 overflow-hidden rounded-full">
              <div className={cn("h-full bg-gradient-to-r rounded-full", grad)} style={{ width: `${revPct}%` }} />
            </div>
            <div className="flex items-end justify-between gap-1">
              <div className={cn("flex flex-wrap gap-x-2 gap-y-0 text-muted-foreground", size === "lg" ? "text-[11px]" : "text-[10px]")}>
                <span>{d.orders} orders</span>
                <span>{d.kidTickets} kids</span>
                <span>{d.adultTickets} adults</span>
              </div>
              <span className={cn("font-bold shrink-0 metric-value", size === "lg" ? "text-base" : size === "md" ? "text-sm" : "text-xs")}>
                ฿{d.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const content = (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>{totalKids} kids · {totalAdults} adults</span>
        <span className="font-semibold metric-value">
          ฿{totalRevenue >= 1000 ? `${(totalRevenue / 1000).toFixed(0)}k` : totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 auto-rows-[minmax(50px,auto)] sm:auto-rows-[minmax(60px,auto)] gap-2">
        {sorted[0] && bentoCell(sorted[0], 0, "lg")}
        {sorted[1] && bentoCell(sorted[1], 1, "md")}
        {sorted[2] && bentoCell(sorted[2], 2, "sm")}
        {sorted[3] && bentoCell(sorted[3], 3, "sm")}
        {sorted.slice(4).map((d, idx) => bentoCell(d, idx + 4, "sm"))}
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <div className="neu-card">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          Customer Type Split
        </div>
      </div>
      <div className="px-4 pb-4">{content}</div>
    </div>
  );
}

type TodayPeriod = "today" | "yesterday" | "week" | "month" | "custom";
type ComparePeriod = "week" | "month" | "year";
type CompareWith = "lastPeriod" | "lastYear";

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_NAMES_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function computePeriodRange(
  period: ComparePeriod,
  offset: number,
): { start: string; end: string; title: string; subtitle: string } {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  if (period === "week") {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset - offset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const end = offset === 0 ? now : sunday;
    return {
      start: fmt(monday),
      end: fmt(end),
      title: offset === 0 ? "This Week" : `Week of ${fmt(monday)}`,
      subtitle: `${fmt(monday)} → ${fmt(end)}`,
    };
  }
  if (period === "month") {
    const targetMonth = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const lastDay = new Date(
      targetMonth.getFullYear(),
      targetMonth.getMonth() + 1,
      0,
    );
    const end = offset === 0 ? now : lastDay;
    return {
      start: fmt(targetMonth),
      end: fmt(end),
      title: `${MONTH_NAMES_FULL[targetMonth.getMonth()]} ${targetMonth.getFullYear()}`,
      subtitle: `${fmt(targetMonth)} → ${fmt(end)}`,
    };
  }
  const yearStart = new Date(now.getFullYear() - offset, 0, 1);
  const yearEnd =
    offset === 0 ? now : new Date(now.getFullYear() - offset, 11, 31);
  return {
    start: fmt(yearStart),
    end: fmt(yearEnd),
    title: `${yearStart.getFullYear()}`,
    subtitle: `${fmt(yearStart)} → ${fmt(yearEnd)}`,
  };
}

function computeComparisonRange(
  period: ComparePeriod,
  offset: number,
  compareWith: "lastPeriod" | "lastYear",
): { start: string; end: string; label: string } {
  if (compareWith === "lastPeriod") {
    const r = computePeriodRange(period, offset + 1);
    return { start: r.start, end: r.end, label: r.title };
  }
  const current = computePeriodRange(period, offset);
  const startDate = new Date(current.start);
  const endDate = new Date(current.end);
  startDate.setFullYear(startDate.getFullYear() - 1);
  endDate.setFullYear(endDate.getFullYear() - 1);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return {
    start: fmt(startDate),
    end: fmt(endDate),
    label: `Same period ${startDate.getFullYear()}`,
  };
}

function formatBaht(val: number): string {
  if (val >= 1_000_000) return `฿${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `฿${(val / 1_000).toFixed(0)}k`;
  return `฿${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function RevenueComparisonChart() {
  const [period, setPeriod] = useState<ComparePeriod>("week");
  const [offset, setOffset] = useState(0);
  const [compareWith, setCompareWith] = useState<CompareWith>("lastPeriod");
  const [currentData, setCurrentData] = useState<any>(null);
  const [comparisonData, setComparisonData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [compLoading, setCompLoading] = useState(false);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [chartType, setChartType] = useState<"line" | "bar">("line");

  const currentRange = computePeriodRange(period, offset);

  const fetchCurrent = async (p: ComparePeriod, off: number) => {
    setLoading(true);
    try {
      const r = computePeriodRange(p, off);
      const res = await fetch(
        `/api/funtopia/range?start=${r.start}&end=${r.end}`,
      );
      if (res.ok) {
        const data = await res.json();
        setCurrentData(data);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const fetchComparison = async (
    p: ComparePeriod,
    off: number,
    cw: CompareWith,
  ) => {
    setCompLoading(true);
    try {
      const r = computeComparisonRange(p, off, cw);
      const res = await fetch(
        `/api/funtopia/range?start=${r.start}&end=${r.end}`,
      );
      if (res.ok) {
        const data = await res.json();
        setComparisonData(data);
      }
    } catch {
    } finally {
      setCompLoading(false);
    }
  };

  useEffect(() => {
    if (!autoLoaded) {
      setAutoLoaded(true);
      fetchCurrent(period, offset);
      fetchComparison(period, offset, compareWith);
    }
  }, []);

  const handlePeriodChange = (p: ComparePeriod) => {
    setPeriod(p);
    setOffset(0);
    fetchCurrent(p, 0);
    fetchComparison(p, 0, compareWith);
  };

  const handleOffsetChange = (dir: number) => {
    const newOffset = Math.max(0, offset + dir);
    setOffset(newOffset);
    fetchCurrent(period, newOffset);
    fetchComparison(period, newOffset, compareWith);
  };

  const handleCompareChange = (cw: CompareWith) => {
    setCompareWith(cw);
    fetchComparison(period, offset, cw);
  };

  const compRange = computeComparisonRange(period, offset, compareWith);

  const buildChartData = () => {
    if (!currentData) return [];
    const currentDaily = currentData.dailyRevenue || [];
    const compDaily = comparisonData?.dailyRevenue || [];
    const currentCash = currentData.cashReportsDailyTotals || [];
    const compCash = comparisonData?.cashReportsDailyTotals || [];

    const currentMap = new Map<string, number>();
    for (const d of currentCash) currentMap.set(d.date, d.revenue);
    for (const d of currentDaily) {
      if (!currentMap.has(d.date)) currentMap.set(d.date, d.revenue);
    }

    const compMap = new Map<string, number>();
    for (const d of compCash) compMap.set(d.date, d.revenue);
    for (const d of compDaily) {
      if (!compMap.has(d.date)) compMap.set(d.date, d.revenue);
    }

    const currentEntries = Array.from(currentMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    const compEntries = Array.from(compMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    const maxLen = Math.max(currentEntries.length, compEntries.length);
    const result = [];

    for (let i = 0; i < maxLen; i++) {
      const curr = currentEntries[i];
      const comp = compEntries[i];
      const dayNum = i + 1;
      const shortLabel = curr
        ? `${curr[0].substring(8, 10)}/${curr[0].substring(5, 7)}`
        : `Day ${dayNum}`;

      result.push({
        day: shortLabel,
        current: curr ? curr[1] : 0,
        comparison: comp ? comp[1] : 0,
        currentDate: curr?.[0] || "",
        compDate: comp?.[0] || "",
      });
    }

    return result;
  };

  const chartData = buildChartData();
  const currentTotal = chartData.reduce((s, d) => s + d.current, 0);
  const compTotal = chartData.reduce((s, d) => s + d.comparison, 0);
  const change =
    compTotal > 0 ? ((currentTotal - compTotal) / compTotal) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {(["week", "month", "year"] as ComparePeriod[]).map((p) => (
          <Button
            key={p}
            variant={period === p ? "default" : "outline"}
            size="sm"
            onClick={() => handlePeriodChange(p)}
            data-testid={`btn-compare-period-${p}`}
          >
            {p === "week" ? "Weekly" : p === "month" ? "Monthly" : "Yearly"}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => handleOffsetChange(1)}
            aria-label="Previous period"
            data-testid="btn-compare-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium px-2 min-w-[100px] text-center">
            {currentRange.title}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => handleOffsetChange(-1)}
            disabled={offset === 0}
            aria-label="Next period"
            data-testid="btn-compare-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Compare with:</span>
        <Button
          variant={compareWith === "lastPeriod" ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => handleCompareChange("lastPeriod")}
          data-testid="btn-compare-last-period"
        >
          Previous {period}
        </Button>
        <Button
          variant={compareWith === "lastYear" ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => handleCompareChange("lastYear")}
          data-testid="btn-compare-last-year"
        >
          Last Year
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={chartType === "line" ? "default" : "outline"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setChartType("line")}
            aria-label="Line chart"
            data-testid="btn-chart-line"
          >
            <LineChartLucide className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={chartType === "bar" ? "default" : "outline"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setChartType("bar")}
            aria-label="Bar chart"
            data-testid="btn-chart-bar"
          >
            <BarChartLucide className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="neu-card p-4">
        <div className="flex items-center gap-4 mb-4 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground">
              {currentRange.title}
            </p>
            <p
              className="text-xl font-bold privacy-sensitive"
              data-testid="metric-compare-current"
            >
              {formatBaht(currentTotal)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{compRange.label}</p>
            <p
              className="text-xl font-bold text-muted-foreground privacy-sensitive"
              data-testid="metric-compare-previous"
            >
              {formatBaht(compTotal)}
            </p>
          </div>
          {compTotal > 0 && (
            <Badge
              variant={change >= 0 ? "default" : "destructive"}
              className="text-sm"
              data-testid="metric-compare-change"
            >
              {change >= 0 ? "+" : ""}
              {change.toFixed(1)}%
            </Badge>
          )}
        </div>

        {loading || compLoading ? (
          <div className="flex items-center justify-center gap-2 py-8">
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            {chartType === "line" ? (
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v) => formatBaht(v)}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  formatter={(v: number) =>
                    `฿${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  }
                />
                <Line
                  type="monotone"
                  dataKey="current"
                  name={currentRange.title}
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="comparison"
                  name={compRange.label}
                  stroke="#9ca3af"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={{ r: 2 }}
                />
                <Legend />
              </LineChart>
            ) : (
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v) => formatBaht(v)}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  formatter={(v: number) =>
                    `฿${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  }
                />
                <Bar
                  dataKey="current"
                  name={currentRange.title}
                  fill="#3b82f6"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="comparison"
                  name={compRange.label}
                  fill="#9ca3af"
                  radius={[4, 4, 0, 0]}
                  opacity={0.5}
                />
                <Legend />
              </BarChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            <p>No data available for this period</p>
          </div>
        )}
      </div>

      {currentData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="neu-card p-4">
            <p className="text-sm font-semibold mb-2">
              {currentRange.title} — Summary
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Revenue</span>
                <span className="font-medium privacy-sensitive">{formatBaht(currentTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Orders</span>
                <span className="font-medium">
                  {currentData.totalOrders || 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Avg Order</span>
                <span className="font-medium privacy-sensitive">
                  {formatBaht(currentData.avgOrderValue || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discounts</span>
                <span className="font-medium privacy-sensitive">
                  {formatBaht(currentData.discountTotal || 0)}
                </span>
              </div>
            </div>
          </div>

          {comparisonData && (
            <div className="neu-card p-4">
              <p className="text-sm font-semibold mb-2">
                {compRange.label} — Summary
              </p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Revenue</span>
                  <span className="font-medium privacy-sensitive">{formatBaht(compTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Orders</span>
                  <span className="font-medium">
                    {comparisonData.totalOrders || 0}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Order</span>
                  <span className="font-medium privacy-sensitive">
                    {formatBaht(comparisonData.avgOrderValue || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Discounts</span>
                  <span className="font-medium privacy-sensitive">
                    {formatBaht(comparisonData.discountTotal || 0)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type PerfGraphFilter = {
  type: "revenue" | "headcount" | "category" | "customerType";
  key?: string;
  label: string;
} | null;

function PerformanceGraph({
  activeData,
  compareData,
  compareLabel,
  periodLabel,
  isLiveToday,
  isSingleDay,
  graphFilter,
  onClearFilter,
  voucherAmount = 0,
  compVoucherAmount = 0,
  bdShift = null,
  chartType: chartTypeProp,
  onChartTypeChange,
}: {
  activeData: Partial<DashboardSummaryData> | null;
  compareData?: DashboardSummaryData | null;
  compareLabel?: string;
  periodLabel: string;
  isLiveToday: boolean;
  isSingleDay: boolean;
  graphFilter: PerfGraphFilter;
  onClearFilter: () => void;
  voucherAmount?: number;
  compVoucherAmount?: number;
  bdShift?: { amount: number; from: string; to: string } | null;
  chartType?: "line" | "bar";
  onChartTypeChange?: (t: "line" | "bar") => void;
}) {
  const [chartTypeState, setChartTypeState] = useState<"line" | "bar">("line");
  const isChartControlled = chartTypeProp !== undefined;
  const chartType = isChartControlled ? chartTypeProp : chartTypeState;
  const setChartType = (t: "line" | "bar") => {
    if (!isChartControlled) setChartTypeState(t);
    onChartTypeChange?.(t);
  };
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const axisColor = isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.45)";
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.1)";
  const tooltipBg = isDark ? "rgba(30,30,40,0.95)" : "rgba(255,255,255,0.97)";
  const tooltipBorder = isDark ? "1px solid rgba(255,255,255,0.1)" : "2px solid rgba(0,0,0,0.7)";
  const tooltipColor = isDark ? "#e2e8f0" : "#1a1a1a";
  const tooltipShadow = isDark ? "none" : "3px 3px 0px rgba(0,0,0,0.5)";

  const hasComparison = !!compareData && !!compareLabel;

  const extractValue = useCallback((data: Partial<DashboardSummaryData> | null, dayEntry: any | null, filter: PerfGraphFilter): number => {
    if (!filter) {
      return dayEntry?.revenue || 0;
    }
    if (filter.type === "headcount") {
      if (filter.key === "kids") return dayEntry?.kids || 0;
      if (filter.key === "adults") return dayEntry?.adults || 0;
      if (filter.key === "total") return (dayEntry?.kids || 0) + (dayEntry?.adults || 0);
      const ct = dayEntry?.customerTypes?.[filter.key!];
      if (ct) return ct.kids + ct.adults;
      return 0;
    }
    if (filter.type === "category") {
      return dayEntry?.categories?.[filter.key!] || 0;
    }
    if (filter.type === "customerType") {
      const ct = dayEntry?.customerTypes?.[filter.key!];
      if (ct) return ct.kids + ct.adults;
      return 0;
    }
    return dayEntry?.revenue || 0;
  }, []);

  const extractHourlyValue = useCallback((bucket: HourlyBucket, filter: PerfGraphFilter): number => {
    if (!filter || filter.type === "revenue") return bucket.revenue;
    if (filter.type === "headcount") {
      if (filter.key === "kids") {
        const allCt = bucket.customerTypes || {};
        return Object.values(allCt).reduce((s, ct) => s + ct.kids, 0) || bucket.ticketsSold;
      }
      if (filter.key === "adults") {
        const allCt = bucket.customerTypes || {};
        return Object.values(allCt).reduce((s, ct) => s + ct.adults, 0);
      }
      if (filter.key === "total") {
        const allCt = bucket.customerTypes || {};
        const total = Object.values(allCt).reduce((s, ct) => s + ct.kids + ct.adults, 0);
        return total || bucket.ticketsSold;
      }
      return bucket.ticketsSold;
    }
    if (filter.type === "category") {
      return bucket.categories?.[filter.key!] || 0;
    }
    if (filter.type === "customerType") {
      const ct = bucket.customerTypes?.[filter.key!];
      if (ct) return ct.kids + ct.adults;
      return 0;
    }
    return bucket.revenue;
  }, []);

  // Proportionally distribute a transient BD shift (e.g. BD→F&B) across
  // per-day/per-hour buckets so the chart's category filter stays in sync with
  // the Revenue by Category card. We only need to touch buckets whose filter
  // key is the shift source or destination.
  const bdShiftActive = !!bdShift && bdShift.amount > 0 && graphFilter?.type === "category"
    && (graphFilter.key === bdShift.from || graphFilter.key === bdShift.to);

  const chartData = useMemo(() => {
    if (isSingleDay) {
      const rawHourly = activeData?.hourlyBreakdown || [];
      const rawCompHourly = compareData?.hourlyBreakdown || [];

      const collapseToHourlyGraph = (buckets: HourlyBucket[]): HourlyBucket[] => {
        const hourMap: Record<number, HourlyBucket> = {};
        for (let h = 0; h < 24; h++) {
          hourMap[h] = { hour: h, label: `${h.toString().padStart(2, "0")}:00`, orders: 0, revenue: 0, ticketsSold: 0, categories: {}, customerTypes: {} };
        }
        if (buckets.length > 24) {
          for (const b of buckets) {
            const h = Math.floor(b.hour / 3);
            if (h < 0 || h > 23) continue;
            hourMap[h].orders += b.orders;
            hourMap[h].revenue += b.revenue;
            hourMap[h].ticketsSold += (b.ticketsSold || 0);
            if (b.categories) {
              for (const [k, v] of Object.entries(b.categories)) {
                hourMap[h].categories![k] = (hourMap[h].categories![k] || 0) + v;
              }
            }
            if (b.customerTypes) {
              for (const [k, v] of Object.entries(b.customerTypes)) {
                if (!hourMap[h].customerTypes![k]) hourMap[h].customerTypes![k] = { kids: 0, adults: 0 };
                hourMap[h].customerTypes![k].kids += v.kids;
                hourMap[h].customerTypes![k].adults += v.adults;
              }
            }
          }
        } else {
          for (const b of buckets) {
            if (b.hour < 0 || b.hour > 23) continue;
            hourMap[b.hour].orders += b.orders;
            hourMap[b.hour].revenue += b.revenue;
            hourMap[b.hour].ticketsSold += (b.ticketsSold || 0);
            if (b.categories) {
              for (const [k, v] of Object.entries(b.categories)) {
                hourMap[b.hour].categories![k] = (hourMap[b.hour].categories![k] || 0) + v;
              }
            }
            if (b.customerTypes) {
              for (const [k, v] of Object.entries(b.customerTypes)) {
                if (!hourMap[b.hour].customerTypes![k]) hourMap[b.hour].customerTypes![k] = { kids: 0, adults: 0 };
                hourMap[b.hour].customerTypes![k].kids += v.kids;
                hourMap[b.hour].customerTypes![k].adults += v.adults;
              }
            }
          }
        }
        return Object.values(hourMap).sort((a, b) => a.hour - b.hour);
      };

      const hourly = collapseToHourlyGraph(rawHourly).filter((h) => h.hour >= 8 && h.hour <= 21);
      const compHourly = collapseToHourlyGraph(rawCompHourly);
      const rows = hourly.map((h) => {
        const compBucket = compHourly.find((c) => c.hour === h.hour);
        return {
          xKey: h.hour,
          xLabel: h.label,
          current: extractHourlyValue(h, graphFilter),
          compare: compBucket ? extractHourlyValue(compBucket, graphFilter) : null,
          _fromVal: bdShiftActive && bdShift ? (h.categories?.[bdShift.from] || 0) : 0,
        };
      });
      return applyBdShiftToRows(rows);
    } else {
      const daily = activeData?.dailyRevenue || [];
      const compDaily = compareData?.dailyRevenue || [];
      const rows = daily.map((d, i) => {
        const compEntry = compDaily[i] || null;
        const dateObj = new Date(d.date + "T12:00:00");
        const dayLabel = `${dateObj.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 3)} ${dateObj.getDate()}`;
        return {
          xKey: i + 1,
          xLabel: dayLabel,
          date: d.date,
          current: extractValue(activeData, d, graphFilter),
          compare: compEntry ? extractValue(compareData ?? null, compEntry, graphFilter) : null,
          _fromVal: bdShiftActive && bdShift ? (d.categories?.[bdShift.from] || 0) : 0,
        };
      });
      return applyBdShiftToRows(rows);
    }

    function applyBdShiftToRows<T extends { current: number; _fromVal?: number }>(rows: T[]): T[] {
      if (!bdShiftActive || !bdShift) return rows;
      const totalFrom = rows.reduce((s, r) => s + (r._fromVal || 0), 0);
      if (totalFrom <= 0) return rows;
      const shiftCap = Math.min(bdShift.amount, totalFrom);
      const dir = graphFilter!.key === bdShift.from ? -1 : 1;
      return rows.map((r) => {
        const share = ((r._fromVal || 0) / totalFrom) * shiftCap;
        return { ...r, current: Math.max(0, (r.current || 0) + dir * share) };
      });
    }
  }, [activeData, compareData, isSingleDay, graphFilter, extractValue, extractHourlyValue, bdShiftActive, bdShift]);

  const totalCurrentGross = useMemo(() => chartData.reduce((s, d) => s + (d.current || 0), 0), [chartData]);
  const totalCompareGross = useMemo(() => hasComparison ? chartData.reduce((s, d) => s + (d.compare || 0), 0) : 0, [chartData, hasComparison]);
  const isOverallRevenue = !graphFilter || graphFilter.type === "revenue";
  const isRevenueMetric = isOverallRevenue || graphFilter?.type === "category";
  const totalCurrent = totalCurrentGross;
  const totalCompare = totalCompareGross;
  const totalChange = totalCompare > 0 ? ((totalCurrent - totalCompare) / totalCompare) * 100 : 0;

  const isCountMetric = graphFilter?.type === "headcount" || graphFilter?.type === "customerType";
  const yFormat = isCountMetric
    ? (v: number) => `${v}`
    : (v: number) => `฿${(v / 1000).toFixed(0)}k`;
  const valueFormat = isCountMetric
    ? (v: number) => `${v.toLocaleString()}`
    : (v: number) => `฿${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const filterLabel = graphFilter ? graphFilter.label : "Revenue";

  const noData = chartData.length === 0;

  // Only surface the orange banner when an explicit non-revenue filter is set:
  // the default view is already labelled "Revenue" by the totals strip.
  const showFilterBanner = !!graphFilter && graphFilter.type !== "revenue";

  return (
    <div className="space-y-3">
      {showFilterBanner && (
        <div className="flex items-center justify-between gap-2 bg-orange-500/10 dark:bg-orange-500/15 border border-orange-500/30 rounded-xl px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
            <span className="text-sm font-bold text-orange-700 dark:text-orange-400">
              Showing: {filterLabel}
            </span>
          </div>
          <button
            onClick={onClearFilter}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-orange-500/20 text-orange-700 dark:text-orange-400 hover:bg-orange-500/30 transition-colors"
            data-testid="btn-perf-clear-filter"
          >
            Clear
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span
            className="dash-row-value-emph text-emerald-700 dark:text-emerald-400 privacy-sensitive"
            data-testid="perf-current-total"
          >
            {valueFormat(totalCurrent)}
          </span>
          {hasComparison && (
            <>
              <span className="dash-meta">vs</span>
              <span
                className="dash-row-value-emph text-violet-700 dark:text-violet-400 privacy-sensitive"
                data-testid="perf-compare-total"
              >
                {valueFormat(totalCompare)}
              </span>
              {totalCompare > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded-md text-[11px] font-bold",
                    totalChange >= 0
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400",
                  )}
                  data-testid="perf-change-badge"
                >
                  {totalChange >= 0 ? "+" : ""}{totalChange.toFixed(1)}%
                </span>
              )}
            </>
          )}
        </div>
        {!isChartControlled && (
          <div className="dash-segmented" role="tablist" aria-label="Chart type">
            <button
              type="button"
              className="dash-segmented-btn"
              data-active={chartType === "line"}
              onClick={() => setChartType("line")}
              data-testid="btn-perf-line"
              aria-label="Line chart"
            >
              <LineChartLucide className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="dash-segmented-btn"
              data-active={chartType === "bar"}
              onClick={() => setChartType("bar")}
              data-testid="btn-perf-bar"
              aria-label="Bar chart"
            >
              <BarChartLucide className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {noData ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          No data available for this period
        </div>
      ) : (
        <div className="neu-inset rounded-2xl p-3">
          <ResponsiveContainer width="100%" height={220}>
            {chartType === "line" ? (
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="xLabel"
                  tick={{ fontSize: 9, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                  interval={isSingleDay ? (chartData.length > 24 ? 2 : 0) : Math.max(0, Math.floor(chartData.length / 15))}
                />
                <YAxis
                  tickFormatter={yFormat}
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: tooltipBg,
                    border: tooltipBorder,
                    borderRadius: isDark ? "12px" : "10px",
                    fontSize: 12,
                    padding: "8px 12px",
                    color: tooltipColor,
                    boxShadow: tooltipShadow,
                  }}
                  labelStyle={{ color: tooltipColor }}
                  itemStyle={{ color: tooltipColor }}
                  formatter={(v: any, name: string) => {
                    if (v === null || v === undefined) return ["-", name];
                    const label = name === "current" ? periodLabel : (compareLabel || "Compare");
                    return [valueFormat(Number(v)), label];
                  }}
                />
                <Line type="monotone" dataKey="current" stroke="#10b981" strokeWidth={2.5} dot={{ r: 2.5, fill: "#10b981" }} activeDot={{ r: 5, fill: "#10b981", stroke: "#fff", strokeWidth: 2 }} connectNulls={false} />
                {hasComparison && (
                  <Line type="monotone" dataKey="compare" stroke="#a78bfa" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 2, fill: "#a78bfa" }} activeDot={{ r: 4, fill: "#a78bfa", stroke: "#fff", strokeWidth: 2 }} connectNulls={false} />
                )}
              </LineChart>
            ) : (
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="xLabel"
                  tick={{ fontSize: 9, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                  interval={isSingleDay ? (chartData.length > 24 ? 2 : 0) : Math.max(0, Math.floor(chartData.length / 15))}
                />
                <YAxis
                  tickFormatter={yFormat}
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: tooltipBg,
                    border: tooltipBorder,
                    borderRadius: isDark ? "12px" : "10px",
                    fontSize: 12,
                    padding: "8px 12px",
                    color: tooltipColor,
                    boxShadow: tooltipShadow,
                  }}
                  labelStyle={{ color: tooltipColor }}
                  itemStyle={{ color: tooltipColor }}
                  formatter={(v: any, name: string) => {
                    if (v === null || v === undefined) return ["-", name];
                    const label = name === "current" ? periodLabel : (compareLabel || "Compare");
                    return [valueFormat(Number(v)), label];
                  }}
                />
                <Bar dataKey="current" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={16} />
                {hasComparison && (
                  <Bar dataKey="compare" fill="#a78bfa" radius={[4, 4, 0, 0]} maxBarSize={16} opacity={0.6} />
                )}
              </BarChart>
            )}
          </ResponsiveContainer>

          <div className="flex items-center justify-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <div className="w-3 h-2 rounded-sm bg-emerald-500" />
              {periodLabel}
            </div>
            {hasComparison && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="w-3 h-0.5 rounded-sm bg-violet-400 border-t border-dashed border-violet-400" style={{ borderTopWidth: 2 }} />
                {compareLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function getTodayPeriodDatesWithOffset(
  period: TodayPeriod,
  offset: number,
  customDateRange?: { from: Date; to?: Date } | null,
): { start: string; end: string; label: string } {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  if (period === "custom" && customDateRange) {
    const from = new Date(customDateRange.from);
    const to = customDateRange.to ? new Date(customDateRange.to) : new Date(from);
    const rangeDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    const shiftedFrom = new Date(from);
    shiftedFrom.setDate(shiftedFrom.getDate() + offset * (rangeDays + 1));
    const shiftedTo = new Date(to);
    shiftedTo.setDate(shiftedTo.getDate() + offset * (rangeDays + 1));
    if (fmt(shiftedFrom) === fmt(shiftedTo)) {
      const label = `${DAY_NAMES[shiftedFrom.getDay()]}, ${shiftedFrom.getDate()} ${MONTH_LABELS[shiftedFrom.getMonth()]} ${shiftedFrom.getFullYear()}`;
      return { start: fmt(shiftedFrom), end: fmt(shiftedTo), label };
    }
    const label = `${shiftedFrom.getDate()} ${MONTH_LABELS[shiftedFrom.getMonth()]} – ${shiftedTo.getDate()} ${MONTH_LABELS[shiftedTo.getMonth()]} ${shiftedTo.getFullYear()}`;
    return { start: fmt(shiftedFrom), end: fmt(shiftedTo), label };
  }
  if (period === "today") {
    const target = new Date(now);
    target.setDate(target.getDate() + offset);
    const label =
      offset === 0
        ? `Today — ${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`
        : `${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`;
    return { start: fmt(target), end: fmt(target), label };
  }
  if (period === "yesterday") {
    const target = new Date(now);
    target.setDate(target.getDate() - 1 + offset);
    const label =
      offset === 0
        ? `Yesterday — ${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`
        : `${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`;
    return { start: fmt(target), end: fmt(target), label };
  }
  if (period === "week") {
    const target = new Date(now);
    target.setDate(target.getDate() + offset * 7);
    const dayOfWeek = target.getDay();
    const mondayOff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(target);
    monday.setDate(target.getDate() - mondayOff);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const endDate = offset === 0 ? now : sunday;
    const label =
      offset === 0
        ? `This Week — ${monday.getDate()} ${MONTH_LABELS[monday.getMonth()]} – ${endDate.getDate()} ${MONTH_LABELS[endDate.getMonth()]}`
        : `${monday.getDate()} ${MONTH_LABELS[monday.getMonth()]} – ${sunday.getDate()} ${MONTH_LABELS[sunday.getMonth()]} ${sunday.getFullYear()}`;
    return { start: fmt(monday), end: fmt(endDate), label };
  }
  if (period === "month") {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1, 12, 0, 0);
    const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12, 0, 0);
    const endDate = offset === 0 ? now : monthEnd;
    const label =
      offset === 0
        ? `This Month — ${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`
        : `${MONTH_LABELS[target.getMonth()]} ${target.getFullYear()}`;
    return { start: fmt(target), end: fmt(endDate), label };
  }
  return { start: fmt(now), end: fmt(now), label: fmt(now) };
}

const HEATMAP_LEVELS = [
  { min: 0, max: 0, light: "transparent", dark: "transparent" },
  {
    min: 1,
    max: 0.15,
    light: "rgba(16,185,129,0.15)",
    dark: "rgba(52,211,153,0.12)",
  },
  {
    min: 0.15,
    max: 0.3,
    light: "rgba(16,185,129,0.3)",
    dark: "rgba(52,211,153,0.22)",
  },
  {
    min: 0.3,
    max: 0.5,
    light: "rgba(16,185,129,0.48)",
    dark: "rgba(52,211,153,0.35)",
  },
  {
    min: 0.5,
    max: 0.7,
    light: "rgba(16,185,129,0.65)",
    dark: "rgba(52,211,153,0.5)",
  },
  {
    min: 0.7,
    max: 0.85,
    light: "rgba(5,150,105,0.78)",
    dark: "rgba(16,185,129,0.65)",
  },
  {
    min: 0.85,
    max: 1.01,
    light: "rgba(4,120,87,0.9)",
    dark: "rgba(16,185,129,0.82)",
  },
];

function getHeatLevel(
  revenue: number,
  maxRevenue: number,
): (typeof HEATMAP_LEVELS)[0] {
  if (!maxRevenue || revenue <= 0) return HEATMAP_LEVELS[0];
  const pct = Math.min(revenue / maxRevenue, 1);
  for (let i = HEATMAP_LEVELS.length - 1; i >= 1; i--) {
    if (pct >= HEATMAP_LEVELS[i].min) return HEATMAP_LEVELS[i];
  }
  return HEATMAP_LEVELS[1];
}

type HeatmapMode = "revenue" | "forecast" | "stly";

const FORECAST_HEAT_COLORS = {
  none: { light: "transparent", dark: "transparent" },
  bad:  { light: "rgba(220,38,38,0.65)", dark: "rgba(239,68,68,0.55)" },
  low:  { light: "rgba(249,115,22,0.60)", dark: "rgba(251,146,60,0.50)" },
  ok:   { light: "rgba(234,179,8,0.55)", dark: "rgba(250,204,21,0.45)" },
  good: { light: "rgba(5,150,105,0.78)", dark: "rgba(16,185,129,0.65)" },
  great:{ light: "rgba(4,120,87,0.90)", dark: "rgba(16,185,129,0.82)" },
};

function getForecastHeatColor(revenue: number, dateStr: string, activeBranches?: ActiveBranches): { light: string; dark: string } {
  if (revenue <= 0) return FORECAST_HEAT_COLORS.none;
  const fc = getForecastForDate(dateStr, activeBranches);
  if (fc.totalRevenue <= 0) return FORECAST_HEAT_COLORS.none;
  const pct = revenue / fc.totalRevenue;
  if (pct >= 1.1) return FORECAST_HEAT_COLORS.great;
  if (pct >= 0.9) return FORECAST_HEAT_COLORS.good;
  if (pct >= 0.7) return FORECAST_HEAT_COLORS.ok;
  if (pct >= 0.5) return FORECAST_HEAT_COLORS.low;
  return FORECAST_HEAT_COLORS.bad;
}

function getSTLYDateStr(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setFullYear(d.getFullYear() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getSTLYHeatColor(
  revenue: number,
  dateStr: string,
  revenueMap: Map<string, { revenue: number; orders: number }>
): { light: string; dark: string } {
  if (revenue <= 0) return FORECAST_HEAT_COLORS.none;
  const lastYearDate = getSTLYDateStr(dateStr);
  const lastYearData = revenueMap.get(lastYearDate);
  if (!lastYearData || lastYearData.revenue <= 0) return FORECAST_HEAT_COLORS.none;
  const pct = revenue / lastYearData.revenue;
  if (pct >= 1.1) return FORECAST_HEAT_COLORS.great;
  if (pct >= 0.9) return FORECAST_HEAT_COLORS.good;
  if (pct >= 0.7) return FORECAST_HEAT_COLORS.ok;
  if (pct >= 0.5) return FORECAST_HEAT_COLORS.low;
  return FORECAST_HEAT_COLORS.bad;
}

const DOW_LABELS_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const fmtBahtShort = (v: number) =>
  v >= 1000000 ? `${(v / 1000000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0);

// Small ⓘ icon beside the Pace value. Desktop: hover opens a tooltip-style
// popover, click pins it open. Mobile: tap opens the same popover.
function PaceInfoPopover({ pace, target, testId }: { pace: SmartPaceForecast; target: number; testId: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const cmp = comparePaceToTarget(pace.forecastRevenue, target);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPinned(false);
      }}
    >
      <PopoverTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label="Forecast details"
          className="inline-flex align-middle cursor-pointer text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (open && !pinned) {
              setPinned(true);
            } else if (open && pinned) {
              setPinned(false);
              setOpen(false);
            } else {
              setPinned(true);
              setOpen(true);
            }
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => {
            if (!pinned) setOpen(false);
          }}
          data-testid={testId}
        >
          <Info className="h-3 w-3" />
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3 text-left"
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
      >
        <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
          Month-End Forecast
        </p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mb-2">
          <span className="text-muted-foreground">Forecast</span>
          <span className="font-bold text-right" data-testid={`${testId}-forecast`}>฿{fmtBahtShort(pace.forecastRevenue)}</span>
          {target > 0 && (
            <>
              <span className="text-muted-foreground">Target</span>
              <span className="font-semibold text-right">฿{fmtBahtShort(target)}</span>
              {cmp && (
                <>
                  <span className="text-muted-foreground">Variance</span>
                  <span className="font-semibold text-right" style={{ color: cmp.color }}>
                    {cmp.pctDiff >= 0 ? "+" : ""}{cmp.pctDiff.toFixed(1)}%
                  </span>
                </>
              )}
            </>
          )}
          <span className="text-muted-foreground">Current revenue</span>
          <span className="font-semibold text-right">฿{fmtBahtShort(pace.revenueToDate)}</span>
          <span className="text-muted-foreground">Average / day</span>
          <span className="font-semibold text-right">฿{fmtBahtShort(pace.avgDailyRevenue)}</span>
          <span className="text-muted-foreground">Remaining days</span>
          <span className="font-semibold text-right">{pace.remainingDays}{pace.todayIsPartial ? " (+today)" : ""}</span>
        </div>
        <p className="text-[10px] text-muted-foreground border-t border-border/50 pt-2">
          <span className="font-semibold">Model:</span> {pace.modelLabel}
        </p>
        <p className="text-[10px] text-muted-foreground mt-1 leading-snug" data-testid={`${testId}-explanation`}>
          {pace.explanation}
        </p>
      </PopoverContent>
    </Popover>
  );
}

// --- Pace forecast accuracy tracking ---------------------------------------

function getPaceBranchKey(activeBranches?: ActiveBranches): string {
  const hasChalong = activeBranches?.has("chalong");
  const hasFloresta = !activeBranches || activeBranches.has("floresta");
  if (hasChalong && hasFloresta) return "all";
  if (hasChalong) return "chalong";
  return "floresta";
}

interface PaceSnapshot {
  date: string;
  forecastRevenue: number;
  revenueToDate: number;
  elapsedDays: number;
  target: number | null;
  model: string | null;
}

// Guard so we only POST one snapshot per day+branch per page session.
const recordedPaceSnapshots = new Set<string>();

/** Records a daily snapshot of the current-month forecast so closed months
 *  can later show how accurate the projection turned out to be. */
function useRecordPaceSnapshot(
  pace: SmartPaceForecast | null,
  target: number,
  branchKey: string,
  todayStr: string,
) {
  useEffect(() => {
    if (!pace || !(pace.forecastRevenue > 0)) return;
    const key = `${todayStr}|${branchKey}`;
    if (recordedPaceSnapshots.has(key)) return;
    recordedPaceSnapshots.add(key);
    apiRequest("POST", "/api/pace-snapshots", {
      date: todayStr,
      branch: branchKey,
      forecastRevenue: pace.forecastRevenue,
      revenueToDate: pace.revenueToDate,
      elapsedDays: pace.elapsedDays,
      target: target > 0 ? target : null,
      model: pace.model,
    }).catch(() => {
      recordedPaceSnapshots.delete(key);
    });
  }, [pace, target, branchKey, todayStr]);
}

/** Picks the snapshot to grade a closed month by: the one taken closest to
 *  mid-month (day 15), where the forecast still had real work to do. */
function pickAccuracySnapshot(snapshots: PaceSnapshot[]): PaceSnapshot | null {
  if (!snapshots.length) return null;
  let best: PaceSnapshot | null = null;
  let bestDist = Infinity;
  for (const s of snapshots) {
    const day = parseInt(s.date.slice(8, 10), 10);
    if (!Number.isFinite(day)) continue;
    const dist = Math.abs(day - 15);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

// In the both-branches view the calendar's revenueMap mixes scopes: this
// year's dates hold Floresta+Chalong combined revenue, but last year's dates
// hold Chalong-only STLY data (Floresta has no LY history). Letting the smart
// pace model blend combined TY days against Chalong-only LY days drags the
// forecast down ~20%, so hide dates older than 180 days from the model in
// that view (its weekday patterns only look 56 days back, so they are
// unaffected; only the LY growth/blend signals are disabled).
function makeScopedPaceCallbacks(
  revenueMap: Map<string, { revenue: number; orders: number }>,
  todayStr: string,
  hasBothBranches: boolean,
) {
  const d = new Date(todayStr + "T12:00:00");
  d.setDate(d.getDate() - 180);
  const lyCutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sameScope = (ds: string) => !hasBothBranches || ds >= lyCutoff;
  return {
    getRevenue: (ds: string) => (sameScope(ds) ? revenueMap.get(ds)?.revenue || 0 : 0),
    hasData: (ds: string) => sameScope(ds) && revenueMap.has(ds),
  };
}

function MiniMonthGrid({
  month,
  year,
  revenueMap,
  maxRevenue,
  todayStr,
  calendarNotes,
  onDayClick,
  onDayHover,
  onDayLeave,
  onMonthClick,
  heatmapMode = "revenue",
  activeBranches,
  birthdayMap,
}: {
  month: number;
  year: number;
  revenueMap: Map<string, { revenue: number; orders: number }>;
  maxRevenue: number;
  todayStr: string;
  calendarNotes?: Record<string, string>;
  onDayClick: (dateStr: string) => void;
  onDayHover: (e: React.MouseEvent, dateStr: string) => void;
  onDayLeave: () => void;
  onMonthClick: (month: number, year: number) => void;
  heatmapMode?: HeatmapMode;
  activeBranches?: ActiveBranches;
  birthdayMap?: Map<string, StaffBirthday[]>;
}) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = (new Date(year, month, 1).getDay() + 6) % 7;

  const cells: Array<{ day: number; dateStr: string } | null> = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      day,
      dateStr: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    });
  }

  const monthRevenue = useMemo(() => {
    let total = 0;
    for (const cell of cells) {
      if (cell) {
        const d = revenueMap.get(cell.dateStr);
        if (d) total += d.revenue;
      }
    }
    return total;
  }, [cells, revenueMap]);

  const isChalongOnly = activeBranches && activeBranches.has("chalong") && !activeBranches.has("floresta");
  const hasBothBranches = activeBranches && activeBranches.has("chalong") && activeBranches.has("floresta");

  const monthForecast = useMemo(() => {
    if (isChalongOnly) return { totalRevenue: 0, categories: [] };
    const startStr = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const forecastBranches = hasBothBranches ? new Set(["floresta"]) : activeBranches;
    return getForecastForDateRange(startStr, endStr, forecastBranches);
  }, [month, year, activeBranches, isChalongOnly, hasBothBranches]);

  const stlyMonthRevenue = useMemo(() => {
    if (!isChalongOnly && !hasBothBranches) return 0;
    let total = 0;
    const lastYear = year - 1;
    const lyMonth = String(month + 1).padStart(2, "0");
    const lyDays = new Date(lastYear, month + 1, 0).getDate();
    for (let d = 1; d <= lyDays; d++) {
      const lyDate = `${lastYear}-${lyMonth}-${String(d).padStart(2, "0")}`;
      const data = revenueMap.get(lyDate);
      if (data) total += data.revenue;
    }
    return total;
  }, [month, year, revenueMap, isChalongOnly, hasBothBranches]);

  // Pace forecast: projected end-of-month revenue if the current daily pace
  // continues (only meaningful for the current month).
  const paceForecast = useMemo(() => {
    const today = new Date(todayStr + "T12:00:00");
    if (month !== today.getMonth() || year !== today.getFullYear()) return null;
    if (monthRevenue <= 0) return null;
    const scoped = makeScopedPaceCallbacks(revenueMap, todayStr, !!hasBothBranches);
    return computeSmartPaceForecast({
      year,
      month,
      daysInMonth,
      todayStr,
      getRevenue: scoped.getRevenue,
      hasData: scoped.hasData,
      isEventDay: hasAnyHoliday,
    });
  }, [month, year, todayStr, monthRevenue, daysInMonth, revenueMap, hasBothBranches]);

  const monthTarget = isChalongOnly
    ? stlyMonthRevenue
    : monthForecast.totalRevenue + (hasBothBranches ? stlyMonthRevenue : 0);

  useRecordPaceSnapshot(paceForecast, monthTarget, getPaceBranchKey(activeBranches), todayStr);

  const forecastPct = monthTarget > 0 && monthRevenue > 0
    ? (monthRevenue / monthTarget) * 100
    : 0;

  return (
    <div
      className="neu-card p-3 overflow-hidden neu-card-interactive"
      data-testid={`heatmap-month-${year}-${month}`}
    >
      <button
        className="w-full text-center mb-2 group/mh cursor-pointer"
        onClick={() => onMonthClick(month, year)}
        data-testid={`btn-month-${year}-${month}`}
      >
        <h4 className="text-sm font-bold tracking-wide group-hover/mh:text-emerald-600 dark:group-hover/mh:text-emerald-400 transition-colors">
          {MONTH_NAMES_FULL[month]}{" "}
          <span className="text-muted-foreground font-medium">{year}</span>
        </h4>
        <div>
          {monthRevenue > 0 ? (
            <>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                ฿
                {monthRevenue >= 1000000
                  ? `${(monthRevenue / 1000000).toFixed(1)}M`
                  : `${(monthRevenue / 1000).toFixed(0)}k`}
                {monthTarget > 0 && (
                  <span className="text-muted-foreground font-normal ml-1">
                    / ฿{monthTarget >= 1000000
                      ? `${(monthTarget / 1000000).toFixed(1)}M`
                      : `${(monthTarget / 1000).toFixed(0)}k`}
                  </span>
                )}
              </p>
              {paceForecast && (() => {
                const cmp = comparePaceToTarget(paceForecast.forecastRevenue, monthTarget);
                const fv = paceForecast.forecastRevenue;
                return (
                  <p
                    className="text-[10px] text-muted-foreground"
                    data-testid={`text-pace-forecast-${year}-${month}`}
                  >
                    Pace: ฿{fv >= 1000000 ? `${(fv / 1000000).toFixed(2)}M` : `${(fv / 1000).toFixed(0)}k`}
                    {cmp && (
                      <>
                        {" "}
                        <span style={{ fontWeight: 600, color: cmp.color }}>
                          ({cmp.pctDiff >= 0 ? "+" : ""}{cmp.pctDiff.toFixed(1)}%)
                        </span>
                      </>
                    )}{" "}
                    <PaceInfoPopover
                      pace={paceForecast}
                      target={monthTarget}
                      testId={`btn-pace-info-${year}-${month}`}
                    />
                  </p>
                );
              })()}
              {forecastPct > 0 && (
                <>
                  <div className="mt-1 mx-auto w-4/5 h-1.5 rounded-full bg-muted/50 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(forecastPct, 100)}%`,
                        backgroundColor: forecastPct >= 90 ? '#10b981' : forecastPct >= 70 ? '#f59e0b' : '#ef4444',
                      }}
                    />
                  </div>
                  <p className="text-[10px] font-medium mt-0.5" style={{
                    color: forecastPct >= 90 ? '#10b981' : forecastPct >= 70 ? '#f59e0b' : '#ef4444',
                  }}>
                    {forecastPct.toFixed(0)}% of target
                  </p>
                </>
              )}
            </>
          ) : (
            !isChalongOnly && (
              <p className="text-[10px] text-muted-foreground">
                Target: ฿{monthForecast.totalRevenue >= 1000000
                  ? `${(monthForecast.totalRevenue / 1000000).toFixed(1)}M`
                  : `${(monthForecast.totalRevenue / 1000).toFixed(0)}k`}
              </p>
            )
          )}
        </div>
      </button>
      <div className="grid grid-cols-7 gap-[3px]">
        {DOW_LABELS_SHORT.map((d) => (
          <div
            key={d}
            className="text-[9px] font-semibold text-muted-foreground/75 text-center uppercase"
          >
            {d}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={`e-${i}`} className="aspect-square" />;
          const { day, dateStr } = cell;
          const holiday = getHolidayForDate(dateStr);
          const hc = holiday ? HOLIDAY_COLORS[holiday.type] : null;
          const isIntlSchool = INTL_SCHOOL_LOOKUP.has(dateStr);
          const anyHoliday = holiday || isIntlSchool;
          const dayData = revenueMap.get(dateStr);
          const rev = dayData?.revenue || 0;
          const heat = getHeatLevel(rev, maxRevenue);
          const compHeat = heatmapMode === "forecast"
            ? (() => {
                if (hasBothBranches) {
                  const fc = getForecastForDate(dateStr, new Set(["floresta"]));
                  const lyDate = getSTLYDateStr(dateStr);
                  const lyData = revenueMap.get(lyDate);
                  const target = fc.totalRevenue + (lyData?.revenue || 0);
                  if (rev <= 0 || target <= 0) return FORECAST_HEAT_COLORS.none;
                  const pct = rev / target;
                  return pct >= 1.1 ? FORECAST_HEAT_COLORS.great : pct >= 0.9 ? FORECAST_HEAT_COLORS.good : pct >= 0.7 ? FORECAST_HEAT_COLORS.ok : pct >= 0.5 ? FORECAST_HEAT_COLORS.low : FORECAST_HEAT_COLORS.bad;
                }
                return getForecastHeatColor(rev, dateStr, activeBranches);
              })()
            : heatmapMode === "stly"
            ? getSTLYHeatColor(rev, dateStr, revenueMap)
            : null;
          const isToday = dateStr === todayStr;
          const isFuture = dateStr > todayStr;
          const hasNote = calendarNotes && calendarNotes[dateStr];
          const isDarkMode =
            document.documentElement.classList.contains("dark");
          const bgColor = rev > 0
            ? (compHeat ? (isDarkMode ? compHeat.dark : compHeat.light) : (isDarkMode ? heat.dark : heat.light))
            : undefined;

          return (
            <div
              key={dateStr}
              className={cn(
                "heatmap-cell aspect-square rounded-[3px] flex items-center justify-center relative cursor-pointer group text-[11px] font-semibold leading-none select-none",
                isFuture && !anyHoliday && "opacity-40",
                isToday &&
                  "ring-[1.5px] ring-blue-500 ring-offset-1 ring-offset-background z-10",
                !rev && !anyHoliday && "bg-muted/40 dark:bg-muted/20",
                !rev && !holiday && isIntlSchool && HOLIDAY_COLORS.intl_school.bg,
                holiday && !rev && hc?.bg,
              )}
              style={bgColor ? { backgroundColor: bgColor } : undefined}
              onClick={() => onDayClick(dateStr)}
              onMouseEnter={(e) => onDayHover(e, dateStr)}
              onMouseLeave={onDayLeave}
              data-testid={`heatcell-${dateStr}`}
            >
              <span
                className={cn(
                  isToday
                    ? "text-blue-600 dark:text-blue-400 font-bold"
                    : rev > 0 &&
                        heat === HEATMAP_LEVELS[HEATMAP_LEVELS.length - 1]
                      ? "text-white dark:text-emerald-100 font-bold"
                      : rev > 0 &&
                          heat === HEATMAP_LEVELS[HEATMAP_LEVELS.length - 2]
                        ? "text-white dark:text-emerald-200 font-bold"
                        : holiday
                          ? hc?.text?.split(" ")[0] || "text-foreground/90"
                          : "text-foreground/85",
                )}
              >
                {day}
              </span>
              {holiday && (
                <span
                  className={cn(
                    "absolute rounded-full",
                    holiday.type === "milestone"
                      ? "top-[0px] right-[0px] w-[7px] h-[7px] ring-1 ring-yellow-300 dark:ring-yellow-500/60"
                      : "top-[1px] right-[1px] w-[5px] h-[5px]",
                    hc?.dot,
                    holiday.type === "kid" && "bg-amber-400",
                  )}
                />
              )}
              {isIntlSchool && (
                <span
                  className={cn(
                    "absolute rounded-full bg-purple-500",
                    holiday
                      ? "top-[1px] right-[7px] w-[4px] h-[4px]"
                      : "top-[1px] right-[1px] w-[5px] h-[5px]",
                  )}
                />
              )}
              {hasNote && (
                <span className="absolute bottom-[1px] left-[1px] w-[4px] h-[4px] rounded-full bg-amber-400" />
              )}
              {birthdayMap && birthdayMap.has(dateStr.slice(5)) && (
                <span
                  className="absolute bottom-[1px] right-[1px] w-[5px] h-[5px] rounded-full bg-pink-500"
                  title={`🎂 ${birthdayMap.get(dateStr.slice(5))!.map((b) => b.name).join(", ")}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailedMonthView({
  month,
  year,
  revenueMap,
  maxRevenue,
  todayStr,
  calendarNotes,
  onDayClick,
  onBack,
  heatmapMode = "revenue",
  activeBranches,
  getEventsForDate,
}: {
  month: number;
  year: number;
  revenueMap: Map<string, { revenue: number; orders: number }>;
  maxRevenue: number;
  todayStr: string;
  calendarNotes?: Record<string, string>;
  onDayClick: (dateStr: string) => void;
  onBack: () => void;
  heatmapMode?: HeatmapMode;
  activeBranches?: ActiveBranches;
  getEventsForDate: (date: string) => Array<{ name: string; type: HolidayType }>;
}) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = (new Date(year, month, 1).getDay() + 6) % 7;

  const cells: Array<{ day: number; dateStr: string } | null> = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      day,
      dateStr: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    });
  }

  const monthHolidays = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ date: string; name: string; type: HolidayType }> = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const all = getEventsForDate(dateStr);
      for (const h of all) {
        const key = h.type === "birthday" ? `bd-${dateStr}` : h.name.replace(/ \(.*\)/, "").replace(/ \d+$/, "");
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ date: dateStr, ...h });
        }
      }
    }
    return result;
  }, [month, year, daysInMonth, getEventsForDate]);

  const monthStats = useMemo(() => {
    let totalRev = 0,
      totalOrders = 0,
      days = 0,
      best = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const d = revenueMap.get(dateStr);
      if (d && d.revenue > 0) {
        totalRev += d.revenue;
        totalOrders += d.orders;
        days++;
        if (d.revenue > best) best = d.revenue;
      }
    }
    return {
      totalRev,
      totalOrders,
      days,
      best,
      avg: days > 0 ? totalRev / days : 0,
    };
  }, [month, year, daysInMonth, revenueMap]);

  const isChalongOnly = activeBranches && activeBranches.has("chalong") && !activeBranches.has("floresta");
  const hasBothBranches = activeBranches && activeBranches.has("chalong") && activeBranches.has("floresta");

  const detailForecast = useMemo(() => {
    if (isChalongOnly) return { totalRevenue: 0, categories: [] };
    const startStr = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const forecastBranches = hasBothBranches ? new Set(["floresta"]) : activeBranches;
    return getForecastForDateRange(startStr, endStr, forecastBranches);
  }, [month, year, activeBranches, isChalongOnly, hasBothBranches]);

  const detailStlyRevenue = useMemo(() => {
    if (!isChalongOnly && !hasBothBranches) return 0;
    let total = 0;
    const lastYear = year - 1;
    const lyMonth = String(month + 1).padStart(2, "0");
    const lyDays = new Date(lastYear, month + 1, 0).getDate();
    for (let d = 1; d <= lyDays; d++) {
      const lyDate = `${lastYear}-${lyMonth}-${String(d).padStart(2, "0")}`;
      const data = revenueMap.get(lyDate);
      if (data) total += data.revenue;
    }
    return total;
  }, [month, year, revenueMap, isChalongOnly, hasBothBranches]);

  const detailTarget = isChalongOnly
    ? detailStlyRevenue
    : detailForecast.totalRevenue + (hasBothBranches ? detailStlyRevenue : 0);
  const detailForecastPct = detailTarget > 0 && monthStats.totalRev > 0
    ? (monthStats.totalRev / detailTarget) * 100
    : 0;

  // Pace forecast: projected end-of-month revenue if the current daily pace
  // continues (only meaningful for the current month).
  const detailPaceForecast = useMemo(() => {
    const today = new Date(todayStr + "T12:00:00");
    if (month !== today.getMonth() || year !== today.getFullYear()) return null;
    if (monthStats.totalRev <= 0) return null;
    return computeSmartPaceForecast({
      year,
      month,
      daysInMonth,
      todayStr,
      getRevenue: makeScopedPaceCallbacks(revenueMap, todayStr, !!hasBothBranches).getRevenue,
      hasData: makeScopedPaceCallbacks(revenueMap, todayStr, !!hasBothBranches).hasData,
      isEventDay: hasAnyHoliday,
    });
  }, [month, year, todayStr, monthStats.totalRev, daysInMonth, revenueMap, hasBothBranches]);

  const detailBranchKey = getPaceBranchKey(activeBranches);
  useRecordPaceSnapshot(detailPaceForecast, detailTarget, detailBranchKey, todayStr);

  // Future-month baseline (task-162): lets the Planner open for months that
  // haven't started yet. Kept strictly separate from detailPaceForecast so
  // pace snapshots, per-day projections and the pace chart stay
  // current-month-only.
  const isFutureMonth = useMemo(() => {
    const today = new Date(todayStr + "T12:00:00");
    return year > today.getFullYear() ||
      (year === today.getFullYear() && month > today.getMonth());
  }, [year, month, todayStr]);

  const futureMonthBaseline = useMemo(() => {
    if (!isFutureMonth) return null;
    return computeFutureMonthBaseline({
      year,
      month,
      daysInMonth,
      todayStr,
      getRevenue: (d) => revenueMap.get(d)?.revenue || 0,
      hasData: (d) => revenueMap.has(d),
      fallbackRevenue: detailTarget,
    });
  }, [isFutureMonth, year, month, daysInMonth, todayStr, revenueMap, detailTarget]);

  // What the Planner button consumes: real pace for the current month, the
  // synthetic baseline for future months, nothing for past months.
  const plannerPace = detailPaceForecast ?? futureMonthBaseline;

  // Closed month → look up recorded forecast snapshots to grade accuracy.
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const lastDayStr = `${monthKey}-${String(daysInMonth).padStart(2, "0")}`;
  const isClosedMonth = lastDayStr < todayStr;
  const { data: paceSnapshots } = useQuery<PaceSnapshot[]>({
    queryKey: ["/api/pace-snapshots", detailBranchKey, monthKey],
    enabled: isClosedMonth && monthStats.totalRev > 0,
  });
  const forecastAccuracy = useMemo(() => {
    if (!isClosedMonth || monthStats.totalRev <= 0 || !paceSnapshots?.length) return null;
    const snap = pickAccuracySnapshot(paceSnapshots);
    if (!snap || !(snap.forecastRevenue > 0)) return null;
    const actual = monthStats.totalRev;
    const errPct = ((snap.forecastRevenue - actual) / actual) * 100;
    return { snap, actual, errPct, absErr: Math.abs(errPct) };
  }, [isClosedMonth, monthStats.totalRev, paceSnapshots]);

  // Per-future-day projection map for the day cells.
  const projectedByDate = useMemo(() => {
    const m = new Map<string, number>();
    if (detailPaceForecast) {
      for (const p of detailPaceForecast.perDay) m.set(p.date, p.projected);
    }
    return m;
  }, [detailPaceForecast]);

  // Cumulative pace chart data: actual, forecast, and target lines.
  const paceChartData = useMemo(() => {
    if (!detailPaceForecast || !(detailTarget > 0 || monthStats.totalRev > 0)) return null;
    const rows: Array<{ day: number; actual: number | null; forecast: number; target: number | null }> = [];
    const today = new Date(todayStr + "T12:00:00");
    const todayDay = today.getDate();
    let cumActual = 0;
    let cumForecast = 0;
    const targetPerDay = detailTarget > 0 ? detailTarget / daysInMonth : null;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (d <= todayDay) {
        const rev = revenueMap.get(ds)?.revenue || 0;
        cumActual += rev;
        cumForecast = cumActual;
        if (projectedByDate.has(ds)) {
          // Partial today: forecast line continues to today's projection.
          cumForecast += Math.max(0, (projectedByDate.get(ds) || 0) - rev);
        }
      } else {
        cumForecast += projectedByDate.get(ds) || 0;
      }
      rows.push({
        day: d,
        actual: d <= todayDay ? cumActual : null,
        forecast: cumForecast,
        target: targetPerDay !== null ? targetPerDay * d : null,
      });
    }
    return rows;
  }, [detailPaceForecast, detailTarget, monthStats.totalRev, todayStr, daysInMonth, year, month, revenueMap, projectedByDate]);

  const fmtBaht = (v: number) => v >= 1000000 ? `${(v / 1000000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="neu-card overflow-hidden">
        <div className="p-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full btn-press"
                onClick={onBack}
                aria-label="Back to year view"
                data-testid="btn-back-year"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div>
                <h3
                  className="text-lg font-semibold"
                  data-testid="detail-month-title"
                >
                  {MONTH_NAMES_FULL[month]} {year}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isChalongOnly ? "Robinsons Chalong" : activeBranches && activeBranches.has("chalong") && activeBranches.has("floresta") ? "All Branches" : "Central Floresta"} — Monthly Revenue
                </p>
              </div>
            </div>
            {monthStats.totalRev > 0 && (
              <div className="text-right">
                <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                  ฿
                  {monthStats.totalRev >= 1000000
                    ? `${(monthStats.totalRev / 1000000).toFixed(1)}M`
                    : `${(monthStats.totalRev / 1000).toFixed(0)}k`}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {monthStats.days} days · avg ฿
                  {monthStats.avg >= 1000
                    ? `${(monthStats.avg / 1000).toFixed(0)}k`
                    : monthStats.avg.toFixed(0)}
                  /day
                </p>
              </div>
            )}
          </div>
        </div>
        {(monthStats.totalRev > 0 || detailTarget > 0) && (
          <div className="px-4 pb-3">
            <div className="neu-inset rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {isChalongOnly ? "vs Same Time Last Year" : hasBothBranches ? "vs Forecast + STLY" : "vs Model Forecast"}
                </span>
                {plannerPace && (
                  <RevenuePlannerButton
                    pace={plannerPace}
                    monthMode={detailPaceForecast ? "current" : "future"}
                    growthFactor={futureMonthBaseline?.growthFactor ?? null}
                    derivedTarget={detailTarget}
                    branch={hasBothBranches ? "all" : isChalongOnly ? "chalong" : "floresta"}
                    year={year}
                    month={month}
                    daysInMonth={daysInMonth}
                    todayStr={todayStr}
                  />
                )}
                {detailForecastPct > 0 && (
                  <span className="text-xs font-bold" style={{
                    color: detailForecastPct >= 90 ? '#10b981' : detailForecastPct >= 70 ? '#f59e0b' : '#ef4444',
                  }}>
                    {detailForecastPct.toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="h-2.5 rounded-full bg-muted/50 overflow-hidden mb-2">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(detailForecastPct, 100)}%`,
                    backgroundColor: detailForecastPct >= 90 ? '#10b981' : detailForecastPct >= 70 ? '#f59e0b' : '#ef4444',
                  }}
                />
              </div>
              <div className={`grid ${detailPaceForecast ? 'grid-cols-4' : 'grid-cols-3'} gap-2 text-center`}>
                <div>
                  <p className="text-[10px] text-muted-foreground">Actual</p>
                  <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400">฿{fmtBaht(monthStats.totalRev)}</p>
                </div>
                {detailPaceForecast && (() => {
                  const cmp = comparePaceToTarget(detailPaceForecast.forecastRevenue, detailTarget);
                  return (
                    <div data-testid="text-detail-pace-forecast">
                      <p className="text-[10px] text-muted-foreground">
                        Pace{" "}
                        <PaceInfoPopover
                          pace={detailPaceForecast}
                          target={detailTarget}
                          testId="btn-detail-pace-info"
                        />
                      </p>
                      <p className="text-xs font-bold">฿{fmtBaht(detailPaceForecast.forecastRevenue)}</p>
                      {cmp && (
                        <p className="text-[8px] font-semibold" style={{ color: cmp.color }}>
                          {cmp.pctDiff >= 0 ? '+' : ''}{cmp.pctDiff.toFixed(1)}% vs target
                        </p>
                      )}
                    </div>
                  );
                })()}
                <div>
                  <p className="text-[10px] text-muted-foreground">{isChalongOnly ? "Last Year" : "Target"}</p>
                  <p className="text-xs font-bold">฿{fmtBaht(detailTarget)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Gap</p>
                  <p className="text-xs font-bold" style={{
                    color: monthStats.totalRev >= detailTarget ? '#10b981' : '#ef4444',
                  }}>
                    {monthStats.totalRev >= detailTarget ? '+' : '-'}฿{fmtBaht(Math.abs(detailTarget - monthStats.totalRev))}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="px-3 pb-3">
          <div className="grid grid-cols-7 gap-1">
            {DOW_LABELS_SHORT.map((d, i) => (
              <div
                key={`${d}-${i}`}
                className="text-center text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider py-2"
              >
                {d}
              </div>
            ))}
            {cells.map((cell, i) => {
              if (!cell)
                return (
                  <div
                    key={`empty-${i}`}
                    className="min-h-[80px] md:min-h-[100px]"
                  />
                );

              const { day, dateStr } = cell;
              const holiday = getHolidayForDate(dateStr);
              const isIntlSchool = INTL_SCHOOL_LOOKUP.has(dateStr);
              const allHols = getEventsForDate(dateStr);
              const anyHoliday = holiday || isIntlSchool;
              const isPast = dateStr < todayStr;
              const isToday = dateStr === todayStr;
              const isFuture = dateStr > todayStr;
              const dayData = revenueMap.get(dateStr);
              const hColors = holiday ? HOLIDAY_COLORS[holiday.type] : null;
              const hasNote = calendarNotes && calendarNotes[dateStr];
              const rev = dayData?.revenue || 0;
              const revBarPct =
                rev > 0 && maxRevenue > 0
                  ? Math.min((rev / maxRevenue) * 100, 100)
                  : 0;
              const detailFcHeat = heatmapMode === "forecast" && rev > 0
                ? (() => {
                    if (hasBothBranches) {
                      const fc = getForecastForDate(dateStr, new Set(["floresta"]));
                      const lyDate = getSTLYDateStr(dateStr);
                      const lyData = revenueMap.get(lyDate);
                      const target = fc.totalRevenue + (lyData?.revenue || 0);
                      if (target <= 0) return FORECAST_HEAT_COLORS.none;
                      const pct = rev / target;
                      return pct >= 1.1 ? FORECAST_HEAT_COLORS.great : pct >= 0.9 ? FORECAST_HEAT_COLORS.good : pct >= 0.7 ? FORECAST_HEAT_COLORS.ok : pct >= 0.5 ? FORECAST_HEAT_COLORS.low : FORECAST_HEAT_COLORS.bad;
                    }
                    return getForecastHeatColor(rev, dateStr, activeBranches);
                  })()
                : heatmapMode === "stly" && rev > 0
                ? getSTLYHeatColor(rev, dateStr, revenueMap)
                : null;
              const isDark = document.documentElement.classList.contains("dark");
              const detailBgStyle = detailFcHeat
                ? { backgroundColor: isDark ? detailFcHeat.dark : detailFcHeat.light }
                : undefined;

              return (
                <div
                  key={dateStr}
                  className={cn(
                    "min-h-[80px] md:min-h-[100px] p-2 relative rounded-lg cursor-pointer group transition-all duration-150",
                    "hover:bg-muted/50 hover:shadow-sm hover:scale-[1.02]",
                    isToday &&
                      "ring-2 ring-blue-500 bg-blue-500/5 dark:bg-blue-500/10",
                    !isToday && !anyHoliday && !detailFcHeat && "bg-card",
                    holiday && !detailFcHeat && hColors?.bg,
                    !holiday && isIntlSchool && !detailFcHeat && HOLIDAY_COLORS.intl_school.bg,
                    isFuture && !anyHoliday && "opacity-60",
                  )}
                  style={detailBgStyle}
                  title={
                    allHols.map(h => h.name).join(" + ") ||
                    (hasNote ? calendarNotes![dateStr] : undefined)
                  }
                  data-testid={`detail-day-${dateStr}`}
                  onClick={() => onDayClick(dateStr)}
                >
                  <div className="flex items-start justify-between mb-1">
                    <span
                      className={cn(
                        "text-sm font-bold w-6 h-6 flex items-center justify-center rounded-full transition-colors",
                        isToday &&
                          "bg-blue-500 text-white shadow-sm shadow-blue-500/30",
                        !isToday && holiday && hColors?.text,
                        !isToday && !holiday && isIntlSchool && HOLIDAY_COLORS.intl_school.text,
                        !isToday && !anyHoliday && isPast && "text-foreground/80",
                        isFuture && !anyHoliday && "text-muted-foreground",
                      )}
                    >
                      {day}
                    </span>
                    <div className="flex items-center gap-0.5">
                      {hasNote && (
                        <StickyNote className="h-3 w-3 text-amber-500 opacity-70 group-hover:opacity-100 transition-opacity" />
                      )}
                      {holiday && holiday.type === "kid" && (
                        <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                      )}
                      {holiday && holiday.type !== "kid" && (
                        <span
                          className={cn(
                            "w-2 h-2 rounded-full shrink-0",
                            hColors?.dot,
                          )}
                        />
                      )}
                      {isIntlSchool && (
                        <span className="w-2 h-2 rounded-full shrink-0 bg-purple-500" />
                      )}
                    </div>
                  </div>
                  {allHols.length > 0 && (
                    <div className="space-y-0">
                      {allHols.map((h, idx) => (
                        <p
                          key={idx}
                          className={cn(
                            "text-[10px] md:text-xs leading-tight truncate font-medium",
                            HOLIDAY_COLORS[h.type]?.text,
                          )}
                        >
                          {h.name}
                        </p>
                      ))}
                    </div>
                  )}
                  {hasNote && (
                    <p className="text-[10px] md:text-xs leading-tight text-amber-600 dark:text-amber-400 truncate">
                      {calendarNotes![dateStr]}
                    </p>
                  )}
                  {(isPast || isToday) && rev > 0 && (
                    <div className="mt-auto pt-1">
                      <div className="h-1.5 rounded-full neu-inset overflow-hidden mb-0.5">
                        <div
                          className="h-full rounded-full neu-progress-fill"
                          style={{ width: `${revBarPct}%` }}
                        />
                      </div>
                      <p
                        className={cn(
                          "text-xs font-bold truncate metric-value",
                          isToday
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        ฿
                        {rev >= 1000
                          ? `${(rev / 1000).toFixed(0)}k`
                          : rev.toLocaleString(undefined, {
                              maximumFractionDigits: 0,
                            })}
                      </p>
                      {dayData && dayData.orders > 0 && (
                        <p className="text-[10px] md:text-xs text-muted-foreground/70">
                          {dayData.orders} txn
                        </p>
                      )}
                    </div>
                  )}
                  {isFuture && projectedByDate.has(dateStr) && (
                    <div className="mt-auto pt-1">
                      <p
                        className="text-[10px] md:text-xs italic text-muted-foreground/65 truncate"
                        title="Projected revenue (forecast, not actual)"
                        data-testid={`text-projected-${dateStr}`}
                      >
                        ≈฿{(() => {
                          const p = projectedByDate.get(dateStr) || 0;
                          return p >= 1000
                            ? `${(p / 1000).toFixed(0)}k`
                            : p.toLocaleString(undefined, { maximumFractionDigits: 0 });
                        })()}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {forecastAccuracy && (
        <div className="neu-card p-4" data-testid="card-forecast-accuracy">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-500" />
            Forecast Accuracy
          </h4>
          {(() => {
            const { snap, actual, errPct, absErr } = forecastAccuracy;
            const color = absErr <= 5 ? "#10b981" : absErr <= 10 ? "#f59e0b" : "#ef4444";
            const snapDate = new Date(snap.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
            return (
              <>
                <p className="text-xs" data-testid="text-forecast-accuracy">
                  Forecast was within{" "}
                  <span className="font-bold" style={{ color }}>
                    {absErr < 0.05 ? "0.1" : absErr.toFixed(1)}%
                  </span>{" "}
                  of actual — projected ฿{fmtBaht(snap.forecastRevenue)} on {snapDate} (day {snap.elapsedDays || parseInt(snap.date.slice(8, 10), 10)}), month closed at ฿{fmtBaht(actual)}
                  {absErr >= 0.05 ? ` (${errPct > 0 ? "over" : "under"} by ฿${fmtBaht(Math.abs(snap.forecastRevenue - actual))})` : ""}.
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Graded against the daily snapshot recorded closest to mid-month.
                </p>
              </>
            );
          })()}
        </div>
      )}

      {detailPaceForecast && paceChartData && (
        <div className="neu-card p-4" data-testid="card-pace-chart">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            Month Pace
          </h4>
          <p className="text-[10px] text-muted-foreground mb-3">
            Cumulative actual vs forecast{detailTarget > 0 ? " vs target" : ""} across {MONTH_NAMES_FULL[month]}
          </p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={paceChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  width={45}
                  tickFormatter={(v: number) => `฿${fmtBaht(v)}`}
                />
                <Tooltip
                  formatter={(value: any, name: string) => [
                    `฿${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
                    name,
                  ]}
                  labelFormatter={(d) => `${MONTH_NAMES_FULL[month]} ${d}`}
                  contentStyle={{ fontSize: 11, borderRadius: 8 }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="actual" name="Actual" stroke="#10b981" strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="forecast" name="Forecast" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                {detailTarget > 0 && (
                  <Line type="monotone" dataKey="target" name="Target" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="2 3" dot={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {detailPaceForecast && (
        <div className="neu-card p-4" data-testid="card-forecast-details">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-500" />
            Forecast Details
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              const fc = detailPaceForecast;
              const remainingToTarget = detailTarget > 0 ? Math.max(0, detailTarget - monthStats.totalRev) : null;
              const effRemaining = fc.remainingDays + (fc.todayIsPartial ? 1 : 0);
              const neededPerDay = remainingToTarget !== null && effRemaining > 0 ? remainingToTarget / effRemaining : null;
              const diff = detailTarget > 0 ? fc.forecastRevenue - detailTarget : null;
              const items: Array<{ label: string; value: string; color?: string }> = [
                { label: "Current Revenue", value: `฿${fmtBaht(monthStats.totalRev)}`, color: "#10b981" },
                ...(detailTarget > 0 ? [{ label: "Target", value: `฿${fmtBaht(detailTarget)}` }] : []),
                { label: "Projected Month End", value: `฿${fmtBaht(fc.forecastRevenue)}`, color: "#3b82f6" },
                ...(remainingToTarget !== null ? [{ label: "Remaining to Target", value: `฿${fmtBaht(remainingToTarget)}` }] : []),
                ...(neededPerDay !== null ? [{ label: "Needed / Day", value: `฿${fmtBaht(neededPerDay)}` }] : []),
                { label: "Current Avg / Day", value: `฿${fmtBaht(fc.avgDailyRevenue)}` },
                ...(diff !== null
                  ? [{
                      label: "Forecast vs Target",
                      value: `${diff >= 0 ? "+" : "−"}฿${fmtBaht(Math.abs(diff))}`,
                      color: diff >= 0 ? "#10b981" : "#ef4444",
                    }]
                  : []),
                { label: "Remaining Days", value: `${fc.remainingDays}${fc.todayIsPartial ? " +today" : ""}` },
              ];
              return items.map((it) => (
                <div key={it.label} className="neu-inset rounded-xl p-2.5 text-center">
                  <p className="text-[10px] text-muted-foreground">{it.label}</p>
                  <p className="text-sm font-bold" style={it.color ? { color: it.color } : undefined}>
                    {it.value}
                  </p>
                </div>
              ));
            })()}
          </div>
          <p className="text-[10px] text-muted-foreground mt-3">
            <span className="font-semibold">Model:</span> {detailPaceForecast.modelLabel}
          </p>
          <p className="text-xs text-muted-foreground mt-1 leading-snug" data-testid="text-forecast-explanation">
            {detailPaceForecast.explanation}
          </p>
        </div>
      )}

      {monthHolidays.length > 0 && (
        <CollapsibleCard
          title="Events This Month"
          icon={CalendarHeart}
          defaultOpen={false}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
            {monthHolidays.map((h) => {
              const hc = HOLIDAY_COLORS[h.type];
              return (
                <div
                  key={h.date + h.name}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:brightness-95 dark:hover:brightness-110",
                    hc.bg,
                  )}
                  data-testid={`detail-event-${h.date}`}
                >
                  {h.type === "kid" ? (
                    <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 shrink-0" />
                  ) : (
                    <span
                      className={cn("w-2 h-2 rounded-full shrink-0", hc.dot)}
                    />
                  )}
                  <span className={cn("font-medium text-sm", hc.text)}>
                    {h.name}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(h.date + "T12:00:00").toLocaleDateString(
                      "en-US",
                      { weekday: "short", month: "short", day: "numeric" },
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </CollapsibleCard>
      )}
    </div>
  );
}

const METRIC_GROUPS = [
  {
    label: "Revenue & Financials",
    metrics: [
      { key: "netRevenue", name: "Net Revenue", unit: "฿" },
      { key: "revenue", name: "Gross Revenue", unit: "฿" },
      { key: "vouchers", name: "Vouchers", unit: "฿" },
      { key: "discount", name: "Discounts", unit: "฿" },
      { key: "discountRate", name: "Discount Rate", unit: "%" },
      { key: "orders", name: "Orders", unit: "" },
      { key: "avgOrderValue", name: "Avg Order Value", unit: "฿" },
      { key: "pureTicketRevenue", name: "Pure Ticket Revenue", unit: "฿" },
      { key: "voucherSwing", name: "Voucher Swing", unit: "฿" },
    ],
  },
  {
    label: "Payment Methods",
    metrics: [
      { key: "pay_cash", name: "Cash", unit: "฿" },
      { key: "pay_card", name: "Credit Card", unit: "฿" },
      { key: "pay_qr", name: "PromptPay / QR", unit: "฿" },
    ],
  },
  {
    label: "Categories",
    metrics: [
      { key: "cat_tickets", name: "Tickets & Packages", unit: "฿" },
      { key: "cat_fnb", name: "F&B (Total)", unit: "฿" },
      { key: "cat_fnb_food", name: "F&B — Food", unit: "฿" },
      { key: "cat_fnb_drinks", name: "F&B — Drinks", unit: "฿" },
      { key: "cat_events_birthdays", name: "Events / Birthdays", unit: "฿" },
      { key: "cat_nanny", name: "Nanny & Drop-off", unit: "฿" },
      { key: "cat_extras", name: "Extras", unit: "฿" },
      { key: "cat_merchandise", name: "Merchandise", unit: "฿" },
    ],
  },
  {
    label: "Guests & Stay",
    metrics: [
      { key: "totalGuests", name: "Total Guests", unit: "" },
      { key: "kids", name: "Kids", unit: "" },
      { key: "adults", name: "Adults", unit: "" },
      { key: "kidRevenue", name: "Kid Revenue", unit: "฿" },
      { key: "adultRevenue", name: "Adult Revenue", unit: "฿" },
      { key: "avgStayHours", name: "Avg Stay Duration", unit: "hrs" },
    ],
  },
  {
    label: "Customer Types",
    metrics: [
      { key: "ct_tourist_kids", name: "Tourist Kids", unit: "" },
      { key: "ct_tourist_adults", name: "Tourist Adults", unit: "" },
      { key: "ct_tourist_revenue", name: "Tourist Revenue", unit: "฿" },
      { key: "ct_thai_kids", name: "Thai Kids", unit: "" },
      { key: "ct_thai_adults", name: "Thai Adults", unit: "" },
      { key: "ct_thai_revenue", name: "Thai Revenue", unit: "฿" },
      { key: "ct_expat_kids", name: "Expat Kids", unit: "" },
      { key: "ct_expat_adults", name: "Expat Adults", unit: "" },
      { key: "ct_expat_revenue", name: "Expat Revenue", unit: "฿" },
      { key: "ct_eatplay_kids", name: "Eat & Play Kids", unit: "" },
      { key: "ct_eatplay_adults", name: "Eat & Play Adults", unit: "" },
      { key: "ct_eatplay_revenue", name: "Eat & Play Revenue", unit: "฿" },
    ],
  },
];

const FORECAST_METRICS = [
  { key: "forecast_revenue", name: "Forecast Revenue", unit: "฿" },
  { key: "forecast_tickets", name: "Forecast Tickets", unit: "฿" },
  { key: "forecast_fnb", name: "Forecast F&B", unit: "฿" },
  { key: "forecast_events", name: "Forecast Events", unit: "฿" },
  { key: "forecast_extras", name: "Forecast Extras", unit: "฿" },
  { key: "forecast_kids", name: "Forecast Kids", unit: "" },
  { key: "forecast_adults", name: "Forecast Adults", unit: "" },
  { key: "forecast_guests", name: "Forecast Guests", unit: "" },
];

const ALL_METRICS = [...METRIC_GROUPS.flatMap(g => g.metrics), ...FORECAST_METRICS];

const DATE_RANGE_OPTIONS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 14 days", days: 14 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: 0 },
];

const GROUP_OPTIONS = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "dayOfWeek", label: "Day of Week" },
];

const CHART_TYPE_OPTIONS = [
  { key: "line", label: "Line", icon: LineChartLucide },
  { key: "bar", label: "Bar", icon: BarChart3 },
  { key: "area", label: "Area", icon: AreaChartIcon },
  { key: "pie", label: "Pie", icon: PieChartIcon },
];

const QUICK_CHARTS = [
  { label: "📈 Revenue Trend", metrics: ["netRevenue"], groupBy: "weekly", chartType: "area", days: 90 },
  { label: "🧒 Customer Mix", metrics: ["ct_tourist_kids", "ct_thai_kids", "ct_expat_kids", "ct_eatplay_kids"], groupBy: "weekly", chartType: "stackedBar", days: 90 },
  { label: "🍕 Tickets vs F&B", metrics: ["cat_tickets", "cat_fnb"], groupBy: "weekly", chartType: "bar", days: 60 },
  { label: "📊 Category Split", metrics: ["cat_tickets", "cat_fnb", "cat_events_birthdays", "cat_nanny", "cat_extras", "cat_merchandise"], groupBy: "monthly", chartType: "pie", days: 30 },
  { label: "📅 Best Day of Week", metrics: ["netRevenue"], groupBy: "dayOfWeek", chartType: "bar", days: 90, aggregation: "avg" },
  { label: "💳 Payment Methods", metrics: ["pay_cash", "pay_card", "pay_qr"], groupBy: "monthly", chartType: "pie", days: 30 },
];

function normalizeChartData(chartData: any): any {
  if (!chartData?.data?.length) return chartData;

  if (chartData.chartType === "pie") {
    const first = chartData.data[0];
    if (!("value" in first) || !("name" in first)) {
      const newData = chartData.data.map((point: any) => {
        const keys = Object.keys(point).filter((k: string) => k !== "label" && k !== "name");
        const numericKey = keys.find((k: string) => typeof point[k] === "number");
        return {
          name: point.name || point.label || numericKey || "Unknown",
          value: numericKey ? point[numericKey] : 0,
        };
      });
      return { ...chartData, data: newData };
    }
    return chartData;
  }

  if (!chartData.series?.length) return chartData;

  const data = chartData.data;
  const series = chartData.series;
  const firstPoint = data[0];
  const declaredKeys = series.map((s: any) => s.dataKey);
  const actualKeys = Object.keys(firstPoint).filter((k: string) => k !== "label" && k !== "name");
  const missingKeys = declaredKeys.filter((dk: string) => !(dk in firstPoint));

  if (missingKeys.length === 0) return chartData;

  const valueKeys = actualKeys.filter((k: string) => /^value\d*$/.test(k)).sort();
  if (valueKeys.length === 0) return chartData;

  if (missingKeys.length === declaredKeys.length && valueKeys.length >= declaredKeys.length) {
    const newData = data.map((point: any) => {
      const np: any = { label: point.label, name: point.name };
      declaredKeys.forEach((dk: string, i: number) => {
        np[dk] = point[valueKeys[i]] ?? 0;
      });
      return np;
    });
    return { ...chartData, data: newData };
  }

  if (missingKeys.length === 1 && valueKeys.length >= 1) {
    const missingKey = missingKeys[0];
    const usedValueKeys = valueKeys.filter((vk: string) => !declaredKeys.includes(vk));
    if (usedValueKeys.length >= 1) {
      const newData = data.map((point: any) => ({ ...point, [missingKey]: point[usedValueKeys[0]] ?? 0 }));
      return { ...chartData, data: newData };
    }
  }

  return chartData;
}

function getMetricUnit(dataKey: string): string {
  if (dataKey.startsWith("ct_") && !dataKey.includes("revenue")) return "#";
  if (dataKey === "kids" || dataKey === "adults" || dataKey === "totalGuests" || dataKey === "orders") return "#";
  if (dataKey === "discountRate") return "%";
  if (dataKey === "avgStayHours") return "hrs";
  return "฿";
}

function formatMetricValue(val: number, unit: string): string {
  if (unit === "฿") return `฿${val.toLocaleString()}`;
  if (unit === "%") return `${val.toFixed(1)}%`;
  if (unit === "hrs") return `${val.toFixed(1)}h`;
  return val.toLocaleString();
}

function generateChartInsight(chartData: any): string | null {
  if (!chartData?.data || chartData.data.length === 0) return null;

  const data = chartData.data;
  const series = chartData.series || [];

  if (chartData.chartType === "pie") {
    const sorted = [...data].sort((a: any, b: any) => b.value - a.value);
    const total = sorted.reduce((s: number, d: any) => s + d.value, 0);
    if (total === 0) return null;
    const top = sorted[0];
    const topPct = ((top.value / total) * 100).toFixed(0);
    const runner = sorted.length > 1 ? sorted[1] : null;
    const runnerPct = runner ? ((runner.value / total) * 100).toFixed(0) : null;
    const bottom = sorted[sorted.length - 1];
    const bottomPct = ((bottom.value / total) * 100).toFixed(0);
    let insight = `${top.name} dominates at ${topPct}%`;
    if (runner && runnerPct) insight += `, followed by ${runner.name} (${runnerPct}%)`;
    if (sorted.length > 2 && parseInt(bottomPct) < 5) insight += `. ${bottom.name} is minimal at ${bottomPct}%`;
    insight += `. Total: ฿${total.toLocaleString()}.`;
    return insight;
  }

  if (series.length === 1 || series.length === 0) {
    const key = series[0]?.dataKey || "value";
    const unit = getMetricUnit(key);
    const values = data.map((d: any) => d[key]).filter((v: any) => typeof v === "number");
    if (values.length === 0) return null;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const avg = values.reduce((s: number, v: number) => s + v, 0) / values.length;
    const maxLabel = data.find((d: any) => d[key] === max)?.label || "";
    const minLabel = data.find((d: any) => d[key] === min)?.label || "";
    const first = values[0];
    const last = values[values.length - 1];
    const volatility = avg > 0 ? ((max - min) / avg * 100).toFixed(0) : "0";

    let trend = "stable";
    if (last > first * 1.1) trend = "growing";
    else if (last > first * 1.03) trend = "slightly up";
    else if (last < first * 0.9) trend = "declining";
    else if (last < first * 0.97) trend = "slightly down";

    const trendPct = first > 0 ? Math.abs(((last - first) / first) * 100).toFixed(0) : "0";

    const parts = [`Best: ${formatMetricValue(max, unit)} (${maxLabel})`];
    if (minLabel !== maxLabel) parts.push(`Lowest: ${formatMetricValue(min, unit)} (${minLabel})`);
    parts.push(`Avg: ${formatMetricValue(Math.round(avg), unit)}`);

    if (trend !== "stable") {
      const arrow = trend.includes("up") || trend === "growing" ? "↑" : "↓";
      parts.push(`${arrow} ${trend} (${trendPct}%)`);
    }

    if (parseInt(volatility) > 50) parts.push(`High volatility (${volatility}% swing)`);

    return parts.join(" · ");
  }

  const summaries = series.map((s: any) => {
    const values = data.map((d: any) => d[s.dataKey]).filter((v: any) => typeof v === "number");
    const total = values.reduce((sum: number, v: number) => sum + v, 0);
    const unit = getMetricUnit(s.dataKey);
    return { name: s.name || s.dataKey, total, unit, dataKey: s.dataKey };
  }).sort((a: any, b: any) => b.total - a.total);

  const grandTotal = summaries.reduce((s: number, d: any) => s + d.total, 0);
  const unit = summaries[0]?.unit || "฿";

  const parts = summaries.map((s: any) => {
    const pct = grandTotal > 0 ? ((s.total / grandTotal) * 100).toFixed(0) : "0";
    return `${s.name}: ${formatMetricValue(s.total, unit)} (${pct}%)`;
  });

  if (summaries.length >= 2) {
    const ratio = summaries[1].total > 0 ? (summaries[0].total / summaries[1].total).toFixed(1) : "∞";
    parts.push(`Top/2nd ratio: ${ratio}x`);
  }

  return parts.join(" · ");
}

const METRIC_DISPLAY_NAMES: Record<string, string> = {
  netRevenue: "Net Revenue", revenue: "Gross Revenue", vouchers: "Vouchers",
  orders: "Orders", avgOrderValue: "Avg Order", discount: "Discount",
  discountRate: "Discount %", pureTicketRevenue: "Pure Ticket Rev",
  voucherSwing: "Voucher Swing", pay_cash: "Cash", pay_card: "Card",
  pay_qr: "QR/PromptPay", cat_tickets: "Tickets & Packages",
  cat_fnb: "F&B", cat_fnb_food: "F&B Food", cat_fnb_drinks: "F&B Drinks",
  cat_events_birthdays: "Events/Birthdays", cat_nanny: "Nanny/Drop-off",
  cat_extras: "Extras", cat_merchandise: "Merchandise",
  kids: "Kids", adults: "Adults", totalGuests: "Total Guests",
  kidRevenue: "Kid Revenue", adultRevenue: "Adult Revenue",
  avgStayHours: "Avg Stay",
  ct_tourist_kids: "Tourist Kids", ct_tourist_adults: "Tourist Adults",
  ct_tourist_revenue: "Tourist Rev", ct_thai_kids: "Thai Kids",
  ct_thai_adults: "Thai Adults", ct_thai_revenue: "Thai Rev",
  ct_expat_kids: "Expat Kids", ct_expat_adults: "Expat Adults",
  ct_expat_revenue: "Expat Rev", ct_eatplay_kids: "E&P Kids",
  ct_eatplay_adults: "E&P Adults", ct_eatplay_revenue: "E&P Rev",
};

function CalcBreakdown({ chartData }: { chartData: any }) {
  const [open, setOpen] = useState(false);
  const rawBreakdown = chartData?.rawBreakdown;
  const data = chartData?.data;
  const series = chartData?.series || [];
  const isPie = chartData?.chartType === "pie";

  if (!data || data.length === 0) return null;

  return (
    <div className="rounded-md border border-border/20 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted/20 transition-colors"
        data-testid="btn-toggle-calculation"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        How was this calculated?
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1 space-y-2 max-h-[300px] overflow-y-auto" data-testid="text-calculation-breakdown">
          {isPie ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">Formula: Sum each metric across all days in range</p>
              {data.filter((d: any) => d.value > 0).map((d: any, i: number) => {
                const metricKey = d.metricKey || d.name;
                const displayName = d.name || METRIC_DISPLAY_NAMES[metricKey] || metricKey;
                const unit = getMetricUnit(metricKey);
                const dailyEntries = rawBreakdown
                  ? Object.values(rawBreakdown).flat().filter((e: any) => e.values?.[metricKey] > 0) as any[]
                  : [];
                return (
                  <div key={i} className="text-[10px] text-foreground/70 font-mono">
                    <span className="font-semibold text-foreground/80">{displayName}</span>
                    {" = "}
                    {formatMetricValue(d.value, unit)}
                    {dailyEntries.length > 0 && (
                      <span className="text-muted-foreground ml-1">
                        ({dailyEntries.length} days with data)
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="text-[10px] font-mono font-semibold text-foreground/80 pt-1 border-t border-border/20">
                Total = {formatMetricValue(data.reduce((s: number, d: any) => s + (d.value || 0), 0), "฿")}
              </div>
            </div>
          ) : rawBreakdown ? (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground">
                Formula: Each bar/point = sum of daily values in that period
              </p>
              {data.map((point: any, idx: number) => {
                const label = point.label;
                const dailyRows = rawBreakdown[label];
                if (!dailyRows || dailyRows.length === 0) return null;
                return (
                  <div key={idx} className="text-[10px] font-mono space-y-0.5">
                    <p className="font-semibold text-foreground/80">{label}:</p>
                    {series.map((s: any) => {
                      const key = s.dataKey;
                      const unit = getMetricUnit(key);
                      const name = METRIC_DISPLAY_NAMES[key] || s.name || key;
                      const dailyValues = dailyRows.map((r: any) => ({
                        date: r.date,
                        val: r.values[key] || 0,
                      }));
                      const total = dailyValues.reduce((sum: number, d: any) => sum + d.val, 0);
                      const nonZeroDays = dailyValues.filter((d: any) => d.val > 0);
                      return (
                        <div key={key} className="text-foreground/60 pl-2">
                          <span className="text-foreground/70">{name}</span>
                          {" = "}
                          {nonZeroDays.length <= 7 ? (
                            <>
                              {nonZeroDays.map((d: any, i: number) => (
                                <span key={i}>
                                  {i > 0 && " + "}
                                  <span className="text-foreground/50">{d.date.slice(5)}</span>
                                  :{formatMetricValue(Math.round(d.val), unit)}
                                </span>
                              ))}
                              {nonZeroDays.length > 0 && ` = `}
                            </>
                          ) : (
                            <span>{nonZeroDays.length} days → </span>
                          )}
                          <span className="font-semibold text-foreground/80">{formatMetricValue(Math.round(total), unit)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">Data points (daily granularity — no aggregation)</p>
              {series.map((s: any) => {
                const key = s.dataKey;
                const unit = getMetricUnit(key);
                const name = METRIC_DISPLAY_NAMES[key] || s.name || key;
                return (
                  <div key={key} className="text-[10px] font-mono text-foreground/60">
                    <span className="text-foreground/70 font-semibold">{name}</span>
                    {": "}
                    {data.map((d: any, i: number) => (
                      <span key={i}>
                        {i > 0 && ", "}
                        {d.label}: {formatMetricValue(d[key] || 0, unit)}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendsChart({ chartData: rawChartData }: { chartData: any }) {
  const chartData = normalizeChartData(rawChartData);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const axisColor = isDark ? "#9ca3af" : "#6b7280";
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";

  if (!chartData || !chartData.data || chartData.data.length === 0) return null;

  const formatValue = (val: number) => {
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(0)}k`;
    return val.toString();
  };

  const commonProps = {
    data: chartData.data,
    margin: { top: 5, right: 10, left: 0, bottom: 5 },
  };

  const axisProps = {
    xAxis: { dataKey: "label", tick: { fontSize: 10, fill: axisColor }, axisLine: false, tickLine: false },
    yAxis: { tick: { fontSize: 10, fill: axisColor }, axisLine: false, tickLine: false, tickFormatter: formatValue, width: 45 },
    grid: { strokeDasharray: "3 3", stroke: gridColor },
    tooltip: { contentStyle: { background: isDark ? "#1f2937" : "#fff", border: "none", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12 }, formatter: (v: number) => [`฿${v.toLocaleString()}`, ""] },
  };

  if (chartData.chartType === "pie") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <RechartsPC>
          <Pie data={chartData.data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={10}>
            {chartData.data.map((_: any, i: number) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v: number) => [`฿${v.toLocaleString()}`, ""]} contentStyle={axisProps.tooltip.contentStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </RechartsPC>
      </ResponsiveContainer>
    );
  }

  if (chartData.chartType === "area") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart {...commonProps}>
          <CartesianGrid {...axisProps.grid} />
          <XAxis {...axisProps.xAxis} />
          <YAxis {...axisProps.yAxis} />
          <Tooltip {...axisProps.tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {(chartData.series || []).map((s: any, i: number) => (
            <Area key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color || CHART_COLORS[i]} fill={s.color || CHART_COLORS[i]} fillOpacity={0.15} strokeWidth={2} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  if (chartData.chartType === "bar" || chartData.chartType === "stackedBar") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart {...commonProps}>
          <CartesianGrid {...axisProps.grid} />
          <XAxis {...axisProps.xAxis} />
          <YAxis {...axisProps.yAxis} />
          <Tooltip {...axisProps.tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {(chartData.series || []).map((s: any, i: number) => (
            <Bar key={i} dataKey={s.dataKey} name={s.name} fill={s.color || CHART_COLORS[i]} radius={[4, 4, 0, 0]} stackId={chartData.chartType === "stackedBar" ? "stack" : undefined} fillOpacity={s.dataKey?.startsWith("forecast_") ? 0.35 : 1} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart {...commonProps}>
        <CartesianGrid {...axisProps.grid} />
        <XAxis {...axisProps.xAxis} />
        <YAxis {...axisProps.yAxis} />
        <Tooltip {...axisProps.tooltip} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {(chartData.series || []).map((s: any, i: number) => (
          <Line key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color || CHART_COLORS[i]} strokeWidth={2} dot={false} strokeDasharray={s.dataKey?.startsWith("forecast_") ? "6 4" : undefined} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

type TrendMessage = { role: "user" | "assistant"; content: string; chartData?: any; summary?: string; dataSummary?: string; options?: string[] };
type SavedConversation = { id: string; title: string; messages: TrendMessage[]; lastChartSpec?: any; savedAt: string };

const TRENDS_STORAGE_KEY = "oto-trends-history";

function loadSavedConversations(): SavedConversation[] {
  try {
    const raw = localStorage.getItem(TRENDS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveTrendsConversations(convos: SavedConversation[]) {
  localStorage.setItem(TRENDS_STORAGE_KEY, JSON.stringify(convos));
}

function generateConvoTitle(messages: TrendMessage[]): string {
  const firstQ = messages.find(m => m.role === "user");
  if (firstQ) {
    const text = firstQ.content;
    return text.length > 50 ? text.slice(0, 47) + "..." : text;
  }
  return "Untitled conversation";
}

// task-134: Events tab. Read-only consumption of /api/events/range.
// Floresta rows reuse BirthdayOrderDialog; Chalong rows are display-only
// (no equivalent order-detail endpoint exists today).
interface EventRowApi {
  date: string;
  branch: "floresta" | "chalong";
  partyOrderId: string;
  partyOrderCode: string;
  packageName: string;
  packageRevenue: number;
  fnbRevenue: number;
  /** Chalong/Papaya order extras; absent on the Floresta event feed. */
  otherRevenue?: number;
  /** Reconciliation adjustment needed to explain the authoritative order total. */
  reconciliationRevenue?: number;
  totalRevenue: number;
  entertainmentItems: Array<{ name: string; qty: number; revenue: number }>;
  link?: BirthdayLinkProposal | null;
  partyPackages?: string[];
}

type EventsSortKey = "date" | "branch" | "package" | "packageRev" | "fnbRev" | "total";

function formatNiceDate(iso: string): string {
  try { return format(parseISO(iso), "EEE d MMM"); }
  catch { return iso; }
}

// task-134 (manual linker): picker for attaching an F&B order to a party.
interface EventCandidateApi {
  orderId: string;
  orderCode: string;
  createdAt: string | null;
  totalAmount: number;
  lineCount: number;
  totalQty: number;
  fnbRevenue: number;
  itemsPreview: string;
  linkedToPartyCode: string | null;
  alreadyLinkedToThisParty: boolean;
}

function LinkFnbDialog({
  open,
  onClose,
  date,
  partyOrderCode,
  partyPackageName,
}: {
  open: boolean;
  onClose: () => void;
  date: string;
  partyOrderCode: string;
  partyPackageName: string;
}) {
  const { toast } = useToast();
  const candidatesQuery = useQuery<{ candidates: EventCandidateApi[] }>({
    queryKey: ["/api/events/candidates", date, partyOrderCode],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/candidates?date=${date}&partyOrderCode=${encodeURIComponent(partyOrderCode)}&branch=floresta`,
      );
      if (!res.ok) throw new Error("Failed to load candidates");
      return res.json();
    },
    enabled: open && !!date && !!partyOrderCode,
    staleTime: 30_000,
  });

  const linkMutation = useMutation({
    mutationFn: async (fnbOrderCode: string) => {
      return apiRequest("POST", "/api/events/link", {
        date,
        fnbOrderCode,
        partyOrderCode,
        branch: "floresta",
      });
    },
    onSuccess: () => {
      toast({ title: "F&B linked", description: `Attached to ${partyOrderCode}` });
      queryClient.invalidateQueries({ queryKey: ["/api/events/range"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events/candidates", date, partyOrderCode] });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia"] });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Link failed", description: err?.message || String(err), variant: "destructive" });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (fnbOrderCode: string) => {
      return apiRequest("DELETE", "/api/events/link", {
        date,
        fnbOrderCode,
        branch: "floresta",
      });
    },
    onSuccess: () => {
      toast({ title: "Link removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/events/range"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events/candidates", date, partyOrderCode] });
      queryClient.invalidateQueries({ queryKey: ["/api/funtopia"] });
    },
    onError: (err: any) => {
      toast({ title: "Unlink failed", description: err?.message || String(err), variant: "destructive" });
    },
  });

  const candidates = candidatesQuery.data?.candidates || [];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" data-testid="dialog-link-fnb">
        <DialogHeader>
          <DialogTitle>Link F&amp;B order to party</DialogTitle>
          <DialogDescription>
            <span className="font-medium">{partyPackageName}</span> · #{partyOrderCode} · {formatNiceDate(date)}
            <br />
            <span className="text-xs">Pick the customer's food order on this day. Picking writes a manual override and rebuilds the day's summary.</span>
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-6 px-6">
          {candidatesQuery.isLoading && (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-candidates-loading">Loading orders…</div>
          )}
          {candidatesQuery.isError && (
            <div className="text-sm text-destructive py-8 text-center">Failed to load. <button className="underline" onClick={() => candidatesQuery.refetch()}>Retry</button></div>
          )}
          {!candidatesQuery.isLoading && !candidatesQuery.isError && candidates.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-candidates-empty">No non-party orders on this date.</div>
          )}
          {candidates.length > 0 && (
            <div className="space-y-2 py-2">
              {candidates.map((c) => {
                const busyElsewhere = !!c.linkedToPartyCode && !c.alreadyLinkedToThisParty;
                const time = c.createdAt ? new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                return (
                  <div
                    key={c.orderId}
                    className={cn(
                      "rounded border p-3 flex items-start gap-3",
                      c.alreadyLinkedToThisParty && "bg-emerald-500/10 border-emerald-500/30",
                      busyElsewhere && "opacity-60",
                    )}
                    data-testid={`row-candidate-${c.orderCode}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">#{c.orderCode}</span>
                        <span>·</span>
                        <span>{time}</span>
                        <span>·</span>
                        <span>{c.lineCount} line{c.lineCount === 1 ? "" : "s"} · {c.totalQty} qty</span>
                        {c.alreadyLinkedToThisParty && (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-medium">linked</span>
                        )}
                        {busyElsewhere && (
                          <span className="inline-flex items-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[10px] font-medium">
                            linked to {c.linkedToPartyCode}
                          </span>
                        )}
                      </div>
                      <div className="text-sm mt-1 truncate" title={c.itemsPreview || ""}>
                        {c.itemsPreview || <span className="text-muted-foreground italic">(no line items)</span>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 privacy-sensitive">
                        Total {formatBaht(c.totalAmount)}{c.fnbRevenue > 0 ? ` · F&B ${formatBaht(c.fnbRevenue)}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0">
                      {c.alreadyLinkedToThisParty ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={unlinkMutation.isPending}
                          onClick={() => unlinkMutation.mutate(c.orderCode)}
                          data-testid={`button-unlink-${c.orderCode}`}
                        >
                          Unlink
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={linkMutation.isPending}
                          onClick={() => linkMutation.mutate(c.orderCode)}
                          data-testid={`button-link-${c.orderCode}`}
                        >
                          {busyElsewhere ? "Re-link here" : "Link"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type EventsPosRefreshState = "idle" | "active" | "success" | "warning" | "error";

interface EventsPosSyncProgress {
  running?: boolean;
  progress?: string;
  error?: string | null;
  totalDays?: number;
  syncedDays?: number;
  eta?: string;
  syncStartDate?: string | null;
  syncEndDate?: string | null;
  warnings?: string[];
  skippedDates?: string[];
}

function EventsPosRefresh({ range }: { range: { from: string; to: string } }) {
  const [state, setState] = useState<EventsPosRefreshState>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<EventsPosSyncProgress | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef(false);
  const requestingRef = useRef(false);
  const requestedRangeRef = useRef<{ from: string; to: string } | null>(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const finishProgress = useCallback((data: EventsPosSyncProgress) => {
    if (!mountedRef.current) return;
    stopPolling();
    setProgress(data);
    const requestedRange = requestedRangeRef.current;
    const completedRange =
      data.syncStartDate && data.syncEndDate
        ? { from: data.syncStartDate, to: data.syncEndDate }
        : null;
    if (data.error || (data.progress || "").startsWith("Failed")) {
      requestedRangeRef.current = null;
      setState("error");
      setMessage(`POS refresh failed: ${data.error || data.progress || "Unknown error"}`);
      return;
    }
    if (
      requestedRange &&
      (!completedRange ||
        completedRange.from !== requestedRange.from ||
        completedRange.to !== requestedRange.to)
    ) {
      setState("warning");
      setMessage(
        `POS sync finished for ${completedRange ? `${completedRange.from} → ${completedRange.to}` : "an unverified range"}, not the requested ${requestedRange.from} → ${requestedRange.to}. No selected-range refresh was confirmed.`,
      );
      return;
    }
    requestedRangeRef.current = null;
    const skippedDates = data.skippedDates || [];
    const warnings = data.warnings || [];
    if (skippedDates.length > 0) {
      setState("warning");
      setMessage(
        `POS refresh completed with ${skippedDates.length} skipped date${skippedDates.length === 1 ? "" : "s"}: ${skippedDates.join(", ")}`,
      );
      return;
    }
    if (warnings.length > 0) {
      setState("warning");
      setMessage(
        `POS refresh completed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}; selected data may be partial.`,
      );
    } else {
      setState("success");
      setMessage("POS refresh complete.");
    }
    queryClient.invalidateQueries({ queryKey: ["/api/events/range"] });
  }, [stopPolling]);

  const pollProgress = useCallback(async () => {
    if (!pollingRef.current || !mountedRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/funtopia/sync-progress", { signal: controller.signal });
      if (!res.ok) throw new Error(`Progress request failed (${res.status})`);
      const data: EventsPosSyncProgress = await res.json();
      if (!mountedRef.current || !pollingRef.current) return;
      setProgress(data);
      const requestedRange = requestedRangeRef.current;
      if (
        requestedRange &&
        data.syncStartDate &&
        data.syncEndDate &&
        (data.syncStartDate !== requestedRange.from ||
          data.syncEndDate !== requestedRange.to)
      ) {
        stopPolling();
        requestedRangeRef.current = null;
        setState("warning");
        setMessage(
          `Another POS sync is running for ${data.syncStartDate} → ${data.syncEndDate}; the requested ${requestedRange.from} → ${requestedRange.to} refresh was not confirmed.`,
        );
        return;
      }
      if (data.running) {
        setState("active");
        setMessage(data.progress || "Refreshing selected dates from POS...");
        timerRef.current = setTimeout(() => void pollProgress(), 2000);
      } else {
        finishProgress(data);
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || !mountedRef.current || !pollingRef.current) return;
      stopPolling();
      setState("error");
      setMessage(`Could not read POS refresh progress: ${err?.message || "Unknown error"}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [finishProgress, stopPolling]);

  const beginPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = true;
    void pollProgress();
  }, [pollProgress, stopPolling]);

  const refresh = async () => {
    // Keep bad picker values out of the API request. Checking the calendar
    // components as well as the shape catches impossible dates such as
    // 2026-02-31 without relying on browser date parsing.
    const validDate = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split("-").map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      );
    };
    if (
      !validDate(range.from) ||
      !validDate(range.to) ||
      range.from > range.to
    ) {
      setState("error");
      setMessage("Choose a valid date range before refreshing POS.");
      return;
    }
    if (pollingRef.current || requestingRef.current) return;

    stopPolling();
    requestedRangeRef.current = { from: range.from, to: range.to };
    requestingRef.current = true;
    setState("active");
    setProgress(null);
    setMessage(`Starting POS refresh: ${range.from} → ${range.to}...`);
    try {
      const res = await apiRequest("POST", "/api/funtopia/sync", {
        mode: "full",
        start: range.from,
        end: range.to,
        force: true,
        exactReportDates: true,
      });
      const result: EventsPosSyncProgress & {
        status?: string;
        message?: string;
        pushWarning?: string | null;
      } = await res.json();

      if (!mountedRef.current) return;
      if (result.status === "started") {
        setMessage(
          result.pushWarning
            ? `Refreshing selected dates from POS. ${result.pushWarning}`
            : "Refreshing selected dates from POS, including edited birthday notes...",
        );
        beginPolling();
        return;
      }
      if (result.status === "already_running") {
        stopPolling();
        requestedRangeRef.current = null;
        setState("warning");
        setMessage(
          `Another POS sync is already running${result.syncStartDate && result.syncEndDate ? ` for ${result.syncStartDate} → ${result.syncEndDate}` : ""}. Your ${range.from} → ${range.to} refresh was not started; retry after it ends.`,
        );
        return;
      }
      if (result.status === "push_protected") {
        stopPolling();
        requestedRangeRef.current = null;
        setState("warning");
        setMessage(`POS refresh was not started: ${result.message || "push protection is active."}`);
        return;
      }
      if (result.error || result.status === "error") {
        stopPolling();
        requestedRangeRef.current = null;
        setState("error");
        setMessage(`POS refresh failed: ${result.error || result.message || "Unknown error"}`);
        return;
      }
      if ((result.skippedDates || []).length > 0) {
        stopPolling();
        requestedRangeRef.current = null;
        setProgress(result);
        setState("warning");
        setMessage(
          `POS refresh completed with ${result.skippedDates!.length} skipped date${result.skippedDates!.length === 1 ? "" : "s"}: ${result.skippedDates!.join(", ")}`,
        );
        return;
      }
      // A non-standard terminal response is not treated as a successful
      // refresh, since the background job was not confirmed as started.
      stopPolling();
      requestedRangeRef.current = null;
      setState("error");
      setMessage(`POS refresh did not start: ${result.message || "Unexpected response."}`);
    } catch (err: any) {
      if (!mountedRef.current) return;
      stopPolling();
      requestedRangeRef.current = null;
      setState("error");
      setMessage(`POS refresh failed: ${err?.message || "Unknown error"}`);
    } finally {
      requestingRef.current = false;
    }
  };

  const isActive = state === "active";
  const skippedDates = progress?.skippedDates || [];
  const progressPercent = progress?.totalDays
    ? Math.min(100, Math.round(((progress.syncedDays || 0) / progress.totalDays) * 100))
    : 0;

  return (
    <div className="basis-full flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="events-pos-refresh">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {isActive && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          <span>Refresh selected range from POS</span>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Re-fetches {range.from} → {range.to}, including edited birthday notes.
        </div>
        {message && (
          <div
            className={cn(
              "mt-1 text-[10px]",
              state === "error" ? "text-destructive" : state === "warning" ? "text-amber-600 dark:text-amber-400" : state === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
            data-testid="events-pos-refresh-status"
          >
            {message}
          </div>
        )}
        {isActive && progress?.totalDays ? (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-blue-200 dark:bg-blue-900">
              <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progressPercent}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {progress.syncedDays || 0}/{progress.totalDays} days{progress.eta ? ` · ${progress.eta}` : ""}
            </span>
          </div>
        ) : null}
        {skippedDates.length > 0 && state !== "active" && (
          <div className="text-[10px] text-amber-600 dark:text-amber-400">
            Skipped dates: {skippedDates.join(", ")}
          </div>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={refresh}
        disabled={isActive}
        data-testid="button-events-refresh-pos"
      >
        <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isActive && "animate-spin")} />
        {isActive ? "Refreshing..." : "Refresh POS"}
      </Button>
    </div>
  );
}

function EventsTab({ activeBranches }: { activeBranches: ActiveBranches }) {
  const today = getBangkokToday();
  const defaultFrom = (() => {
    const d = new Date(today + "T12:00:00");
    d.setDate(d.getDate() - 29);
    return d.toISOString().split("T")[0];
  })();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: defaultFrom, to: today });
  const defaultBranch: "all" | "floresta" | "chalong" =
    activeBranches.has("floresta") && activeBranches.has("chalong")
      ? "all"
      : activeBranches.has("floresta")
        ? "floresta"
        : "chalong";
  const [branchFilter, setBranchFilter] = useState<"all" | "floresta" | "chalong">(defaultBranch);
  const [packageFilter, setPackageFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<EventsSortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [entSortKey, setEntSortKey] = useState<"name" | "events" | "qty" | "revenue">("revenue");
  const [entSortDir, setEntSortDir] = useState<"asc" | "desc">("desc");
  const [openCard, setOpenCard] = useState<{
    id: string;
    partyOrderCode: string;
    partyPackages: string[];
    combined: number;
    packageRev: number;
    link: BirthdayLinkProposal | null;
  } | null>(null);
  // task-134 (manual linker)
  const [openLinker, setOpenLinker] = useState<{
    date: string;
    partyOrderCode: string;
    packageName: string;
  } | null>(null);
  const formatEventsMoney = (value: number) =>
    `฿${Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const query = useQuery<{ events: EventRowApi[] }>({
    queryKey: ["/api/events/range", range.from, range.to, branchFilter],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/range?from=${range.from}&to=${range.to}&branch=${branchFilter}`,
      );
      if (!res.ok) throw new Error("Failed to load events");
      return res.json();
    },
    staleTime: 60_000,
  });

  const allEvents = query.data?.events || [];

  const packageOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEvents) set.add(e.packageName || "Birthday party");
    return Array.from(set).sort();
  }, [allEvents]);

  const filteredEvents = useMemo(() => {
    const filtered = packageFilter === "all"
      ? allEvents
      : allEvents.filter((e) => (e.packageName || "Birthday party") === packageFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: EventRowApi, b: EventRowApi) => {
      switch (sortKey) {
        case "branch": return dir * a.branch.localeCompare(b.branch);
        case "package": return dir * a.packageName.localeCompare(b.packageName);
        case "packageRev": return dir * (a.packageRevenue - b.packageRevenue);
        case "fnbRev": return dir * (a.fnbRevenue - b.fnbRevenue);
        case "total": return dir * (a.totalRevenue - b.totalRevenue);
        case "date":
        default:
          return dir * a.date.localeCompare(b.date);
      }
    };
    return [...filtered].sort(cmp);
  }, [allEvents, packageFilter, sortKey, sortDir]);

  // Papaya's otherRevenue includes the reconciliation amount. Keep the
  // displayed Extras subtotal standalone so Extras + Adjustment never
  // double-counts the authoritative order total.
  const eventExtras = (e: EventRowApi) =>
    Number(e.otherRevenue || 0) - Number(e.reconciliationRevenue || 0);

  const totals = useMemo(() => {
    const eventCount = filteredEvents.length;
    const packageRev = filteredEvents.reduce((s, e) => s + e.packageRevenue, 0);
    const fnbRev = filteredEvents.reduce((s, e) => s + e.fnbRevenue, 0);
    // Papaya supplies the completed order total after discounts.  It is the
    // source of truth for Chalong (and must not be rebuilt from category
    // components, which can omit extras or contain a reconciliation delta).
    const otherRev = filteredEvents.reduce((s, e) => s + eventExtras(e), 0);
    const adjustment = filteredEvents.reduce((s, e) => s + Number(e.reconciliationRevenue || 0), 0);
    const totalRev = filteredEvents.reduce((s, e) => s + Number(e.totalRevenue || 0), 0);
    const pkgCounts = new Map<string, number>();
    for (const e of filteredEvents) {
      const k = e.packageName || "Birthday party";
      pkgCounts.set(k, (pkgCounts.get(k) || 0) + 1);
    }
    let topPackage = "—";
    let topPackageCount = 0;
    pkgCounts.forEach((v, k) => {
      if (v > topPackageCount) { topPackage = k; topPackageCount = v; }
    });
    return {
      eventCount,
      packageRev,
      fnbRev,
      otherRev,
      adjustment,
      totalRev,
      avg: eventCount ? totalRev / eventCount : 0,
      topPackage,
      topPackageCount,
    };
  }, [filteredEvents]);

  const entertainmentBreakdown = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number; events: number }>();
    for (const e of filteredEvents) {
      for (const it of e.entertainmentItems || []) {
        const ex = map.get(it.name);
        if (ex) { ex.qty += it.qty; ex.revenue += it.revenue; ex.events += 1; }
        else map.set(it.name, { name: it.name, qty: it.qty, revenue: it.revenue, events: 1 });
      }
    }
    const dir = entSortDir === "asc" ? 1 : -1;
    return Array.from(map.values()).sort((a, b) => {
      switch (entSortKey) {
        case "name": return dir * a.name.localeCompare(b.name);
        case "events": return dir * (a.events - b.events);
        case "qty": return dir * (a.qty - b.qty);
        case "revenue":
        default: return dir * (a.revenue - b.revenue);
      }
    });
  }, [filteredEvents, entSortKey, entSortDir]);

  const toggleEntSort = (k: "name" | "events" | "qty" | "revenue") => {
    if (entSortKey === k) setEntSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setEntSortKey(k); setEntSortDir(k === "name" ? "asc" : "desc"); }
  };

  const toggleSort = (k: EventsSortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "date" ? "desc" : "desc"); }
  };

  const fileBase = `oto-events_${range.from}_to_${range.to}`;
  // The extra columns are relevant to Chalong (and the combined view). Keep
  // the Floresta export shape unchanged for existing cash-basis workflows.
  const includeChalongFields = branchFilter !== "floresta";
  const hasExtras = Math.abs(totals.otherRev) > 0.005;
  const hasAdjustment = Math.abs(totals.adjustment) > 0.005;
  const packageSummaryLabel = includeChalongFields ? "package / tickets" : "pkg";
  const formatAdjustment = (value: number) => {
    const amount = formatEventsMoney(Math.abs(value));
    return value < 0 ? `−${amount}` : `+${amount}`;
  };

  const dayOfWeek = (iso: string) => {
    try { return format(parseISO(iso), "EEE"); } catch { return ""; }
  };

  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();

    const branchLabel = branchFilter === "all" ? "All branches" : BRANCH_LABELS[branchFilter as Branch];
    const packageLabel = packageFilter === "all" ? "All packages" : packageFilter;
    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

    // ---------- Sheet 1: Summary ----------
    const fnbShare = totals.totalRev ? totals.fnbRev / totals.totalRev : 0;
    const pkgShare = totals.totalRev ? totals.packageRev / totals.totalRev : 0;
    const summaryAoa: (string | number)[][] = [
      ["OTO Radar — Events Report"],
      [`Period`, `${range.from} to ${range.to}`],
      [`Branch`, branchLabel],
      [`Package filter`, packageLabel],
      [`Generated`, generatedAt],
      [],
      ["Metric", "Value"],
      ["Total events", totals.eventCount],
      ["Total revenue (THB)", totals.totalRev],
      [includeChalongFields ? "Package / tickets revenue (THB)" : "Package revenue (THB)", totals.packageRev],
      ["F&B revenue (THB)", totals.fnbRev],
      ...(includeChalongFields ? [
        ["Extras (THB)", totals.otherRev],
        ["Adjustment (THB)", totals.adjustment],
      ] : []),
      ["Package revenue share", pkgShare],
      ["F&B revenue share", fnbShare],
      ["Average spend per event (THB)", totals.avg],
      ["Most popular package", totals.topPackage],
      ["Most popular package — event count", totals.topPackageCount],
    ];
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
    summaryWs["!cols"] = [{ wch: 36 }, { wch: 32 }];
    summaryWs["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    const setFmt = (cellAddr: string, z: string) => {
      const c = summaryWs[cellAddr]; if (c) c.z = z;
    };
    ["B8"].forEach((a) => setFmt(a, "#,##0"));
    const summaryMoneyRows = includeChalongFields
      ? ["B9", "B10", "B11", "B12", "B13", "B16"]
      : ["B9", "B10", "B11", "B14"];
    const summaryShareRows = includeChalongFields ? ["B14", "B15"] : ["B12", "B13"];
    summaryMoneyRows.forEach((a) => setFmt(a, '"฿"#,##0.00'));
    summaryShareRows.forEach((a) => setFmt(a, "0.0%"));
    XLSX.utils.book_append_sheet(wb, summaryWs, "Summary");

    // ---------- Sheet 2: Events (rich) ----------
    const eventsHeader = [
      "Date",
      "Day",
      "Branch",
      "Order code",
      includeChalongFields ? "Primary package / tickets" : "Primary package",
      "All packages",
      "Package count",
      includeChalongFields ? "Package / tickets revenue (THB)" : "Package revenue (THB)",
      "F&B revenue (THB)",
      ...(includeChalongFields ? ["Extras (THB)", "Adjustment (THB)"] : []),
      "Total revenue (THB)",
      "F&B share",
      "Entertainment items",
      "Entertainment qty",
      "Entertainment revenue (THB)",
      "Entertainment detail",
    ];
    const eventsAoa: (string | number)[][] = [eventsHeader];
    for (const e of filteredEvents) {
      const items = e.entertainmentItems || [];
      const entQty = items.reduce((s, i) => s + i.qty, 0);
      const entRev = items.reduce((s, i) => s + i.revenue, 0);
      const entDetail = items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""} (฿${i.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`).join("; ");
      const allPackages = (e.partyPackages && e.partyPackages.length ? e.partyPackages : [e.packageName]).join("; ");
      const pkgCount = (e.partyPackages && e.partyPackages.length) ? e.partyPackages.length : 1;
      const fnbShareRow = e.totalRevenue ? e.fnbRevenue / e.totalRevenue : 0;
      const eventRow: (string | number)[] = [
        e.date,
        dayOfWeek(e.date),
        BRANCH_LABELS[e.branch],
        e.partyOrderCode,
        e.packageName,
        allPackages,
        pkgCount,
        e.packageRevenue,
        e.fnbRevenue,
      ];
      if (includeChalongFields) {
        eventRow.push(eventExtras(e), Number(e.reconciliationRevenue || 0));
      }
      eventRow.push(
        e.totalRevenue,
        fnbShareRow,
        items.length,
        entQty,
        entRev,
        entDetail,
      );
      eventsAoa.push(eventRow);
    }
    // Totals row
    if (filteredEvents.length) {
      const totalRow: (string | number)[] = [
        "TOTAL",
        "",
        "",
        "",
        "",
        "",
        filteredEvents.reduce((s, e) => s + ((e.partyPackages?.length) || 1), 0),
        totals.packageRev,
        totals.fnbRev,
      ];
      if (includeChalongFields) {
        totalRow.push(totals.otherRev, totals.adjustment);
      }
      totalRow.push(
        totals.totalRev,
        totals.totalRev ? totals.fnbRev / totals.totalRev : 0,
        filteredEvents.reduce((s, e) => s + (e.entertainmentItems?.length || 0), 0),
        filteredEvents.reduce((s, e) => s + (e.entertainmentItems || []).reduce((q, i) => q + i.qty, 0), 0),
        filteredEvents.reduce((s, e) => s + (e.entertainmentItems || []).reduce((q, i) => q + i.revenue, 0), 0),
        "",
      );
      eventsAoa.push(totalRow);
    }
    const eventsWs = XLSX.utils.aoa_to_sheet(eventsAoa);
    eventsWs["!cols"] = [
      { wch: 11 }, { wch: 5 }, { wch: 18 }, { wch: 16 }, { wch: 30 }, { wch: 36 },
      { wch: 7 }, { wch: 14 }, { wch: 14 },
      ...(includeChalongFields ? [{ wch: 14 }, { wch: 14 }] : []),
      { wch: 14 }, { wch: 9 },
      { wch: 9 }, { wch: 9 }, { wch: 14 }, { wch: 60 },
    ];
    eventsWs["!freeze"] = { xSplit: 0, ySplit: 1 };
    const lastRow = eventsAoa.length;
    for (let r = 2; r <= lastRow; r++) {
      const moneyIndexes = [7, 8, ...(includeChalongFields ? [9, 10] : []), includeChalongFields ? 11 : 9, includeChalongFields ? 15 : 13];
      moneyIndexes.map((index) => XLSX.utils.encode_col(index)).forEach((col) => {
         const c = eventsWs[`${col}${r}`]; if (c) c.z = '"฿"#,##0.00';
      });
      const shareCol = XLSX.utils.encode_col(includeChalongFields ? 12 : 10);
      const kCell = eventsWs[`${shareCol}${r}`]; if (kCell) kCell.z = "0.0%";
    }
    XLSX.utils.book_append_sheet(wb, eventsWs, "Events");

    // ---------- Sheet 3: Entertainment breakdown ----------
    if (entertainmentBreakdown.length) {
      const entAoa: (string | number)[][] = [
        ["Item", "Events", "Total qty", "Revenue (THB)", "Avg revenue / event (THB)", "Avg qty / event"],
      ];
      for (const it of entertainmentBreakdown) {
        entAoa.push([
          it.name,
          it.events,
          it.qty,
          it.revenue,
          it.revenue / it.events,
          Number((it.qty / it.events).toFixed(2)),
        ]);
      }
      const entTotalEvents = entertainmentBreakdown.reduce((s, i) => s + i.events, 0);
      const entTotalQty = entertainmentBreakdown.reduce((s, i) => s + i.qty, 0);
      const entTotalRev = entertainmentBreakdown.reduce((s, i) => s + i.revenue, 0);
      entAoa.push(["TOTAL", entTotalEvents, entTotalQty, entTotalRev, "", ""]);
      const entWs = XLSX.utils.aoa_to_sheet(entAoa);
      entWs["!cols"] = [{ wch: 36 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 16 }];
      entWs["!freeze"] = { xSplit: 0, ySplit: 1 };
      const entLast = entAoa.length;
      for (let r = 2; r <= entLast; r++) {
        ["D", "E"].forEach((col) => {
          const c = entWs[`${col}${r}`]; if (c) c.z = '"฿"#,##0.00';
        });
      }
      XLSX.utils.book_append_sheet(wb, entWs, "Entertainment");
    }

    // ---------- Sheet 4: Daily totals ----------
    const dailyMap = new Map<string, { events: number; pkg: number; fnb: number; extras: number; adjustment: number; total: number }>();
    for (const e of filteredEvents) {
      const ex = dailyMap.get(e.date) || { events: 0, pkg: 0, fnb: 0, extras: 0, adjustment: 0, total: 0 };
      ex.events += 1; ex.pkg += e.packageRevenue; ex.fnb += e.fnbRevenue;
      ex.extras += eventExtras(e);
      ex.adjustment += Number(e.reconciliationRevenue || 0);
      ex.total += Number(e.totalRevenue || 0);
      dailyMap.set(e.date, ex);
    }
    if (dailyMap.size) {
      const dailyAoa: (string | number)[][] = [
        [
          "Date", "Day", "Events", `${includeChalongFields ? "Package / tickets" : "Package"} (THB)`, "F&B (THB)",
          ...(includeChalongFields ? ["Extras (THB)", "Adjustment (THB)"] : []),
          "Total (THB)", "Avg / event (THB)",
        ],
      ];
      const dates = Array.from(dailyMap.keys()).sort();
      for (const d of dates) {
        const v = dailyMap.get(d)!;
        const row: (string | number)[] = [d, dayOfWeek(d), v.events, v.pkg, v.fnb];
        if (includeChalongFields) row.push(v.extras, v.adjustment);
        row.push(v.total, v.total / v.events);
        dailyAoa.push(row);
      }
      const dailyWs = XLSX.utils.aoa_to_sheet(dailyAoa);
      dailyWs["!cols"] = [
        { wch: 11 }, { wch: 5 }, { wch: 8 }, { wch: 20 }, { wch: 14 },
        ...(includeChalongFields ? [{ wch: 14 }, { wch: 14 }] : []),
        { wch: 14 }, { wch: 16 },
      ];
      dailyWs["!freeze"] = { xSplit: 0, ySplit: 1 };
      for (let r = 2; r <= dailyAoa.length; r++) {
        const dailyMoneyIndexes = [3, 4, ...(includeChalongFields ? [5, 6] : []), includeChalongFields ? 7 : 5, includeChalongFields ? 8 : 6];
        dailyMoneyIndexes.map((index) => XLSX.utils.encode_col(index)).forEach((col) => {
          const c = dailyWs[`${col}${r}`]; if (c) c.z = '"฿"#,##0.00';
        });
      }
      XLSX.utils.book_append_sheet(wb, dailyWs, "Daily totals");
    }

    XLSX.writeFile(wb, `${fileBase}.xlsx`);
  };

  // jspdf's default Helvetica is WinAnsi-only — Thai baht, em-dash, right
  // arrow, and the multiplication sign all render as "?". Replace them with
  // safe ASCII before any text() call.
  const pdfSafe = (s: string | number | null | undefined): string => {
    let v = String(s ?? "");
    v = v
      .replace(/฿/g, "THB ")
      .replace(/→/g, "to")
      .replace(/[—–]/g, "-")
      .replace(/−/g, "-")
      .replace(/×/g, "x")
      .replace(/·/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, "...");
    // Drop anything else outside printable ASCII range so jspdf doesn't render "?"
    return v.replace(/[^\x20-\x7E]/g, "");
  };
  const fmtPdfAmount = (n: number) =>
    Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const fmtTHB = (n: number) => `THB ${fmtPdfAmount(n)}`;

  const exportPdf = async () => {
    const { jsPDF } = await import("jspdf");
    const autoTableMod = await import("jspdf-autotable");
    const autoTable = (autoTableMod as any).default || (autoTableMod as any).autoTable || (autoTableMod as any);

    const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 36;

    const branchLabel = branchFilter === "all" ? "All branches" : BRANCH_LABELS[branchFilter as Branch];
    const packageLabel = packageFilter === "all" ? "All packages" : packageFilter;
    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16);

    // ---------- Header band ----------
    doc.setFillColor(31, 41, 55); // slate-800
    doc.rect(0, 0, pageWidth, 64, "F");
    doc.setTextColor(255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("OTO Radar", margin, 28);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Events Report", margin, 46);
    doc.setFontSize(9);
    doc.setTextColor(200);
    const meta = pdfSafe(`${range.from} to ${range.to}   |   ${branchLabel}   |   ${packageLabel}   |   Generated ${generatedAt}`);
    doc.text(meta, pageWidth - margin, 28, { align: "right" });
    doc.setTextColor(0);

    // ---------- KPI summary cards ----------
    const kpis: Array<[string, string]> = [
      ["Total events", String(totals.eventCount)],
      ["Total revenue", fmtTHB(totals.totalRev)],
      [includeChalongFields ? "Package / tickets revenue" : "Package revenue", fmtTHB(totals.packageRev)],
      ["F&B revenue", fmtTHB(totals.fnbRev)],
      ...(hasExtras ? [["Extras", fmtTHB(totals.otherRev)] as [string, string]] : []),
      ...(hasAdjustment ? [["Adjustment", formatAdjustment(totals.adjustment)] as [string, string]] : []),
      ["Avg / event", fmtTHB(totals.avg)],
      ["Most popular", pdfSafe(`${totals.topPackage}${totals.topPackageCount ? ` (${totals.topPackageCount})` : ""}`)],
    ];
    const cardsY = 84;
    const cardGap = 10;
    const cardW = (pageWidth - margin * 2 - cardGap * (kpis.length - 1)) / kpis.length;
    const cardH = 56;
    kpis.forEach(([label, value], i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(247, 248, 250);
      doc.setDrawColor(228, 231, 236);
      doc.roundedRect(x, cardsY, cardW, cardH, 6, 6, "FD");
      doc.setTextColor(110);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(pdfSafe(label).toUpperCase(), x + 10, cardsY + 16);
      doc.setTextColor(17, 24, 39);
      doc.setFont("helvetica", "bold");
      const valueLines = doc.splitTextToSize(pdfSafe(value), cardW - 20);
      doc.setFontSize(value.length > 18 ? 10 : 13);
      doc.text(valueLines.slice(0, 2), x + 10, cardsY + 34);
    });

    // ---------- Events table ----------
    const eventBody = filteredEvents.map((e) => {
      const items = e.entertainmentItems || [];
      const ent = items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join(", ") || "-";
      const row: (string | number)[] = [
        e.date,
        dayOfWeek(e.date),
        BRANCH_LABELS[e.branch],
        e.partyOrderCode,
        e.packageName,
        fmtPdfAmount(e.packageRevenue),
        fmtPdfAmount(e.fnbRevenue),
      ];
      if (includeChalongFields) {
        row.push(
          fmtPdfAmount(eventExtras(e)),
          fmtPdfAmount(Number(e.reconciliationRevenue || 0)),
        );
      }
      row.push(fmtPdfAmount(e.totalRevenue), ent);
      return row.map(pdfSafe);
    });
    if (filteredEvents.length) {
      const totalRow: (string | number)[] = [
        "TOTAL",
        "",
        "",
        "",
        `${filteredEvents.length} events`,
        fmtPdfAmount(totals.packageRev),
        fmtPdfAmount(totals.fnbRev),
      ];
      if (includeChalongFields) {
        totalRow.push(
          fmtPdfAmount(totals.otherRev),
          fmtPdfAmount(totals.adjustment),
        );
      }
      totalRow.push(fmtPdfAmount(totals.totalRev), "");
      eventBody.push(totalRow.map(pdfSafe));
    }

    const pdfTotalCol = includeChalongFields ? 9 : 7;
    const pdfEntCol = pdfTotalCol + 1;
    const pdfPackageLabel = includeChalongFields ? "Package / tickets" : "Package";
    const pdfHead = [
      "Date", "Day", "Branch", "Order code", pdfPackageLabel,
      `${pdfPackageLabel} (THB)`, "F&B (THB)",
      ...(includeChalongFields ? ["Extras (THB)", "Adjustment (THB)"] : []),
      "Total (THB)", "Entertainment",
    ];
    const pdfColumnStyles: Record<number, any> = {
      0: { cellWidth: 58 },
      1: { cellWidth: 28 },
      2: { cellWidth: 88 },
      3: { cellWidth: 70 },
      4: { cellWidth: 130 },
      5: { cellWidth: 64, halign: "right" },
      6: { cellWidth: 60, halign: "right" },
      [includeChalongFields ? 7 : 7]: { cellWidth: 52, halign: "right" },
      ...(includeChalongFields ? { 8: { cellWidth: 58, halign: "right" } } : {}),
      [pdfTotalCol]: { cellWidth: 68, halign: "right", fontStyle: "bold" },
      [pdfEntCol]: { cellWidth: "auto" },
    };
    autoTable(doc, {
      startY: cardsY + cardH + 16,
      head: [pdfHead],
      body: eventBody,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 4, overflow: "linebreak", valign: "middle" },
      headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: "bold", fontSize: 8.5 },
      alternateRowStyles: { fillColor: [247, 248, 250] },
      columnStyles: pdfColumnStyles,
      didParseCell: (data: any) => {
        if (data.row.index === eventBody.length - 1 && filteredEvents.length) {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.fillColor = [229, 231, 235];
        }
      },
      margin: { left: margin, right: margin },
    });

    // ---------- Entertainment breakdown ----------
    if (entertainmentBreakdown.length) {
      const afterY = (doc as any).lastAutoTable.finalY + 18;
      if (afterY > pageHeight - 120) doc.addPage();
      const startY = afterY > pageHeight - 120 ? margin : afterY;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(17, 24, 39);
       doc.text("Entertainment item breakdown", margin, startY);
      const entBody = entertainmentBreakdown.map((it) => [
        it.name,
        String(it.events),
        String(it.qty),
         fmtPdfAmount(it.revenue),
         fmtPdfAmount(it.revenue / it.events),
      ].map(pdfSafe));
      const entTotalRev = entertainmentBreakdown.reduce((s, i) => s + i.revenue, 0);
      const entTotalQty = entertainmentBreakdown.reduce((s, i) => s + i.qty, 0);
      const entTotalEvents = entertainmentBreakdown.reduce((s, i) => s + i.events, 0);
      entBody.push([
        "TOTAL",
        String(entTotalEvents),
        String(entTotalQty),
         fmtPdfAmount(entTotalRev),
        "",
      ]);
      autoTable(doc, {
        startY: startY + 6,
        head: [["Item", "Events", "Qty", "Revenue (THB)", "Avg / event (THB)"]],
        body: entBody,
        theme: "grid",
        styles: { font: "helvetica", fontSize: 8.5, cellPadding: 4 },
        headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [247, 248, 250] },
        columnStyles: {
          0: { cellWidth: "auto" },
          1: { cellWidth: 50, halign: "right" },
          2: { cellWidth: 50, halign: "right" },
          3: { cellWidth: 90, halign: "right" },
          4: { cellWidth: 110, halign: "right" },
        },
        didParseCell: (data: any) => {
          if (data.row.index === entBody.length - 1) {
            data.cell.styles.fontStyle = "bold";
            data.cell.styles.fillColor = [229, 231, 235];
          }
        },
        margin: { left: margin, right: margin },
      });
    }

    // ---------- Footer with page numbers ----------
    const pageCount = (doc as any).internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(pdfSafe(`OTO Radar - Events report - Generated ${generatedAt}`), margin, pageHeight - 16);
      doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 16, { align: "right" });
    }

    doc.save(`${fileBase}.pdf`);
  };

  const handleRowClick = (e: EventRowApi) => {
    if (e.branch !== "floresta") return;
    setOpenCard({
      id: e.partyOrderId,
      partyOrderCode: e.partyOrderCode,
      partyPackages: e.partyPackages && e.partyPackages.length ? e.partyPackages : [e.packageName],
      combined: e.totalRevenue,
      packageRev: e.packageRevenue,
      link: e.link ?? null,
    });
  };

  const sortLabels: Record<EventsSortKey, string> = {
    date: "Newest first",
    total: "Largest revenue",
    packageRev: "Largest package",
    fnbRev: "Largest F&B",
    package: "Package name",
    branch: "Branch",
  };

  return (
    <div className="space-y-4" data-testid="events-tab">
      {/* Filter & export bar */}
      <div className="neu-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <DateRangePicker
            from={range.from}
            to={range.to}
            onChange={(v) => { if (v.from && v.to) setRange({ from: v.from, to: v.to }); }}
            data-testid="picker-events-range"
          />
          <select
            className="neu-inset rounded-lg px-3 py-2 text-sm bg-transparent min-h-[36px]"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value as "all" | "floresta" | "chalong")}
            data-testid="select-branch-filter"
          >
            <option value="all">All branches</option>
            <option value="floresta">{BRANCH_LABELS.floresta}</option>
            <option value="chalong">{BRANCH_LABELS.chalong}</option>
          </select>
          <select
            className="neu-inset rounded-lg px-3 py-2 text-sm bg-transparent min-h-[36px] max-w-[200px]"
            value={packageFilter}
            onChange={(e) => setPackageFilter(e.target.value)}
            data-testid="select-package-filter"
          >
            <option value="all">All packages</option>
            {packageOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            className="neu-inset rounded-lg px-3 py-2 text-sm bg-transparent min-h-[36px]"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as EventsSortKey)}
            data-testid="select-sort"
          >
            {(Object.keys(sortLabels) as EventsSortKey[]).map((k) => (
              <option key={k} value={k}>Sort: {sortLabels[k]}</option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            data-testid="button-sort-dir"
            title={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={exportExcel}
              disabled={!filteredEvents.length}
              data-testid="button-export-excel"
            >
              Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportPdf}
              disabled={!filteredEvents.length}
              data-testid="button-export-pdf"
            >
              PDF
            </Button>
          </div>
        </div>
        {branchFilter === "floresta" && (
          <div className="mt-3">
            <EventsPosRefresh range={range} />
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total events", value: String(totals.eventCount), id: "events", sub: undefined as string | undefined },
          {
            label: "Total revenue",
            value: formatEventsMoney(totals.totalRev),
            id: "total-rev",
            sub: [
              `${formatEventsMoney(totals.packageRev)} package / tickets`,
              `${formatEventsMoney(totals.fnbRev)} F&B`,
              ...(hasExtras ? [`${formatEventsMoney(totals.otherRev)} Extras`] : []),
              ...(hasAdjustment ? [`${formatAdjustment(totals.adjustment)} Adjustment`] : []),
            ].join(" · "),
          },
          { label: "Avg per event", value: formatEventsMoney(totals.avg), id: "avg", sub: undefined },
          { label: "Top package", value: totals.topPackage, id: "top-package", sub: totals.topPackageCount ? `${totals.topPackageCount} event${totals.topPackageCount === 1 ? "" : "s"}` : undefined },
        ].map((c) => (
          <div key={c.id} className="neu-card p-3 sm:p-4" data-testid={`card-events-summary-${c.id}`}>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="text-lg sm:text-xl font-semibold mt-1 privacy-sensitive truncate" title={c.value}>{c.value}</div>
            {c.sub && <div className="text-[11px] text-muted-foreground mt-0.5 privacy-sensitive truncate" title={c.sub}>{c.sub}</div>}
          </div>
        ))}
      </div>
      {branchFilter === "floresta" && (
        <div className="text-[11px] text-muted-foreground" data-testid="events-amount-basis">
          Amount basis: <span className="font-medium text-foreground">Non-voucher payments recorded in selected period</span>.
          Dates come from POS reports and may differ from reservation dates; this is not a verified calendar reservation count.
        </div>
      )}
      {branchFilter !== "floresta" && (
        <div className="text-[11px] text-muted-foreground" data-testid="events-amount-basis-chalong">
          Chalong amount basis: <span className="font-medium text-foreground">completed Papaya Birthday-channel order totals after discounts, including extras</span>;
          cancelled lines are excluded. F&amp;B is shown only when it is within the order; no restaurant links are inferred.
          Any reconciliation adjustment is shown separately from the Extras subtotal.
        </div>
      )}

      {/* Events list — card rows, easy to scan */}
      <div className="space-y-3" data-testid="events-list">
        {query.isLoading ? (
          <div className="space-y-2" data-testid="events-loading">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="neu-card p-6 text-center text-sm text-destructive" data-testid="text-events-error">
            Failed to load events.{" "}
            <button className="underline" onClick={() => query.refetch()} data-testid="button-events-retry">Retry</button>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="neu-card p-8 text-center text-sm text-muted-foreground" data-testid="text-events-empty">
            No events in this range.
          </div>
        ) : (
          filteredEvents.map((e) => {
            const clickable = e.branch === "floresta";
            return (
              <div
                key={`${e.branch}-${e.partyOrderId}`}
                className={cn(
                  "neu-card p-3 sm:p-4 transition-shadow",
                  clickable && "cursor-pointer hover:shadow-md",
                )}
                onClick={() => handleRowClick(e)}
                data-testid={`row-event-${e.partyOrderId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{formatNiceDate(e.date)}</span>
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                        e.branch === "floresta" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-sky-500/15 text-sky-700 dark:text-sky-300",
                      )}>
                        {BRANCH_LABELS[e.branch]}
                      </span>
                      <span className="text-muted-foreground/70">#{e.partyOrderCode}</span>
                      {e.branch === "floresta" && e.link?.fnbOrderCode && (
                        <span className="text-muted-foreground/70 font-mono" data-testid={`text-fnb-code-${e.partyOrderId}`}>
                          · F&amp;B #{e.link.fnbOrderCode}
                        </span>
                      )}
                    </div>
                    <div className="text-sm sm:text-base font-medium mt-1 truncate" title={e.packageName}>
                      {e.packageName}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-semibold privacy-sensitive">{formatEventsMoney(e.totalRevenue)}</div>
                    <div className="text-[11px] text-muted-foreground privacy-sensitive">
                      {formatEventsMoney(e.packageRevenue)} {packageSummaryLabel}
                      {e.fnbRevenue > 0 ? ` · ${formatEventsMoney(e.fnbRevenue)} F&B` : ""}
                      {eventExtras(e) !== 0 ? ` · ${formatEventsMoney(eventExtras(e))} Extras` : ""}
                      {Number(e.reconciliationRevenue || 0) !== 0
                        ? ` · ${formatAdjustment(Number(e.reconciliationRevenue || 0))} Adjustment`
                        : ""}
                    </div>
                  </div>
                </div>
                {e.entertainmentItems && e.entertainmentItems.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {e.entertainmentItems.map((it) => (
                      <span
                        key={it.name}
                        className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[11px]"
                        title={`${it.name} · ${formatEventsMoney(it.revenue)}`}
                        data-testid={`chip-entertainment-${e.partyOrderId}-${it.name}`}
                      >
                        {it.name}{it.qty > 1 ? ` ×${it.qty}` : ""}
                      </span>
                    ))}
                  </div>
                )}
                {e.branch === "floresta" && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="text-[11px] text-muted-foreground">
                      {e.link?.fnbOrderCode
                        ? <>F&amp;B attached{e.link?.fnbOrderCode ? <> · <span className="font-mono">#{e.link.fnbOrderCode}</span></> : null}</>
                        : <>No F&amp;B linked</>}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setOpenLinker({ date: e.date, partyOrderCode: e.partyOrderCode, packageName: e.packageName });
                      }}
                      data-testid={`button-link-fnb-${e.partyOrderId}`}
                    >
                      {e.link?.fnbOrderCode ? "Manage F&B link" : "Link F&B"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Popular entertainment items — collapsible */}
      {entertainmentBreakdown.length > 0 && (
        <details className="neu-card overflow-hidden" data-testid="entertainment-section">
          <summary className="p-3 sm:p-4 cursor-pointer flex items-center justify-between text-sm font-medium select-none">
            <span>Popular entertainment items</span>
            <span className="text-xs text-muted-foreground">{entertainmentBreakdown.length} item{entertainmentBreakdown.length === 1 ? "" : "s"}</span>
          </summary>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-left">
                  {([
                    ["name", "Item", "left"],
                    ["events", "Events", "right"],
                    ["qty", "Qty", "right"],
                    ["revenue", "Revenue", "right"],
                  ] as Array<["name" | "events" | "qty" | "revenue", string, "left" | "right"]>).map(([k, label, align]) => (
                    <th
                      key={k}
                      className={cn(
                        "px-3 py-2 cursor-pointer select-none whitespace-nowrap",
                        align === "right" && "text-right",
                      )}
                      onClick={() => toggleEntSort(k)}
                      data-testid={`th-ent-${k}`}
                    >
                      {label}{entSortKey === k ? (entSortDir === "asc" ? " ↑" : " ↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entertainmentBreakdown.map((it) => (
                  <tr key={it.name} className="border-t" data-testid={`row-entertainment-${it.name}`}>
                    <td className="px-3 py-2">{it.name}</td>
                    <td className="px-3 py-2 text-right">{it.events}</td>
                    <td className="px-3 py-2 text-right">{it.qty}</td>
                    <td className="px-3 py-2 text-right privacy-sensitive">{formatEventsMoney(it.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <BirthdayOrderDialog card={openCard} onClose={() => setOpenCard(null)} />
      <LinkFnbDialog
        open={!!openLinker}
        onClose={() => setOpenLinker(null)}
        date={openLinker?.date || ""}
        partyOrderCode={openLinker?.partyOrderCode || ""}
        partyPackageName={openLinker?.packageName || ""}
      />
    </div>
  );
}

function TrendsTab({ activeBranches }: { activeBranches: ActiveBranches }) {
  const [chatMessages, setChatMessages] = useState<TrendMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastChartSpec = useRef<any>(null);
  const [savedConvos, setSavedConvos] = useState<SavedConversation[]>(() => loadSavedConversations());
  const [showHistory, setShowHistory] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);

  const getMetricName = (key: string) => ALL_METRICS.find(m => m.key === key)?.name || key;

  const handleSaveConversation = () => {
    if (chatMessages.length === 0) return;
    const id = activeConvoId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const title = generateConvoTitle(chatMessages);
    const convo: SavedConversation = { id, title, messages: chatMessages, lastChartSpec: lastChartSpec.current, savedAt: new Date().toISOString() };
    const updated = [convo, ...savedConvos.filter(c => c.id !== id)].slice(0, 20);
    setSavedConvos(updated);
    saveTrendsConversations(updated);
    setActiveConvoId(id);
  };

  const handleLoadConversation = (convo: SavedConversation) => {
    setChatMessages(convo.messages);
    lastChartSpec.current = convo.lastChartSpec || null;
    setActiveConvoId(convo.id);
    setShowHistory(false);
  };

  const handleDeleteConversation = (id: string) => {
    const updated = savedConvos.filter(c => c.id !== id);
    setSavedConvos(updated);
    saveTrendsConversations(updated);
    if (activeConvoId === id) setActiveConvoId(null);
  };

  const handleNewConversation = () => {
    setChatMessages([]);
    lastChartSpec.current = null;
    setActiveConvoId(null);
    setShowHistory(false);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chatMessages]);

  const handleSend = useCallback(async (msg: string) => {
    if (!msg.trim() || loading) return;

    setInput("");
    setChatMessages(prev => [...prev, { role: "user", content: msg }]);
    setLoading(true);

    try {
      const today = getBangkokToday();

      const aiRes = await apiRequest("POST", "/api/funtopia/trends-parse", {
        message: msg,
        today,
        previousChart: lastChartSpec.current,
      });
      const parsed = await aiRes.json();

      const metrics = parsed.metrics || ["netRevenue"];
      const gBy = parsed.groupBy || "weekly";
      const cType = parsed.chartType || "bar";
      const dFrom = parsed.dateFrom || null;
      const dTo = parsed.dateTo || today;
      const agg = parsed.aggregation || "sum";

      lastChartSpec.current = {
        metrics, groupBy: gBy, chartType: cType,
        dateFrom: dFrom, dateTo: dTo, aggregation: agg,
      };

      const chartRes = await apiRequest("POST", "/api/funtopia/chart-builder", {
        metrics, groupBy: gBy, chartType: cType,
        dateFrom: dFrom, dateTo: dTo, aggregation: agg,
        branches: Array.from(activeBranches),
      });
      const result = await chartRes.json();

      if (cType === "pie" && result.data) {
        result.data = result.data.map((d: any) => ({ ...d, metricKey: d.name, name: getMetricName(d.name) }));
      }
      if (result.series) {
        result.series = result.series.map((s: any) => ({ ...s, name: getMetricName(s.name) }));
      }

      const chartData = { ...result, chartType: cType };
      const metricNames = metrics.map(getMetricName).join(", ");
      const groupLabel = GROUP_OPTIONS.find(g => g.key === gBy)?.label || gBy;
      let dateLabel = "All time";
      if (dFrom) dateLabel = `${dFrom} to ${dTo}`;
      const summary = `${metricNames} · ${groupLabel} · ${dateLabel}`;

      setChatMessages(prev => [...prev, {
        role: "assistant",
        content: parsed.reply || "Here's your chart.",
        chartData,
        summary,
      }]);
    } catch (err: any) {
      setChatMessages(prev => [...prev, {
        role: "assistant",
        content: `Sorry, something went wrong. ${err.message || "Please try again."}`,
      }]);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const handleQuickChart = async (qc: typeof QUICK_CHARTS[0]) => {
    setChatMessages([]);
    lastChartSpec.current = null;
    setLoading(true);
    try {
      const today = getBangkokToday();
      const dateFrom = qc.days > 0 ? (() => {
        const dt = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
        dt.setDate(dt.getDate() - qc.days);
        return fmtDateLocal(dt);
      })() : null;

      const res = await apiRequest("POST", "/api/funtopia/chart-builder", {
        metrics: qc.metrics,
        groupBy: qc.groupBy,
        chartType: qc.chartType,
        dateFrom,
        dateTo: today,
        aggregation: (qc as any).aggregation || (qc.groupBy === "dayOfWeek" ? "avg" : "sum"),
        branches: Array.from(activeBranches),
      });
      const result = await res.json();

      if (qc.chartType === "pie" && result.data) {
        result.data = result.data.map((d: any) => ({ ...d, metricKey: d.name, name: getMetricName(d.name) }));
      }
      if (result.series) {
        result.series = result.series.map((s: any) => ({ ...s, name: getMetricName(s.name) }));
      }

      const chartData = { ...result, chartType: qc.chartType };
      const groupLabel = GROUP_OPTIONS.find(g => g.key === qc.groupBy)?.label || qc.groupBy;
      const rangeLabel = DATE_RANGE_OPTIONS.find(r => r.days === qc.days)?.label || "Custom";

      setChatMessages([{
        role: "assistant",
        content: `Here's your ${qc.label} chart.`,
        chartData,
        summary: `${qc.metrics.map(getMetricName).join(", ")} · ${groupLabel} · ${rangeLabel}`,
      }]);
    } catch {
      setChatMessages([{ role: "assistant", content: "Failed to generate chart." }]);
    } finally {
      setLoading(false);
    }
  };

  const EXAMPLE_QUESTIONS = [
    "How did revenue trend this month?",
    "Show me F&B vs tickets weekly",
    "Category breakdown as pie chart",
    "Tourist vs Thai kids in January",
    "Best day of the week for revenue",
    "Daily guest count last 14 days",
  ];

  return (
    <div className="space-y-3">
      <div className="neu-card overflow-hidden flex flex-col" style={{ minHeight: "500px" }}>
        <div className="p-3 border-b border-border/40 flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-orange-500" />
          <span className="font-semibold text-sm">Ask about your data</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={cn("text-[10px] px-2 py-0.5 rounded-md transition-colors flex items-center gap-1",
                showHistory ? "text-orange-500 bg-orange-500/10" : "text-muted-foreground hover:text-foreground hover:bg-muted/60")}
              data-testid="btn-trend-history"
            >
              <History className="h-3 w-3" />
              {savedConvos.length > 0 && <span>{savedConvos.length}</span>}
            </button>
            {chatMessages.length > 0 && (
              <>
                <button
                  onClick={handleSaveConversation}
                  className="text-[10px] px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors flex items-center gap-1"
                  data-testid="btn-trend-save"
                >
                  <Save className="h-3 w-3" />
                  {activeConvoId ? "Update" : "Save"}
                </button>
                <button
                  onClick={handleNewConversation}
                  className="text-[10px] px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  data-testid="btn-trend-clear"
                >
                  New
                </button>
              </>
            )}
          </div>
        </div>

        {showHistory && (
          <div className="border-b border-border/40 bg-muted/20 max-h-[200px] overflow-y-auto">
            {savedConvos.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-xs text-muted-foreground">No saved conversations yet</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">Chat with your data, then hit Save to keep it</p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {savedConvos.map(convo => (
                  <div
                    key={convo.id}
                    className={cn("flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors group",
                      activeConvoId === convo.id ? "bg-orange-500/10 text-orange-600 dark:text-orange-400" : "hover:bg-muted/60")}
                  >
                    <button
                      onClick={() => handleLoadConversation(convo)}
                      className="flex-1 text-left min-w-0"
                      data-testid={`btn-load-convo-${convo.id}`}
                    >
                      <p className="text-[11px] font-medium truncate">{convo.title}</p>
                      <p className="text-[9px] text-muted-foreground/60">
                        {convo.messages.filter(m => m.role === "user").length} messages · {new Date(convo.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      </p>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteConversation(convo.id); }}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all p-0.5"
                      data-testid={`btn-delete-convo-${convo.id}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3" ref={scrollRef}>
          {chatMessages.length === 0 && !loading && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {QUICK_CHARTS.map((qc, i) => (
                  <button
                    key={i}
                    onClick={() => handleQuickChart(qc)}
                    className="text-[11px] px-2.5 py-1.5 rounded-full border border-orange-500/30 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 transition-colors"
                    data-testid={`btn-quick-chart-${i}`}
                  >
                    {qc.label}
                  </button>
                ))}
              </div>

              <div className="text-center py-3">
                <Sparkles className="h-8 w-8 text-orange-500/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  Ask anything about your Funtopia data
                </p>
                <p className="text-[10px] text-muted-foreground/60">
                  Charts are built from the same data on the dashboard
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 font-medium px-1">Try asking:</p>
                {EXAMPLE_QUESTIONS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => handleSend(q)}
                    className="w-full text-left text-[11px] px-3 py-2 rounded-lg hover:bg-muted/40 text-foreground/70 hover:text-foreground transition-colors"
                    data-testid={`btn-example-q-${i}`}
                  >
                    "{q}"
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            {chatMessages.map((msg, i) => (
              <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role === "user" ? (
                  <div className="max-w-[85%] rounded-xl px-3 py-2 bg-orange-500 text-white">
                    <p className="text-xs">{msg.content}</p>
                  </div>
                ) : (
                  <div className="w-full space-y-2">
                    <p className="text-xs text-foreground/80 px-1">{msg.content}</p>
                    {msg.chartData && msg.chartData.data && msg.chartData.data.length > 0 && (
                      <div className="neu-card p-3 w-full space-y-2">
                        <TrendsChart chartData={msg.chartData} />
                        {(() => {
                          const normalized = normalizeChartData(msg.chartData);
                          const insight = generateChartInsight(normalized);
                          return (
                            <>
                              {insight && (
                                <div className="px-2 py-1.5 rounded-md bg-muted/30 border border-border/30">
                                  <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">Summary</p>
                                  <p className="text-[11px] text-foreground/80 leading-relaxed">{insight}</p>
                                </div>
                              )}
                              <CalcBreakdown chartData={msg.chartData} />
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {msg.summary && (
                      <p className="text-[10px] text-muted-foreground/70 px-1">{msg.summary}</p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-muted/60 dark:bg-muted/30 rounded-xl px-3 py-2 flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin text-orange-500" />
                  <span className="text-xs text-muted-foreground">Charting your data...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-3 border-t border-border/40">
          <form
            onSubmit={(e) => { e.preventDefault(); handleSend(input); }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about revenue, guests, categories..."
              className="flex-1 text-xs rounded-lg border border-border/60 bg-background px-3 py-2 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-orange-500/50"
              disabled={loading}
              data-testid="input-trend-chat"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-3 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
              data-testid="btn-trend-send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function IntelligenceCalendarTab({ activeBranches }: { activeBranches: ActiveBranches }) {
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [noteText, setNoteText] = useState("");
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    dateStr: string;
  } | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<{
    month: number;
    year: number;
  } | null>(null);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("revenue");
  const [calendarYear, setCalendarYear] = useState(2026);

  const hasFloresta = activeBranches.has("floresta");
  const hasChalong = activeBranches.has("chalong");
  const chalongOnly = hasChalong && !hasFloresta;
  const branchKey = Array.from(activeBranches).sort().join(",");

  const startDate = `${calendarYear - 1}-01-01`;
  const endDate = `${calendarYear}-12-31`;

  useEffect(() => {
    if (chalongOnly && heatmapMode === "forecast") {
      setHeatmapMode("revenue");
    } else if (!chalongOnly && heatmapMode === "stly") {
      setHeatmapMode("revenue");
    }
  }, [chalongOnly, heatmapMode]);

  const { data: yearData, isLoading } = useQuery<{
    dailyRevenue: Array<{ date: string; revenue: number; orders: number }>;
    cashReportsDailyTotals: Array<{ date: string; revenue: number; florestaRevenue?: number }>;
  }>({
    // Distinct queryKey from the heavy `/api/funtopia/range` cache used by the
    // Dashboard so this slim payload stays separate.
    queryKey: ["/api/calendar/range-slim", branchKey, startDate, endDate, "yearly-heatmap"],
    queryFn: async () => {
      const fetchers: Promise<any>[] = [];
      if (hasFloresta) fetchers.push(fetch(`/api/funtopia/calendar-range?start=${startDate}&end=${endDate}`).then(r => r.json()));
      if (hasChalong) fetchers.push(fetch(`/api/papaya/calendar-range?from=${startDate}&to=${endDate}`).then(r => r.json()));
      const results = await Promise.all(fetchers);
      // Merge slim shapes by date: sum revenue + orders across branches.
      const byDate = new Map<string, { date: string; revenue: number; orders: number }>();
      let cashReports: Array<{ date: string; revenue: number; florestaRevenue?: number }> = [];
      for (const r of results) {
        for (const d of (r?.dailyRevenue || [])) {
          if (!d?.date) continue;
          const existing = byDate.get(d.date);
          if (existing) {
            existing.revenue += d.revenue || 0;
            existing.orders += d.orders || 0;
          } else {
            byDate.set(d.date, { date: d.date, revenue: d.revenue || 0, orders: d.orders || 0 });
          }
        }
        if (r?.cashReportsDailyTotals) cashReports = r.cashReportsDailyTotals;
      }
      return {
        dailyRevenue: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
        cashReportsDailyTotals: cashReports,
      };
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: calendarNotes } = useQuery<Record<string, string>>({
    queryKey: ["/api/funtopia/calendar-notes", startDate, endDate],
    queryFn: async () => {
      const res = await fetch(
        `/api/funtopia/calendar-notes?start=${startDate}&end=${endDate}`,
      );
      return res.json();
    },
  });

  const { data: birthdays } = useBirthdays(activeBranches);
  const birthdayMap = useMemo(() => {
    const m = new Map<string, StaffBirthday[]>();
    if (!birthdays) return m;
    for (const b of birthdays) {
      const key = `${String(b.birthMonth).padStart(2, "0")}-${String(b.birthDay).padStart(2, "0")}`;
      const list = m.get(key) || [];
      list.push(b);
      m.set(key, list);
    }
    return m;
  }, [birthdays]);

  const getEventsForDate = useCallback(
    (date: string): Array<{ name: string; type: HolidayType }> => {
      const events = getAllHolidaysForDate(date);
      const mmdd = date.slice(5);
      const bds = birthdayMap.get(mmdd);
      if (bds && bds.length > 0) {
        const names = bds.map((b) => b.name).join(", ");
        events.push({ name: `🎂 ${names}`, type: "birthday" });
      }
      return events;
    },
    [birthdayMap],
  );

  const saveNoteMutation = useMutation({
    mutationFn: async ({ date, note }: { date: string; note: string }) => {
      await apiRequest("POST", "/api/funtopia/calendar-notes", { date, note });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/funtopia/calendar-notes"],
      });
      setNoteDialogOpen(false);
    },
  });

  const revenueMap = useMemo(() => {
    const m = new Map<string, { revenue: number; orders: number }>();
    // Pass 1: manual cash reports (Floresta historical entries from
    // funtopia_daily_revenue). These cover dates not yet synced from the POS.
    // Only apply when Floresta is in the active branch set.
    if (hasFloresta && yearData?.cashReportsDailyTotals) {
      for (const d of yearData.cashReportsDailyTotals) {
        if (!d?.date) continue;
        m.set(d.date, { revenue: d.revenue || 0, orders: 0 });
      }
    }
    // Pass 2: aggregated daily revenue from POS caches (and Papaya merge).
    // POS data is the source of truth where available, so it overrides any
    // matching manual cash report entry for the same date.
    if (yearData?.dailyRevenue) {
      for (const d of yearData.dailyRevenue) {
        if (!d?.date) continue;
        const rev = d.revenue || 0;
        const ord = d.orders || 0;
        if (rev > 0 || ord > 0) {
          m.set(d.date, { revenue: rev, orders: ord });
        } else if (!m.has(d.date)) {
          m.set(d.date, { revenue: 0, orders: 0 });
        }
      }
    }
    return m;
  }, [yearData, hasFloresta]);

  const maxRevenue = useMemo(() => {
    let max = 0;
    const yearPrefix = `${calendarYear}-`;
    revenueMap.forEach((v, k) => {
      if (k.startsWith(yearPrefix) && v.revenue > max) max = v.revenue;
    });
    return max;
  }, [revenueMap, calendarYear]);

  const academicMonths = useMemo(() => {
    const arr: Array<{ month: number; year: number }> = [];
    for (let i = 0; i < 12; i++) {
      arr.push({ month: i, year: calendarYear });
    }
    return arr;
  }, [calendarYear]);

  const todayStr = getBangkokToday();

  const openDayInfo = useCallback(
    (dateStr: string) => {
      setSelectedDate(dateStr);
      setNoteText(calendarNotes?.[dateStr] || "");
      setNoteDialogOpen(true);
    },
    [calendarNotes],
  );

  const handleDayHover = useCallback((e: React.MouseEvent, dateStr: string) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({ x: rect.left + rect.width / 2, y: rect.top, dateStr });
  }, []);

  const handleDayLeave = useCallback(() => setTooltip(null), []);

  const tooltipData = useMemo(() => {
    if (!tooltip) return null;
    const dayData = revenueMap.get(tooltip.dateStr);
    const holidays = getEventsForDate(tooltip.dateStr);
    const holiday = holidays.length > 0 ? holidays[0] : null;
    const note = calendarNotes?.[tooltip.dateStr];
    const d = new Date(tooltip.dateStr + "T12:00:00");
    return {
      dateStr: tooltip.dateStr,
      label: d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      revenue: dayData?.revenue || 0,
      orders: dayData?.orders || 0,
      holiday,
      holidays,
      note,
    };
  }, [tooltip, revenueMap, calendarNotes]);

  const yearStats = useMemo(() => {
    let totalRev = 0,
      totalOrders = 0,
      daysWithData = 0,
      bestDay = "",
      bestRev = 0;
    const yearPrefix = `${calendarYear}-`;
    revenueMap.forEach((v, k) => {
      if (k.startsWith(yearPrefix) && v.revenue > 0) {
        totalRev += v.revenue;
        totalOrders += v.orders;
        daysWithData++;
        if (v.revenue > bestRev) {
          bestRev = v.revenue;
          bestDay = k;
        }
      }
    });
    return {
      totalRev,
      totalOrders,
      daysWithData,
      bestDay,
      bestRev,
      avgDaily: daysWithData > 0 ? totalRev / daysWithData : 0,
    };
  }, [revenueMap, calendarYear]);

  const handleMonthClick = useCallback((month: number, year: number) => {
    setSelectedMonth({ month, year });
    setTooltip(null);
  }, []);

  const handleBackToYear = useCallback(() => {
    setSelectedMonth(null);
  }, []);

  const [showNoteInput, setShowNoteInput] = useState(false);

  const selectedDayData = useMemo(() => {
    if (!selectedDate) return null;
    const dayRev = revenueMap.get(selectedDate);
    const holidays = getEventsForDate(selectedDate);
    const note = calendarNotes?.[selectedDate];
    const d = new Date(selectedDate + "T12:00:00");
    const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    return {
      dateLabel: d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      dayOfWeek,
      isWeekend,
      revenue: dayRev?.revenue || 0,
      orders: dayRev?.orders || 0,
      avgOrder: dayRev && dayRev.orders > 0 ? dayRev.revenue / dayRev.orders : 0,
      holidays,
      note,
    };
  }, [selectedDate, revenueMap, calendarNotes]);

  const dayInfoDialogJSX = (
    <Dialog open={noteDialogOpen} onOpenChange={(open) => { setNoteDialogOpen(open); if (!open) setShowNoteInput(false); }}>
      <DialogContent className="sm:max-w-md animate-scale-in">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarHeart className="h-5 w-5 text-primary" />
            {selectedDayData?.dateLabel}
          </DialogTitle>
        </DialogHeader>

        {selectedDayData && (
          <div className="space-y-4" data-testid="day-info-content">
            <div className="grid grid-cols-3 gap-3">
              <div className="neu-card p-3 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Revenue</p>
                <p className="text-lg font-bold text-foreground mt-0.5">
                  {selectedDayData.revenue > 0 ? `฿${Math.round(selectedDayData.revenue).toLocaleString()}` : "—"}
                </p>
              </div>
              <div className="neu-card p-3 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Orders</p>
                <p className="text-lg font-bold text-foreground mt-0.5">
                  {selectedDayData.orders > 0 ? selectedDayData.orders : "—"}
                </p>
              </div>
              <div className="neu-card p-3 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Avg Order</p>
                <p className="text-lg font-bold text-foreground mt-0.5">
                  {selectedDayData.avgOrder > 0 ? `฿${Math.round(selectedDayData.avgOrder).toLocaleString()}` : "—"}
                </p>
              </div>
            </div>

            {(() => {
              if (!selectedDate) return null;
              const actual = selectedDayData.revenue;
              let target = 0;
              let label = "vs Model Forecast";
              let targetLabel = "Target";
              const lyDate = getSTLYDateStr(selectedDate);
              const lyData = revenueMap.get(lyDate);
              const chalongStly = lyData?.revenue || 0;
              if (chalongOnly) {
                target = chalongStly;
                label = "vs Same Time Last Year";
                targetLabel = `LY (${lyDate.slice(5)})`;
              } else if (hasFloresta && hasChalong) {
                const fc = getForecastForDate(selectedDate, new Set(["floresta"]));
                target = fc.totalRevenue + chalongStly;
                label = "vs Forecast + STLY";
                targetLabel = "Target";
              } else {
                const fc = getForecastForDate(selectedDate, activeBranches);
                target = fc.totalRevenue;
              }
              if (target <= 0 && actual <= 0) return null;
              const pct = target > 0 ? actual / target : 0;
              const isOver = actual >= target;
              return (
                <div className="neu-card p-3 space-y-1.5" data-testid="day-forecast-bar">
                  <div className="flex justify-between items-center">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{label}</p>
                    {target > 0 && (
                      <span className={cn(
                        "text-xs font-bold",
                        isOver ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400",
                      )}>
                        {isOver ? "+" : ""}{((pct - 1) * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        pct >= 1 ? "bg-emerald-500" : pct >= 0.8 ? "bg-yellow-500" : "bg-red-500",
                      )}
                      style={{ width: `${Math.min(pct * 100, 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Actual: ฿{Math.round(actual).toLocaleString()}</span>
                    <span>{targetLabel}: {target > 0 ? `฿${Math.round(target).toLocaleString()}` : "No data"}</span>
                  </div>
                </div>
              );
            })()}

            <div className="space-y-2">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Day Type</p>
              <div className="flex flex-wrap gap-2">
                <span className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium",
                  selectedDayData.isWeekend
                    ? "bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400"
                    : "bg-slate-100 dark:bg-gray-800 text-slate-700 dark:text-gray-400",
                )}>
                  {selectedDayData.isWeekend ? "Weekend" : "Weekday"}
                </span>
                {selectedDayData.holidays.map((h, i) => {
                  const hc = HOLIDAY_COLORS[h.type];
                  const isMilestone = h.type === "milestone";
                  return (
                    <span
                      key={i}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full font-medium",
                        isMilestone
                          ? "px-3 py-1.5 text-sm font-extrabold ring-2 ring-yellow-400/60 dark:ring-yellow-500/40 shadow-md shadow-yellow-400/20"
                          : "px-2.5 py-1 text-xs",
                        hc.bg, hc.text,
                      )}
                      data-testid={`day-info-holiday-${i}`}
                    >
                      <span className={cn("rounded-full", isMilestone ? "w-2.5 h-2.5" : "w-2 h-2", hc.dot)} />
                      {h.name}
                    </span>
                  );
                })}
              </div>
            </div>

            {selectedDayData.note && !showNoteInput && (
              <div className="space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Note</p>
                <p className="text-sm text-foreground bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  {selectedDayData.note}
                </p>
              </div>
            )}

            {showNoteInput ? (
              <div className="space-y-2">
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note for this day..."
                  rows={3}
                  className="resize-none rounded-xl text-sm"
                  data-testid="input-calendar-note"
                />
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowNoteInput(false)}
                    className="rounded-full text-xs"
                  >
                    Cancel
                  </Button>
                  {calendarNotes?.[selectedDate] && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        saveNoteMutation.mutate({ date: selectedDate, note: "" });
                        setShowNoteInput(false);
                      }}
                      disabled={saveNoteMutation.isPending}
                      className="text-red-600 hover:text-red-700 rounded-full text-xs"
                      data-testid="btn-delete-note"
                    >
                      Delete
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => {
                      saveNoteMutation.mutate({ date: selectedDate, note: noteText });
                      setShowNoteInput(false);
                    }}
                    disabled={saveNoteMutation.isPending || !noteText.trim()}
                    className="btn-press rounded-full text-xs"
                    data-testid="btn-save-note"
                  >
                    {saveNoteMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowNoteInput(true)}
                className="text-xs text-muted-foreground w-full rounded-full"
                data-testid="btn-add-note"
              >
                <StickyNote className="h-3.5 w-3.5 mr-1" />
                {selectedDayData.note ? "Edit Note" : "Add Note"}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  if (selectedMonth) {
    return (
      <div className="space-y-4 animate-fade-in" data-testid="calendar-tab">
        <DetailedMonthView
          month={selectedMonth.month}
          year={selectedMonth.year}
          revenueMap={revenueMap}
          maxRevenue={maxRevenue}
          todayStr={todayStr}
          calendarNotes={calendarNotes}
          onDayClick={openDayInfo}
          onBack={handleBackToYear}
          heatmapMode={heatmapMode}
          activeBranches={activeBranches}
          getEventsForDate={getEventsForDate}
        />

        {noteDialogOpen && dayInfoDialogJSX}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in" data-testid="calendar-tab">
      <div className="neu-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setCalendarYear(y => y - 1); setSelectedMonth(null); }}
              className="p-1.5 rounded-lg hover:bg-muted/60 transition-colors"
              data-testid="btn-cal-prev-year"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-center">
              <h3
                className="text-lg font-bold flex items-center gap-2"
                data-testid="cal-title"
              >
                <CalendarDays className="h-5 w-5 text-emerald-500" />
                Calendar {calendarYear}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {chalongOnly ? "Robinsons Chalong" : hasChalong ? "All Branches" : "Central Floresta"} — Daily Revenue Heatmap
              </p>
            </div>
            <button
              onClick={() => { setCalendarYear(y => y + 1); setSelectedMonth(null); }}
              className="p-1.5 rounded-lg hover:bg-muted/60 transition-colors"
              data-testid="btn-cal-next-year"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="neu-inset rounded-lg p-0.5 flex items-center">
              <button
                onClick={() => setHeatmapMode("revenue")}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all",
                  heatmapMode === "revenue"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                data-testid="btn-heatmap-revenue"
              >
                Revenue
              </button>
              {chalongOnly ? (
                <button
                  onClick={() => setHeatmapMode("stly")}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all",
                    heatmapMode === "stly"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  data-testid="btn-heatmap-stly"
                >
                  vs STLY
                </button>
              ) : (
                <button
                  onClick={() => setHeatmapMode("forecast")}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all",
                    heatmapMode === "forecast"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  data-testid="btn-heatmap-forecast"
                >
                  vs Forecast
                </button>
              )}
            </div>
            {heatmapMode === "revenue" ? (
              <div className="neu-inset rounded-lg px-3 py-1.5 flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground font-medium">
                  Less
                </span>
                {HEATMAP_LEVELS.slice(1).map((lvl, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-[2px] border border-border/20"
                    style={{ backgroundColor: lvl.light }}
                  />
                ))}
                <span className="text-[10px] text-muted-foreground font-medium">
                  More
                </span>
              </div>
            ) : (
              <div className="neu-inset rounded-lg px-3 py-1.5 flex items-center gap-1.5">
                {[
                  { color: FORECAST_HEAT_COLORS.bad.light, label: "<50%" },
                  { color: FORECAST_HEAT_COLORS.low.light, label: "50-70%" },
                  { color: FORECAST_HEAT_COLORS.ok.light, label: "70-90%" },
                  { color: FORECAST_HEAT_COLORS.good.light, label: "90-110%" },
                  { color: FORECAST_HEAT_COLORS.great.light, label: ">110%" },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-0.5">
                    <div
                      className="w-3 h-3 rounded-[2px] border border-border/20"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-[8px] text-muted-foreground">{item.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {yearStats.daysWithData > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="neu-card p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Year Revenue
            </p>
            <p
              className="text-lg font-bold text-emerald-600 dark:text-emerald-400 mt-1"
              data-testid="text-year-revenue"
            >
              ฿
              {yearStats.totalRev >= 1000000
                ? `${(yearStats.totalRev / 1000000).toFixed(1)}M`
                : `${(yearStats.totalRev / 1000).toFixed(0)}k`}
            </p>
          </div>
          <div className="neu-card p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Avg / Day
            </p>
            <p
              className="text-lg font-bold text-blue-600 dark:text-blue-400 mt-1"
              data-testid="text-year-avg"
            >
              ฿
              {yearStats.avgDaily >= 1000
                ? `${(yearStats.avgDaily / 1000).toFixed(0)}k`
                : yearStats.avgDaily.toFixed(0)}
            </p>
          </div>
          <div className="neu-card p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Active Days
            </p>
            <p
              className="text-lg font-bold text-foreground mt-1"
              data-testid="text-year-days"
            >
              {yearStats.daysWithData}
            </p>
          </div>
          <div className="neu-card p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Best Day
            </p>
            <p
              className="text-sm font-bold text-amber-600 dark:text-amber-400 mt-1"
              data-testid="text-year-best"
            >
              ฿
              {yearStats.bestRev >= 1000
                ? `${(yearStats.bestRev / 1000).toFixed(0)}k`
                : yearStats.bestRev.toFixed(0)}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {yearStats.bestDay &&
                new Date(yearStats.bestDay + "T12:00:00").toLocaleDateString(
                  "en-US",
                  { month: "short", day: "numeric" },
                )}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="neu-card p-6">
          <div className="flex items-center justify-center gap-2 py-8">
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {academicMonths.map(({ month, year }) => (
            <MiniMonthGrid
              key={`${year}-${month}`}
              month={month}
              year={year}
              revenueMap={revenueMap}
              maxRevenue={maxRevenue}
              todayStr={todayStr}
              calendarNotes={calendarNotes}
              onDayClick={openDayInfo}
              onDayHover={handleDayHover}
              onDayLeave={handleDayLeave}
              onMonthClick={handleMonthClick}
              heatmapMode={heatmapMode}
              activeBranches={activeBranches}
              birthdayMap={birthdayMap}
            />
          ))}
        </div>
      )}

      <div className="neu-card p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mr-1">
            Events
          </span>
          {(
            Object.entries(HOLIDAY_COLORS) as Array<
              [HolidayType, (typeof HOLIDAY_COLORS)[HolidayType]]
            >
          ).map(([type, hc]) => (
            <span
              key={type}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              {type === "kid" ? (
                <Star className="h-2.5 w-2.5 text-amber-500 fill-amber-500" />
              ) : (
                <span className={cn("w-2.5 h-2.5 rounded-full", hc.dot)} />
              )}
              {hc.label}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 pt-3 border-t border-border/50">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mr-1">
            Terms
          </span>
          <span className="text-xs text-muted-foreground">
            <b className="text-teal-600 dark:text-teal-400">T1</b> Aug 24 – Dec
            14
          </span>
          <span className="text-xs text-muted-foreground">
            <b className="text-teal-600 dark:text-teal-400">T2</b> Jan 5 – Apr
            12
          </span>
          <span className="text-xs text-muted-foreground">
            <b className="text-teal-600 dark:text-teal-400">T3</b> Apr 27 – Jun
            25
          </span>
        </div>
      </div>

      {tooltip && tooltipData && (
        <div
          className="fixed z-[100] pointer-events-none animate-fade-in"
          style={{
            left: Math.min(tooltip.x, window.innerWidth - 220),
            top: tooltip.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="neu-card !shadow-xl border border-border/60 px-3 py-2 min-w-[160px] max-w-[220px]">
            <p className="text-xs font-bold text-foreground">
              {tooltipData.label}
            </p>
            {tooltipData.revenue > 0 ? (
              <>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                  ฿
                  {tooltipData.revenue.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}
                </p>
                {tooltipData.orders > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {tooltipData.orders} transactions
                  </p>
                )}
                {(() => {
                  const lyDate = getSTLYDateStr(tooltipData.dateStr);
                  const lyData = revenueMap.get(lyDate);
                  const chalongStly = lyData?.revenue || 0;
                  if (chalongOnly) {
                    if (chalongStly > 0) {
                      const pct = ((tooltipData.revenue / chalongStly) - 1) * 100;
                      return (
                        <>
                          <p className="text-[10px] text-muted-foreground">
                            LY ({lyDate.slice(5)}): ฿{Math.round(chalongStly).toLocaleString()}
                          </p>
                          <p className={cn("text-[10px] font-medium", pct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400")}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(0)}% vs STLY
                          </p>
                        </>
                      );
                    }
                    return (
                      <p className="text-[10px] text-muted-foreground">No STLY data</p>
                    );
                  }
                  let target = 0;
                  let vsLabel = "forecast";
                  if (hasFloresta && hasChalong) {
                    const fc = getForecastForDate(tooltipData.dateStr, new Set(["floresta"]));
                    target = fc.totalRevenue + chalongStly;
                    vsLabel = "target";
                  } else {
                    const fc = getForecastForDate(tooltipData.dateStr, activeBranches);
                    target = fc.totalRevenue;
                  }
                  const pct = target > 0 ? ((tooltipData.revenue / target) - 1) * 100 : 0;
                  return target > 0 ? (
                    <p className={cn("text-[10px] font-medium", pct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400")}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(0)}% vs {vsLabel}
                    </p>
                  ) : null;
                })()}
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                No revenue data
              </p>
            )}
            {tooltipData.holidays && tooltipData.holidays.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {tooltipData.holidays.map((h: { name: string; type: HolidayType }, i: number) => (
                  <p
                    key={i}
                    className={cn(
                      "text-[10px] font-medium flex items-center gap-1",
                      HOLIDAY_COLORS[h.type]?.text,
                    )}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full inline-block shrink-0",
                        HOLIDAY_COLORS[h.type]?.dot,
                      )}
                    />
                    {h.name}
                  </p>
                ))}
              </div>
            )}
            {tooltipData.note && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 truncate">
                📝 {tooltipData.note}
              </p>
            )}
          </div>
        </div>
      )}

      {dayInfoDialogJSX}
    </div>
  );
}

function formatSyncTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "Never";
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getMostRecent(a: string | null | undefined, b: string | null | undefined): string | null | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function SyncStatusToggle({
  isConnected,
  syncStatus,
  papayaSyncStatus,
  onSyncFloresta,
  onSyncChalong,
  syncing,
  showFloresta,
  showChalong,
}: {
  isConnected: boolean;
  syncStatus: any;
  papayaSyncStatus?: any;
  onSyncFloresta?: () => void;
  onSyncChalong?: () => void;
  syncing?: boolean;
  showFloresta?: boolean;
  showChalong?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [expanded]);

  return (
    <div className="relative" ref={panelRef} data-testid="sync-status-toggle">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 px-3.5 py-1 sm:px-2.5 sm:py-1.5 rounded-full text-[12px] sm:text-xs font-semibold sm:font-medium border transition-all duration-200 btn-press min-h-[36px] sm:min-h-[32px] shrink-0",
          syncing
            ? "bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800"
            : isConnected
              ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
        )}
        data-testid="btn-sync-toggle"
      >
        <span
          className={cn(
            "w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full transition-colors",
            syncing
              ? "bg-blue-500 animate-pulse"
              : isConnected
                ? "bg-green-500 animate-pulse ring-2 ring-green-500/30"
                : "bg-red-500",
          )}
        />
        {syncing ? "Syncing" : isConnected ? "Live" : "Offline"}
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div
          className="absolute right-0 top-full mt-1.5 z-50 bg-card border rounded-xl shadow-xl p-3 w-[220px] animate-scale-in"
          data-testid="sync-status-panel"
        >
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <span
                className={cn(
                  "font-medium",
                  isConnected
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-500",
                )}
              >
                {isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div className="border-t" />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last Sync</span>
              <span className="font-medium" data-testid="text-last-sync">
                {formatSyncTime(
                  showFloresta && showChalong
                    ? getMostRecent(syncStatus?.lastSyncedAt, papayaSyncStatus?.lastSyncedAt)
                    : showChalong
                      ? papayaSyncStatus?.lastSyncedAt
                      : syncStatus?.lastSyncedAt
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last Full Sync</span>
              <span className="font-medium" data-testid="text-last-full-sync">
                {formatSyncTime(
                  showFloresta && showChalong
                    ? getMostRecent(syncStatus?.lastFullSyncAt, papayaSyncStatus?.lastFullSyncAt)
                    : showChalong
                      ? papayaSyncStatus?.lastFullSyncAt
                      : syncStatus?.lastFullSyncAt
                )}
              </span>
            </div>
            {(() => {
              const effectiveStatus = showFloresta && showChalong
                ? syncStatus
                : showChalong
                  ? papayaSyncStatus
                  : syncStatus;
              return effectiveStatus?.cachedDates > 0 ? (
                <>
                  <div className="border-t" />
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Cached Days</span>
                    <span className="font-medium">{effectiveStatus.cachedDates}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Date Range</span>
                    <span className="font-medium text-[10px]">
                      {format(parseISO(effectiveStatus.earliestDate), "dd/MM/yyyy")} → {format(parseISO(effectiveStatus.latestDate), "dd/MM/yyyy")}
                    </span>
                  </div>
                </>
              ) : null;
            })()}
            <div className="border-t" />
            <div className="space-y-1.5">
              {showFloresta && onSyncFloresta && (
                <button
                  onClick={() => {
                    onSyncFloresta();
                    setExpanded(false);
                  }}
                  disabled={syncing}
                  className="w-full rounded-md bg-blue-50 dark:bg-blue-950/30 p-2 text-center font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 active:bg-blue-200 dark:active:bg-blue-800/50 disabled:opacity-50 transition-colors min-h-[36px] flex items-center justify-center gap-1.5"
                  data-testid="btn-sync-floresta"
                >
                  <Database className="h-3 w-3" />
                  {syncing ? "Syncing..." : "Sync Floresta"}
                </button>
              )}
              {showChalong && onSyncChalong && (
                <button
                  onClick={() => {
                    onSyncChalong();
                    setExpanded(false);
                  }}
                  disabled={syncing}
                  className="w-full rounded-md bg-emerald-50 dark:bg-emerald-950/30 p-2 text-center font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 active:bg-emerald-200 dark:active:bg-emerald-800/50 disabled:opacity-50 transition-colors min-h-[36px] flex items-center justify-center gap-1.5"
                  data-testid="btn-sync-chalong"
                >
                  <Database className="h-3 w-3" />
                  {syncing ? "Syncing..." : "Sync Chalong"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InParkPill({
  guestBreakdown,
}: {
  guestBreakdown: any;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setExpanded(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (!guestBreakdown) return null;

  const ongoingKids = guestBreakdown.ongoingKids || 0;
  const ongoingAdults = guestBreakdown.ongoingAdults || 0;
  const ongoingTotal = guestBreakdown.ongoingTotal || 0;
  const totalInPark = guestBreakdown.totalInPark || (guestBreakdown.kidTickets + (guestBreakdown.estimatedTotalAdults || guestBreakdown.adultTickets));

  const bangkokNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const nowMin = bangkokNow.getHours() * 60 + bangkokNow.getMinutes();
  const parkOpen = 10 * 60;
  const parkClose = 20 * 60 + 45;
  const isParkHours = nowMin >= parkOpen && nowMin < parkClose;

  const displayCount = ongoingTotal > 0 ? ongoingTotal : (isParkHours ? totalInPark : 0);
  const isOngoing = ongoingTotal > 0;

  if (displayCount === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "text-[12px] sm:text-[11px] h-9 sm:h-6 px-3.5 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center gap-1.5 shrink-0",
          "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
        )}
        data-testid="btn-in-park"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ring-2 ring-emerald-500/30" />
        <span className="font-bold tabular-nums">{displayCount}</span>
        <span className="hidden sm:inline">{isOngoing ? "in park" : "guests"}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform duration-200", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div
          className="absolute left-0 top-full mt-1.5 z-50 bg-card border rounded-xl shadow-xl p-3 w-[200px] animate-scale-in"
          data-testid="in-park-panel"
        >
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                {isOngoing ? "Currently in Park" : "Total Guests Today"}
              </span>
            </div>

            <div className="text-center py-1">
              <span className="text-2xl font-bold text-foreground metric-value">{displayCount}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="neu-card-inner p-2 rounded-lg text-center">
                <div className="text-[10px] text-muted-foreground mb-0.5">Kids</div>
                <div className="text-sm font-bold text-blue-600 dark:text-blue-400">{isOngoing ? ongoingKids : guestBreakdown.kidTickets}</div>
              </div>
              <div className="neu-card-inner p-2 rounded-lg text-center">
                <div className="text-[10px] text-muted-foreground mb-0.5">Adults</div>
                <div className="text-sm font-bold text-green-600 dark:text-green-400">{isOngoing ? ongoingAdults : (guestBreakdown.estimatedTotalAdults || guestBreakdown.adultTickets)}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const BRANCH_LABELS: Record<Branch, string> = {
  floresta: "Central Floresta",
  chalong: "Robinson Chalong",
};

function parseSavedBranches(): ActiveBranches {
  try {
    const saved = localStorage.getItem("oto_branches");
    if (saved) {
      const arr = JSON.parse(saved) as Branch[];
      const valid = arr.filter((b) => b === "floresta" || b === "chalong");
      if (valid.length > 0) return new Set<Branch>(valid);
    }
    const legacy = localStorage.getItem("oto_branch") as Branch;
    if (legacy) return new Set([legacy]);
  } catch {}
  return new Set(["floresta"] as Branch[]);
}

function mergeDashboardData(a: DashboardSummaryData, b: DashboardSummaryData): DashboardSummaryData {
  const merged = { ...a };
  merged.totalRevenue = (a.totalRevenue || 0) + (b.totalRevenue || 0);
  merged.totalOrders = (a.totalOrders || 0) + (b.totalOrders || 0);
  merged.avgOrderValue = merged.totalOrders > 0 ? Math.round(merged.totalRevenue / merged.totalOrders) : 0;
  merged.discountTotal = (a.discountTotal || 0) + (b.discountTotal || 0);
  const dbMap = new Map<string, { name: string; count: number; total: number }>();
  for (const d of [...(a.discountBreakdown || []), ...(b.discountBreakdown || [])]) {
    const ex = dbMap.get(d.name);
    if (ex) { ex.count += d.count; ex.total += d.total; }
    else dbMap.set(d.name, { ...d });
  }
  merged.discountBreakdown = Array.from(dbMap.values()).sort((x, y) => y.total - x.total);
  merged.pureTicketRevenue = (a.pureTicketRevenue || 0) + (b.pureTicketRevenue || 0);

  const pmA = a.paymentBreakdown || {};
  const pmB = b.paymentBreakdown || {};
  const pmMerged: Record<string, number> = { ...pmA };
  for (const [k, v] of Object.entries(pmB)) {
    pmMerged[k] = (pmMerged[k] || 0) + (v as number);
  }
  merged.paymentBreakdown = pmMerged;

  const catA = a.categoryBreakdown || {};
  const catB = b.categoryBreakdown || {};
  const catMerged: Record<string, any> = {};
  for (const key of new Set([...Object.keys(catA), ...Object.keys(catB)])) {
    const ca = catA[key] || { revenue: 0, quantity: 0, items: [] };
    const cb = catB[key] || { revenue: 0, quantity: 0, items: [] };
    catMerged[key] = {
      revenue: (ca.revenue || 0) + (cb.revenue || 0),
      quantity: (ca.quantity || 0) + (cb.quantity || 0),
      items: [...(ca.items || []), ...(cb.items || [])],
    };
  }
  // Reconcile merged category breakdown so the sum equals the merged totalRevenue.
  // Each branch is reconciled at the source, but tiny rounding from concurrent paths can drift.
  let catSum = 0;
  for (const v of Object.values(catMerged)) catSum += (v as any).revenue || 0;
  if (catSum > 0 && Math.abs(catSum - merged.totalRevenue) > 0.01) {
    const scale = merged.totalRevenue / catSum;
    for (const k of Object.keys(catMerged)) {
      catMerged[k].revenue = Math.round(catMerged[k].revenue * scale * 100) / 100;
    }
    const newSum = Object.values(catMerged).reduce((s, v: any) => s + (v.revenue || 0), 0);
    const residual = Math.round((merged.totalRevenue - newSum) * 100) / 100;
    if (Math.abs(residual) > 0) {
      let largest = "";
      let largestRev = -Infinity;
      for (const [k, v] of Object.entries(catMerged)) {
        if ((v as any).revenue > largestRev) { largestRev = (v as any).revenue; largest = k; }
      }
      if (largest) catMerged[largest].revenue = Math.round((catMerged[largest].revenue + residual) * 100) / 100;
    }
  }
  merged.categoryBreakdown = catMerged;

  // task-114 v3: merge per-natural-category birthday-channel split metadata.
  const bcsA = a.birthdayChannelSplit || {};
  const bcsB = b.birthdayChannelSplit || {};
  const bcsKeys = new Set([...Object.keys(bcsA), ...Object.keys(bcsB)]);
  if (bcsKeys.size > 0) {
    const bcsMerged: Record<string, CategoryData> = {};
    for (const key of bcsKeys) {
      const ca = bcsA[key] || { revenue: 0, quantity: 0, items: [] };
      const cb = bcsB[key] || { revenue: 0, quantity: 0, items: [] };
      const itemsMap = new Map<string, { name: string; category: string; revenue: number; quantity: number }>();
      for (const it of [...(ca.items || []), ...(cb.items || [])]) {
        const ex = itemsMap.get(it.name);
        if (ex) { ex.revenue += it.revenue || 0; ex.quantity += it.quantity || 0; }
        else itemsMap.set(it.name, { ...it });
      }
      bcsMerged[key] = {
        revenue: (ca.revenue || 0) + (cb.revenue || 0),
        quantity: (ca.quantity || 0) + (cb.quantity || 0),
        items: Array.from(itemsMap.values()).sort((x, y) => y.revenue - x.revenue),
      };
    }
    merged.birthdayChannelSplit = bcsMerged;
  }

  const tpA = a.topProducts || [];
  const tpB = b.topProducts || [];
  const tpMap = new Map<string, any>();
  for (const p of [...tpA, ...tpB]) {
    const existing = tpMap.get(p.name);
    if (existing) {
      existing.quantity += p.quantity;
      existing.revenue += p.revenue;
    } else {
      tpMap.set(p.name, { ...p });
    }
  }
  merged.topProducts = Array.from(tpMap.values()).sort((x: any, y: any) => y.revenue - x.revenue).slice(0, 20);

  const hA = a.hourlyBreakdown || [];
  const hB = b.hourlyBreakdown || [];
  merged.hourlyBreakdown = mergeActivityHours(hA, hB);
  merged.dailyHourly = mergeActivityDays(a.dailyHourly || [], b.dailyHourly || []) as DashboardSummaryData["dailyHourly"];

  const chA = a.channelBreakdown || {};
  const chB = b.channelBreakdown || {};
  const chMerged: Record<string, number> = { ...chA };
  for (const [k, v] of Object.entries(chB)) {
    chMerged[k] = (chMerged[k] || 0) + (v as number);
  }
  merged.channelBreakdown = chMerged;

  const gbA = a.guestBreakdown || {} as any;
  const gbB = b.guestBreakdown || {} as any;
  merged.guestBreakdown = {
    kids: (gbA.kids || 0) + (gbB.kids || 0),
    adults: (gbA.adults || 0) + (gbB.adults || 0),
    totalGuests: (gbA.totalGuests || 0) + (gbB.totalGuests || 0),
    kidTickets: (gbA.kidTickets || 0) + (gbB.kidTickets || 0),
    adultTickets: (gbA.adultTickets || 0) + (gbB.adultTickets || 0),
    estimatedTotalAdults: (gbA.estimatedTotalAdults || 0) + (gbB.estimatedTotalAdults || 0),
    totalInPark: (gbA.totalInPark || 0) + (gbB.totalInPark || 0),
    adultRevenue: (gbA.adultRevenue || 0) + (gbB.adultRevenue || 0),
    kidRevenue: (gbA.kidRevenue || 0) + (gbB.kidRevenue || 0),
    avgStayHours: 0,
    stayDistribution: (() => {
      const map = new Map<string, { label: string; hours: number; count: number }>();
      for (const s of [...(gbA.stayDistribution || []), ...(gbB.stayDistribution || [])]) {
        const existing = map.get(s.label);
        if (existing) existing.count += s.count;
        else map.set(s.label, { ...s });
      }
      return Array.from(map.values()).sort((a, b) => a.hours - b.hours);
    })(),
    details: [...(gbA.details || []), ...(gbB.details || [])],
    ongoingKids: (gbA.ongoingKids || 0) + (gbB.ongoingKids || 0),
    ongoingAdults: (gbA.ongoingAdults || 0) + (gbB.ongoingAdults || 0),
    ongoingTotal: (gbA.ongoingTotal || 0) + (gbB.ongoingTotal || 0),
    completedKids: (gbA.completedKids || 0) + (gbB.completedKids || 0),
    completedAdults: (gbA.completedAdults || 0) + (gbB.completedAdults || 0),
    completedTotal: (gbA.completedTotal || 0) + (gbB.completedTotal || 0),
  } as any;

  const drA = a.dailyRevenue || [];
  const drB = b.dailyRevenue || [];
  const drMap = new Map<string, any>();
  for (const d of [...drA, ...drB]) {
    const dAny = d as any;
    const ex = drMap.get(d.date);
    if (ex) {
      ex.revenue += d.revenue || 0;
      ex.orders = (ex.orders || 0) + (d.orders || 0);
      // Merge per-day categories (needed for PerformanceGraph category filter on multi-branch view).
      if (dAny.categories) {
        ex.categories = ex.categories || {};
        for (const [k, v] of Object.entries(dAny.categories)) {
          ex.categories[k] = (ex.categories[k] || 0) + (Number(v) || 0);
        }
      }
      if (dAny.customerTypes) {
        ex.customerTypes = ex.customerTypes || {};
        for (const [k, ct] of Object.entries(dAny.customerTypes) as [string, any][]) {
          if (!ex.customerTypes[k]) ex.customerTypes[k] = { kids: 0, adults: 0 };
          ex.customerTypes[k].kids += ct.kids || 0;
          ex.customerTypes[k].adults += ct.adults || 0;
        }
      }
      if (typeof dAny.kids === "number") ex.kids = (ex.kids || 0) + dAny.kids;
      if (typeof dAny.adults === "number") ex.adults = (ex.adults || 0) + dAny.adults;
      if (typeof dAny.vouchers === "number") ex.vouchers = (ex.vouchers || 0) + dAny.vouchers;
    } else {
      // Deep-clone categories/customerTypes so subsequent merges don't mutate the source.
      const cloned: any = { ...d };
      if (dAny.categories) cloned.categories = { ...dAny.categories };
      if (dAny.customerTypes) {
        cloned.customerTypes = {};
        for (const [k, ct] of Object.entries(dAny.customerTypes) as [string, any][]) {
          cloned.customerTypes[k] = { kids: ct.kids || 0, adults: ct.adults || 0 };
        }
      }
      drMap.set(d.date, cloned);
    }
  }
  merged.dailyRevenue = Array.from(drMap.values()).sort((x: any, y: any) => x.date.localeCompare(y.date));

  const crA = a.cashReportsDailyTotals || [];
  const crB = b.cashReportsDailyTotals || [];
  const crMap = new Map<string, any>();
  for (const c of [...crA, ...crB]) {
    const ex = crMap.get(c.date);
    if (ex) {
      ex.revenue += c.revenue || 0;
    } else {
      crMap.set(c.date, { ...c });
    }
  }
  merged.cashReportsDailyTotals = Array.from(crMap.values()).sort((x: any, y: any) => x.date.localeCompare(y.date));

  merged.customerTypeSplit = [...(a.customerTypeSplit || []), ...(b.customerTypeSplit || [])];

  return merged;
}

function DailyAdjustmentsAudit({ date }: { date: string }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<string>("orderId");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<{
    date: string;
    summary: {
      voidedCount: number;
      voidedValue: number;
      refundedCount: number;
      refundedValue: number;
      reBilledCount: number;
      reBilledValue: number;
      netRevenueImpact: number;
      totalOrders: number;
    };
    redFlags: Array<{
      type: string;
      severity: "warning" | "critical";
      message: string;
      details?: string;
    }>;
    adjustments: Array<{
      orderId: string;
      orderCode: string | null;
      createdAt: string | null;
      adjustedAt: string | null;
      adjustedAtApprox: boolean;
      amount: number;
      status: "Voided" | "Refunded" | "Partially Refunded";
      originalPaymentMethod: string | null;
      reBilled: boolean;
      reBillOrderId: string | null;
      reBillPaymentMethod: string | null;
      reBillTime: string | null;
      lineItems: Array<{ name: string; quantity: number; price: number }>;
      braceletCount: number;
      voucherInfo: Array<{ count: number; faceValue: number }>;
      note: string | null;
      refundAmount: number;
    }>;
  }>({
    queryKey: ["/api/funtopia/adjustments", date],
    queryFn: async () => {
      const res = await fetch(`/api/funtopia/adjustments?date=${date}`);
      if (!res.ok) throw new Error("Failed to fetch adjustments");
      return res.json();
    },
    enabled: !!date,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading adjustments data...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        No adjustment data available for this date.
      </div>
    );
  }

  const { summary, redFlags, adjustments } = data;
  const hasAnyData = adjustments.length > 0;

  const filtered = statusFilter === "all"
    ? adjustments
    : adjustments.filter(a => a.status === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortField === "orderId") cmp = a.orderId.localeCompare(b.orderId, undefined, { numeric: true });
    else if (sortField === "time") cmp = (a.createdAt || "").localeCompare(b.createdAt || "");
    else if (sortField === "amount") cmp = a.amount - b.amount;
    else if (sortField === "status") cmp = a.status.localeCompare(b.status);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const SortIcon = ({ field }: { field: string }) => (
    sortField === field ? (
      <ChevronDown className={`h-3 w-3 inline ml-0.5 transition-transform ${sortDir === "asc" ? "rotate-180" : ""}`} />
    ) : null
  );

  const statusColors: Record<string, string> = {
    Voided: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
    Refunded: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
    "Partially Refunded": "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  };

  return (
    <div className="space-y-4">
      <div className="dash-stat-strip" data-testid="adjustments-summary-strip">
        <div className="dash-stat-cell" data-testid="metric-voided-count">
          <div className="dash-stat-label">Voided</div>
          <div className="dash-stat-value text-red-600 dark:text-red-400">{summary.voidedCount}</div>
          <div className="dash-stat-sub privacy-sensitive">฿{summary.voidedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="dash-stat-cell" data-testid="metric-refunded-count">
          <div className="dash-stat-label">Refunded</div>
          <div className="dash-stat-value text-orange-600 dark:text-orange-400">{summary.refundedCount}</div>
          <div className="dash-stat-sub privacy-sensitive">฿{summary.refundedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="dash-stat-cell" data-testid="metric-rebilled-count">
          <div className="dash-stat-label">Re-billed</div>
          <div className="dash-stat-value text-blue-600 dark:text-blue-400">{summary.reBilledCount}</div>
          <div className="dash-stat-sub privacy-sensitive">฿{summary.reBilledValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="dash-stat-cell" data-testid="metric-net-impact">
          <div className="dash-stat-label">Net Impact</div>
          <div className={cn("dash-stat-value", summary.netRevenueImpact >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
            {summary.netRevenueImpact >= 0 ? "+" : ""}฿{summary.netRevenueImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="dash-stat-sub">Revenue shift</div>
        </div>
      </div>

      {!hasAnyData && redFlags.length === 0 && (
        <div className="text-sm text-muted-foreground py-3 text-center flex items-center justify-center gap-2">
          <ShieldCheck className="h-4 w-4 text-green-500" />
          No voids, refunds, or adjustments for this date.
        </div>
      )}

      {redFlags.length > 0 && (
        <div className="space-y-2" data-testid="red-flags-panel">
          <div className="dash-section-header text-red-600 dark:text-red-400 flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" />
            Red Flags ({redFlags.length})
          </div>
          <div className="space-y-1.5">
            {redFlags.map((flag, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-xs border ${
                  flag.severity === "critical"
                    ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900/50"
                    : "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50"
                }`}
                data-testid={`red-flag-${flag.type}-${i}`}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                    flag.severity === "critical" ? "text-red-500" : "text-amber-500"
                  }`} />
                  <div>
                    <div className={`font-medium ${
                      flag.severity === "critical"
                        ? "text-red-700 dark:text-red-300"
                        : "text-amber-700 dark:text-amber-300"
                    }`}>
                      {flag.message}
                    </div>
                    {flag.details && (
                      <div className="text-muted-foreground mt-0.5">{flag.details}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {adjustments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Filter:</span>
            {["all", "Voided", "Refunded", "Partially Refunded"].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`text-[10px] sm:text-xs px-2 py-1 rounded-md font-medium transition-colors ${
                  statusFilter === s
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
                data-testid={`filter-${s.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {s === "all" ? "All" : s} {s !== "all" ? `(${adjustments.filter(a => a.status === s).length})` : `(${adjustments.length})`}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs" data-testid="adjustments-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3 cursor-pointer select-none whitespace-nowrap dash-section-header" onClick={() => toggleSort("orderId")} data-testid="sort-order-id">
                    Order ID <SortIcon field="orderId" />
                  </th>
                  <th className="pb-2 pr-3 cursor-pointer select-none whitespace-nowrap dash-section-header" onClick={() => toggleSort("time")} data-testid="sort-time">
                    Time <SortIcon field="time" />
                  </th>
                  <th className="pb-2 pr-3 cursor-pointer select-none whitespace-nowrap text-right dash-section-header" onClick={() => toggleSort("amount")} data-testid="sort-amount">
                    Amount <SortIcon field="amount" />
                  </th>
                  <th className="pb-2 pr-3 cursor-pointer select-none whitespace-nowrap dash-section-header" onClick={() => toggleSort("status")} data-testid="sort-status">
                    Status <SortIcon field="status" />
                  </th>
                  <th className="pb-2 whitespace-nowrap dash-section-header">Notes</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((adj) => {
                  const isExpanded = expandedOrderId === adj.orderId;
                  return (
                    <Fragment key={adj.orderId}>
                      <tr
                        className="border-b border-muted/50 hover:bg-muted/30 transition-colors cursor-pointer select-none"
                        onClick={() => setExpandedOrderId(isExpanded ? null : adj.orderId)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedOrderId(isExpanded ? null : adj.orderId); } }}
                        tabIndex={0}
                        role="button"
                        aria-expanded={isExpanded}
                        data-testid={`adjustment-row-${adj.orderId}`}
                      >
                        <td className="py-2 pr-3 font-mono font-medium whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <ChevronRight className={`h-3 w-3 text-muted-foreground transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`} />
                            <span>
                              #{adj.orderId}
                              {adj.orderCode && <span className="text-muted-foreground ml-1">({adj.orderCode})</span>}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[10px]">
                              <span className="font-medium text-foreground/70">Ordered:</span>{" "}
                              {adj.createdAt ? (() => {
                                try {
                                  const d = new Date(adj.createdAt);
                                  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
                                } catch { return "—"; }
                              })() : "—"}
                            </span>
                            <span className="text-[10px]">
                              <span className={`font-medium ${adj.status === "Voided" ? "text-red-500" : "text-orange-500"}`}>
                                {adj.status === "Voided" ? "Voided:" : "Refunded:"}
                              </span>{" "}
                              {adj.adjustedAt ? (() => {
                                try {
                                  const d = new Date(adj.adjustedAt);
                                  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
                                } catch { return "—"; }
                              })() : <span className="text-muted-foreground italic">Not recorded</span>}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium whitespace-nowrap privacy-sensitive">
                          ฿{adj.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          {adj.refundAmount > 0 && adj.status !== "Voided" && (
                            <div className="text-[10px] text-orange-500">-฿{adj.refundAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} refund</div>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${statusColors[adj.status] || ""}`}>
                            {adj.status}
                          </span>
                        </td>
                        <td className="py-2 max-w-[200px]">
                          {adj.note ? (
                            <div className="text-[11px] text-muted-foreground truncate" title={adj.note}>{adj.note}</div>
                          ) : <span className="text-muted-foreground/50">—</span>}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-b border-muted/50" data-testid={`adjustment-detail-${adj.orderId}`}>
                          <td colSpan={5} className="px-3 py-3 bg-muted/20">
                            <div className="pl-4 space-y-3">
                              <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                                <div data-testid={`detail-timestamps-${adj.orderId}`}>
                                  <span className="font-medium text-muted-foreground">Ordered:</span>{" "}
                                  {adj.createdAt ? (() => {
                                    try {
                                      const d = new Date(adj.createdAt);
                                      return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
                                    } catch { return "—"; }
                                  })() : "—"}
                                  <span className="mx-1.5 text-muted-foreground">→</span>
                                  <span className={`font-medium ${adj.status === "Voided" ? "text-red-600 dark:text-red-400" : "text-orange-600 dark:text-orange-400"}`}>
                                    {adj.status === "Voided" ? "Voided:" : "Refunded:"}
                                  </span>{" "}
                                  {adj.adjustedAt ? (() => {
                                    try {
                                      const d = new Date(adj.adjustedAt);
                                      return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
                                    } catch { return "—"; }
                                  })() : <span className="text-muted-foreground italic">Not recorded</span>}
                                </div>
                                <div data-testid={`detail-payment-${adj.orderId}`}>
                                  <span className="font-medium text-muted-foreground">Payment:</span>{" "}
                                  <span>{adj.originalPaymentMethod || "—"}</span>
                                </div>
                                <div data-testid={`detail-rebilled-${adj.orderId}`}>
                                  <span className="font-medium text-muted-foreground">Re-billed:</span>{" "}
                                  {adj.reBilled ? (
                                    <span>
                                      <span className="text-green-600 dark:text-green-400 font-medium">Yes</span>
                                      <span className="text-muted-foreground ml-1">
                                        → #{adj.reBillOrderId} ({adj.reBillPaymentMethod})
                                        {adj.reBillTime && (() => {
                                          try {
                                            const d = new Date(adj.reBillTime);
                                            return <span className="ml-1">{d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })}</span>;
                                          } catch { return null; }
                                        })()}
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">No</span>
                                  )}
                                </div>
                                {(adj.braceletCount > 0 || adj.voucherInfo.length > 0) && (
                                  <div className="flex flex-wrap gap-1.5" data-testid={`detail-physical-items-${adj.orderId}`}>
                                    {adj.braceletCount > 0 && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 font-medium text-[11px]">
                                        {adj.braceletCount} bracelet{adj.braceletCount !== 1 ? "s" : ""}
                                      </span>
                                    )}
                                    {adj.voucherInfo.map((v, vi) => (
                                      <span key={vi} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400 font-medium text-[11px]">
                                        {v.count}× ฿{v.faceValue.toLocaleString()} voucher
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="dash-section-header">Line Items</div>
                              {adj.lineItems.length > 0 ? (
                                <div className="grid gap-1">
                                  {adj.lineItems.map((li, idx) => (
                                    <div
                                      key={idx}
                                      className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background/60"
                                      data-testid={`line-item-${adj.orderId}-${idx}`}
                                    >
                                      <span className="font-medium">{li.name}</span>
                                      <div className="flex items-center gap-3 text-muted-foreground">
                                        <span>×{li.quantity}</span>
                                        <span className="font-medium text-foreground privacy-sensitive">฿{li.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground">No line items available.</div>
                              )}
                              {adj.note && (
                                <div className="text-xs text-muted-foreground mt-1">
                                  <span className="font-medium">Note:</span> {adj.note}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sorted.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-4">
              No adjustments matching the selected filter.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type SurveyBranchKey = "floresta" | "chalong";
type SurveyBranchFilter = "combined" | SurveyBranchKey;
type SurveySummary = {
  date: string;
  endDate: string;
  branchFilter: SurveyBranchKey | null;
  overall: { total: number; visitorType: Record<string, number>; discoveryChannel: Record<string, number> };
  perBranch: Record<SurveyBranchKey, { total: number; visitorType: Record<string, number>; discoveryChannel: Record<string, number> }>;
  visitorTypes: string[];
  discoveryChannels: string[];
  branches: Array<{ key: SurveyBranchKey; name: string }>;
};

const SURVEY_VISITOR_LABELS: Record<string, string> = {
  Tourist: "Tourist",
  Expat: "Expat",
  WinterBird: "Seasonal Resident",
  Thai: "Thai",
};
const SURVEY_CHANNEL_LABELS: Record<string, string> = {
  Booth: "Sales Booth",
  WordOfMouth: "Word of Mouth",
  Google: "Google",
  Aquarium: "Aquarium",
  Meta: "Facebook/Instagram",
};

function VisitorSurveySection({ startDate, endDate }: { startDate: string; endDate: string }) {
  const [branchFilter, setBranchFilter] = useState<SurveyBranchFilter>("combined");
  const isMultiDay = endDate !== startDate;

  const { data, isLoading } = useQuery<SurveySummary>({
    queryKey: ["/api/visitor-survey/summary", startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ date: startDate });
      if (endDate && endDate !== startDate) params.set("end", endDate);
      const res = await fetch(`/api/visitor-survey/summary?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const bucket = useMemo(() => {
    if (!data) return null;
    if (branchFilter === "combined") return data.overall;
    return data.perBranch[branchFilter];
  }, [data, branchFilter]);

  const visitorChartData = useMemo(() => {
    if (!bucket || !data) return [];
    return data.visitorTypes.map((t) => ({ name: SURVEY_VISITOR_LABELS[t] || t, count: bucket.visitorType[t] || 0 }));
  }, [bucket, data]);

  const channelChartData = useMemo(() => {
    if (!bucket || !data) return [];
    return data.discoveryChannels.map((c) => ({ name: SURVEY_CHANNEL_LABELS[c] || c, count: bucket.discoveryChannel[c] || 0 }));
  }, [bucket, data]);

  return (
    <div className="space-y-4" data-testid="section-visitor-survey">
      <p className="text-xs text-muted-foreground">
        Public survey link: <a href="/survey" className="underline" data-testid="link-survey">/survey</a>
      </p>

      <div className="flex flex-wrap gap-1.5" data-testid="filter-survey-branch">
        {(
          [
            { key: "combined", label: "Combined" },
            ...(data?.branches.map((b) => ({ key: b.key, label: b.name })) ?? [
              { key: "floresta", label: "Central Floresta" },
              { key: "chalong", label: "Robinsons Chalong" },
            ]),
          ] as Array<{ key: SurveyBranchFilter; label: string }>
        ).map((b) => (
          <Button
            key={b.key}
            size="sm"
            variant={branchFilter === b.key ? "default" : "outline"}
            className="h-7 text-xs"
            onClick={() => setBranchFilter(b.key)}
            data-testid={`button-survey-filter-${b.key}`}
          >
            {b.label}
          </Button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading survey…
        </div>
      )}

      {!isLoading && bucket && (
        <>
          <div className="dash-stat-strip" data-testid="survey-kpi-strip">
            <div className="dash-stat-cell" data-testid="stat-survey-total">
              <div className="dash-stat-label">Total</div>
              <div className="dash-stat-value">{bucket.total}</div>
            </div>
            {(["Tourist", "Expat", "WinterBird", "Thai"] as const).map((t) => (
              <div className="dash-stat-cell" key={t} data-testid={`stat-survey-visitor-${t}`}>
                <div className="dash-stat-label">{SURVEY_VISITOR_LABELS[t] || t}</div>
                <div className="dash-stat-value">{bucket.visitorType[t] || 0}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border p-3">
              <div className="dash-section-header mb-2">Visitor type</div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={visitorChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="dash-section-header mb-2">Discovery channel</div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={channelChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {branchFilter === "combined" && data && data.branches.length > 0 && (() => {
            const branchTotal = data.branches.reduce(
              (sum, b) => sum + (data.perBranch[b.key]?.total || 0),
              0,
            );
            return (
            <SubGroupRow
              label="Branch breakdown"
              value={
                <>
                  <span className="dash-meta">
                    {data.branches.length} {data.branches.length === 1 ? "branch" : "branches"}
                  </span>
                  <span className="dash-row-value-emph">
                    {branchTotal} {branchTotal === 1 ? "response" : "responses"}
                  </span>
                </>
              }
              testId="survey-branch-breakdown"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.branches.map((b) => {
                  const pb = data.perBranch[b.key];
                  return (
                    <div
                      key={b.key}
                      className="rounded-lg border p-2.5 flex items-center justify-between"
                      data-testid={`stat-survey-branch-${b.key}`}
                    >
                      <span className="dash-row-label">{b.name}</span>
                      <span className="dash-row-value-emph">{pb?.total || 0}</span>
                    </div>
                  );
                })}
              </div>
            </SubGroupRow>
            );
          })()}

          {bucket.total === 0 && (
            <div className="text-center text-sm text-muted-foreground py-4" data-testid="text-survey-empty">
              {isMultiDay ? "No responses yet for this period." : "No responses yet for this day."}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function FuntopiaDashboard() {
  const { theme } = useTheme();
  const { toast } = useToast();
  const [activeBranches, setActiveBranches] = useState<ActiveBranches>(parseSavedBranches);
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash.replace("#", "");
      if (["today", "weekly", "calendar", "trends", "campaigns", "config"].includes(hash)) {
        return hash;
      }
    }
    return "today";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const newHash = activeTab === "today" ? "" : `#${activeTab}`;
    if (window.location.hash !== newHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${newHash}`);
    }
  }, [activeTab]);
  const tabBarScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = tabBarScrollRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(`[data-testid="tab-${activeTab}"]`);
    if (!active) return;
    const cRect = container.getBoundingClientRect();
    const aRect = active.getBoundingClientRect();
    if (aRect.left < cRect.left || aRect.right > cRect.right) {
      const offset = active.offsetLeft - (container.clientWidth - active.clientWidth) / 2;
      container.scrollTo({ left: Math.max(0, offset), behavior: "smooth" });
    }
  }, [activeTab]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncTotalDays, setSyncTotalDays] = useState(0);
  const [syncSyncedDays, setSyncSyncedDays] = useState(0);
  const [syncEta, setSyncEta] = useState("");
  const [pushing, setPushing] = useState(false);
  const [wipeDialogOpen, setWipeDialogOpen] = useState(false);
  const [wipeConfirmText, setWipeConfirmText] = useState("");
  const [wiping, setWiping] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [prodUrl, setProdUrl] = useState(() => localStorage.getItem("funtopia_prod_url") || "");
  const [pushDateFrom, setPushDateFrom] = useState<string | undefined>(undefined);
  const [pushDateTo, setPushDateTo] = useState<string | undefined>(undefined);
  const [lockingMonth, setLockingMonth] = useState(false);
  const [expandedFormulaCategories, setExpandedFormulaCategories] = useState<Record<string, boolean>>({});
  const [papayaSyncing, setPapayaSyncing] = useState(false);
  const [papayaSyncMessage, setPapayaSyncMessage] = useState<string | null>(null);
  const [florestaFullSyncRange, setFlorestaFullSyncRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [florestaFullSyncOpen, setFlorestaFullSyncOpen] = useState(false);
  const [florestaProcessRange, setFlorestaProcessRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [florestaProcessOpen, setFlorestaProcessOpen] = useState(false);
  const [florestaProcessing, setFlorestaProcessing] = useState(false);
  const [florestaProcessMessage, setFlorestaProcessMessage] = useState<string | null>(null);
  const [reportRange, setReportRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [reportGenerating, setReportGenerating] = useState(false);
  const [cashCollectionGenerating, setCashCollectionGenerating] = useState(false);
  const [chalongFullSyncRange, setChalongFullSyncRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [chalongFullSyncOpen, setChalongFullSyncOpen] = useState(false);
  const [chalongProcessRange, setChalongProcessRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [chalongProcessOpen, setChalongProcessOpen] = useState(false);
  const [chalongProcessing, setChalongProcessing] = useState(false);
  const [chalongProcessMessage, setChalongProcessMessage] = useState<string | null>(null);
  const [todayPeriod, setTodayPeriod] = useState<TodayPeriod>("today");
  const [dateOffset, setDateOffset] = useState(0);
  const [customDateRange, setCustomDateRange] = useState<{ from: Date; to?: Date } | null>(null);
  const [customDraftRange, setCustomDraftRange] = useState<{ from?: Date; to?: Date } | undefined>();
  const [customPickerOpen, setCustomPickerOpen] = useState(false);

  type CompareOption = "none" | "yesterday" | "same_period_last_week" | "same_period_last_month" | "same_period_last_year" | "custom" | "forecast" | "stly";
  const [compareWith, setCompareWith] = useState<CompareOption>("none");
  const [compareCustomRange, setCompareCustomRange] = useState<{ from: Date; to?: Date } | null>(null);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [compareDropdownOpen, setCompareDropdownOpen] = useState(false);

  const [vouchersToFnb, setVouchersToFnb] = useState(false);
  const [bdToFnb, setBdToFnb] = useState(false);

  // task-114: Chalong branch BD allocation toggle. "bday" (default) keeps
  // birthday-channel orders fully under "Events / Birthdays". "split"
  // re-buckets each line item to its natural category server-side. Lives
  // here (not in CategoryRevenueBreakdown) so the toggle button rendered
  // in this component's header can read/write it.
  const chalongAllocationQueryKey = [
    "/api/funtopia/preferences/birthday-allocation",
    "chalong",
  ] as const;
  const { data: chalongAllocationPref } = useQuery<{
    branch: string;
    allocation: "bday" | "split";
  }>({
    queryKey: chalongAllocationQueryKey,
    queryFn: () =>
      fetch(
        `/api/funtopia/preferences/birthday-allocation?branch=chalong`,
      ).then((r) => r.json()),
    staleTime: 60_000,
  });
  // task-114 v3: instant toggle. The server pref is persisted for cross-device
  // memory, but the toggle's visual effect is driven by a local override that
  // flips synchronously on click — no refetch, no skeleton flash. The server
  // now always emits the natural-category split as metadata on every Papaya
  // summary so we can re-bucket entirely client-side.
  const [chalongBdSplitLocal, setChalongBdSplitLocal] = useState<boolean | null>(null);
  const chalongBdSplitServer = chalongAllocationPref?.allocation === "split";
  const chalongBdSplit = chalongBdSplitLocal ?? chalongBdSplitServer;
  useEffect(() => {
    // Clear the local override once the server pref catches up so the two
    // sources can't drift if the user changes the pref from another tab.
    if (chalongBdSplitLocal !== null && chalongAllocationPref && chalongBdSplitLocal === chalongBdSplitServer) {
      setChalongBdSplitLocal(null);
    }
  }, [chalongAllocationPref, chalongBdSplitLocal, chalongBdSplitServer]);
  const chalongAllocationMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const allocation = next ? "split" : "bday";
      return apiRequest(
        "PUT",
        "/api/funtopia/preferences/birthday-allocation",
        { branch: "chalong", allocation },
      ).then((r) => r.json());
    },
    onSuccess: () => {
      // Only refresh the pref query itself; data queries already carry the
      // split metadata and don't need to be refetched on toggle.
      queryClient.invalidateQueries({ queryKey: chalongAllocationQueryKey });
    },
  });
  const [compDeltaMode, setCompDeltaMode] = useState<CompDeltaMode>("pct");
  const [graphFilter, setGraphFilter] = useState<PerfGraphFilter>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>("orders");
  const [includeSummerCamp, setIncludeSummerCamp] = useState(true);
  const [includeWeekends, setIncludeWeekends] = useState(true);
  const [perfChartType, setPerfChartType] = useState<"line" | "bar">("line");

  const toggleBranch = (mode: "floresta" | "chalong") => {
    let changed = false;
    setActiveBranches(prev => {
      const next = new Set<Branch>(prev);
      if (next.has(mode)) {
        if (next.size === 1) return prev; // keep at least one branch selected
        next.delete(mode);
      } else {
        next.add(mode);
      }
      changed = true;
      localStorage.setItem("oto_branches", JSON.stringify(Array.from(next)));
      return next;
    });
    if (changed) queryClient.invalidateQueries();
  };

  const hasFloresta = activeBranches.has("floresta");
  const hasChalong = activeBranches.has("chalong");
  const isBothBranches = hasFloresta && hasChalong;
  const isChalongOnly = hasChalong && !hasFloresta;
  const branchKey = Array.from(activeBranches).sort().join(",");

  useEffect(() => {
    if (isChalongOnly && compareWith === "forecast") {
      setCompareWith("stly");
    }
    if (!hasChalong && compareWith === "stly") {
      setCompareWith("forecast");
    }
  }, [isChalongOnly, hasChalong]);

  const navigateBack = () => setDateOffset((prev) => prev - 1);
  const navigateForward = () => setDateOffset((prev) => Math.min(prev + 1, 0));
  const resetToToday = () => {
    setDateOffset(0);
    setTodayPeriod("today");
  };

  async function fetchBranchToday(): Promise<DashboardSummaryData> {
    const fetchJson = async (url: string): Promise<DashboardSummaryData> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
      return response.json();
    };
    const fetchers: Promise<DashboardSummaryData>[] = [];
    if (hasFloresta) fetchers.push(fetchJson("/api/funtopia/today"));
    if (hasChalong) fetchers.push(fetchJson("/api/papaya/today"));
    const results = await Promise.all(fetchers);
    if (results.length === 2) return mergeDashboardData(results[0], results[1]);
    return results[0];
  }

  async function fetchBranchRange(start: string, end: string): Promise<DashboardSummaryData> {
    const fetchJson = async (url: string): Promise<DashboardSummaryData> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
      return response.json();
    };
    const fetchers: Promise<DashboardSummaryData>[] = [];
    if (hasFloresta) fetchers.push(fetchJson(`/api/funtopia/range?start=${start}&end=${end}`));
    if (hasChalong) fetchers.push(fetchJson(`/api/papaya/range?from=${start}&to=${end}`));
    const results = await Promise.all(fetchers);
    if (results.length === 2) return mergeDashboardData(results[0], results[1]);
    return results[0];
  }

  const {
    data: todayData,
    isLoading: todayLoading,
    refetch: refetchToday,
    isFetching: todayFetching,
  } = useQuery<DashboardSummaryData>({
    queryKey: ["/api/branch/today", branchKey],
    queryFn: fetchBranchToday,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: (previousData) => previousData,
  });

  const todayPeriodDates = useMemo(
    () => getTodayPeriodDatesWithOffset(todayPeriod, dateOffset, customDateRange),
    [todayPeriod, dateOffset, customDateRange],
  );
  const {
    data: periodData,
    isLoading: periodLoading,
    isFetching: periodFetching,
    refetch: refetchPeriod,
  } = useQuery<DashboardSummaryData>({
    queryKey: [
      "/api/branch/range",
      branchKey,
      todayPeriodDates.start,
      todayPeriodDates.end,
    ],
    queryFn: () => fetchBranchRange(todayPeriodDates.start, todayPeriodDates.end),
    enabled: todayPeriod !== "today" || dateOffset !== 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: (previousData) => previousData,
  });

  const { data: syncStatus, refetch: refetchSyncStatus } = useQuery<any>({
    queryKey: ["/api/funtopia/sync-status"],
    enabled: hasFloresta,
  });

  // task-171: per-branch "POS stopped uploading mid-day" staleness alerts.
  // Polls every 5 min (same cadence as AutoSync) so a mid-day upstream
  // outage surfaces within minutes instead of being noticed a day later.
  const { data: posStalenessData } = useQuery<{
    checkedAt: string;
    alerts: Array<{
      branch: string;
      branchLabel: string;
      stale: boolean;
      lastOrderAt: string | null;
      minutesSinceLastOrder: number | null;
      message: string;
    }>;
  }>({
    queryKey: ["/api/pos-staleness"],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });
  const posStalenessAlerts = useMemo(
    () =>
      (posStalenessData?.alerts || []).filter(
        (a) => a.stale && activeBranches.has(a.branch as any),
      ),
    [posStalenessData, activeBranches],
  );

  // task-178: source gap watchdog — warns when a normally-active Floresta
  // revenue source (Sales Booth, Mascot, etc.) records zero orders for
  // 3+ consecutive days. Polls hourly; the underlying data only changes when
  // new days are synced.
  const { data: sourceWatchdogData } = useQuery<{
    checkedAt: string;
    alerts: Array<{
      source: string;
      lastSeenDate: string | null;
      consecutiveZeroDays: number;
      activeDaysInWindow: number;
      windowDays: number;
    }>;
  }>({
    queryKey: ["/api/funtopia/source-watchdog"],
    enabled: hasFloresta,
    refetchInterval: 60 * 60 * 1000,
    staleTime: 55 * 60 * 1000,
  });
  const sourceGapAlerts = sourceWatchdogData?.alerts ?? [];

  const { data: papayaSyncStatus, refetch: refetchPapayaSyncStatus } = useQuery<any>({
    queryKey: ["/api/papaya/sync-status"],
    enabled: hasChalong,
  });

  const { data: lockedMonthsData, refetch: refetchLockedMonths } = useQuery<{ months: string[] }>({
    queryKey: ["/api/funtopia/locked-months"],
    enabled: hasFloresta,
  });
  const lockedMonths = lockedMonthsData?.months || [];

  const { data: formulaData, isLoading: formulaLoading, isError: formulaError } = useQuery<{ version: string; lastUpdated: string; categories: Array<{ category: string; formulas: Array<{ id: string; name: string; description: string; formula: string; version: string; lastUpdated: string }> }> }>({
    queryKey: ["/api/funtopia/formulas"],
  });


  const toggleFormulaCategory = (cat: string) => {
    setExpandedFormulaCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const toggleLockedMonth = async (month: string) => {
    setLockingMonth(true);
    try {
      const newMonths = lockedMonths.includes(month)
        ? lockedMonths.filter(m => m !== month)
        : [...lockedMonths, month].sort();
      await apiRequest("POST", "/api/funtopia/locked-months", { months: newMonths });
      refetchLockedMonths();
    } catch (err) {
      console.error("Failed to toggle lock:", err);
    } finally {
      setLockingMonth(false);
    }
  };

  const availableMonths = useMemo(() => {
    const today = getBangkokToday();
    const currentMonth = today.substring(0, 7);
    const months: { month: string; label: string; complete: boolean }[] = [];
    let d = new Date("2026-01-01T12:00:00");
    const end = new Date(today + "T12:00:00");
    const seen = new Set<string>();
    while (d <= end) {
      const m = d.toISOString().substring(0, 7);
      if (!seen.has(m)) {
        seen.add(m);
        const [y, mo] = m.split("-");
        const label = new Date(parseInt(y), parseInt(mo) - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
        months.push({ month: m, label, complete: m < currentMonth });
      }
      d.setDate(d.getDate() + 1);
    }
    return months;
  }, []);

  const compareDates = useMemo(() => {
    if (compareWith === "none" || compareWith === "forecast") return null;
    if (compareWith === "stly") {
      const currentStart = new Date(todayPeriodDates.start + "T12:00:00");
      const currentEnd = new Date(todayPeriodDates.end + "T12:00:00");
      if (todayPeriod === "month") {
        const sameMonthLastYear = new Date(currentStart.getFullYear() - 1, currentStart.getMonth(), 1, 12, 0, 0);
        const sameMonthLastYearEnd = new Date(currentStart.getFullYear() - 1, currentStart.getMonth() + 1, 0, 12, 0, 0);
        const label = `${MONTH_LABELS[sameMonthLastYear.getMonth()]} ${sameMonthLastYear.getFullYear()}`;
        return { start: fmtDateLocal(sameMonthLastYear), end: fmtDateLocal(sameMonthLastYearEnd), label };
      }
      const s = new Date(currentStart);
      s.setFullYear(s.getFullYear() - 1);
      const e = new Date(currentEnd);
      e.setFullYear(e.getFullYear() - 1);
      const label = fmtDateLocal(s) === fmtDateLocal(e)
        ? `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} ${s.getFullYear()}`
        : `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]} ${e.getFullYear()}`;
      return { start: fmtDateLocal(s), end: fmtDateLocal(e), label };
    }
    const currentStart = new Date(todayPeriodDates.start + "T12:00:00");
    const currentEnd = new Date(todayPeriodDates.end + "T12:00:00");

    if (compareWith === "custom" && compareCustomRange) {
      const from = compareCustomRange.from;
      const to = compareCustomRange.to || from;
      const label = from.getTime() === to.getTime()
        ? `${from.getDate()} ${MONTH_LABELS[from.getMonth()]}`
        : `${from.getDate()} ${MONTH_LABELS[from.getMonth()]} – ${to.getDate()} ${MONTH_LABELS[to.getMonth()]}`;
      return { start: fmtDateLocal(from), end: fmtDateLocal(to), label };
    }
    if (compareWith === "yesterday") {
      const d = new Date(currentStart);
      d.setDate(d.getDate() - 1);
      const dayLabel = `${DAY_NAMES[d.getDay()].substring(0, 3)} ${d.getDate()} ${MONTH_LABELS[d.getMonth()]}`;
      return { start: fmtDateLocal(d), end: fmtDateLocal(d), label: dayLabel };
    }
    if (compareWith === "same_period_last_week") {
      if (todayPeriod === "week") {
        const prevWeekStart = new Date(currentStart);
        prevWeekStart.setDate(prevWeekStart.getDate() - 7);
        const prevWeekEnd = new Date(prevWeekStart);
        prevWeekEnd.setDate(prevWeekStart.getDate() + 6);
        prevWeekStart.setHours(12, 0, 0, 0);
        prevWeekEnd.setHours(12, 0, 0, 0);
        const label = `${prevWeekStart.getDate()} ${MONTH_LABELS[prevWeekStart.getMonth()]} – ${prevWeekEnd.getDate()} ${MONTH_LABELS[prevWeekEnd.getMonth()]}`;
        return { start: fmtDateLocal(prevWeekStart), end: fmtDateLocal(prevWeekEnd), label };
      }
      const s = new Date(currentStart);
      s.setDate(s.getDate() - 7);
      const e = new Date(currentEnd);
      e.setDate(e.getDate() - 7);
      const label = fmtDateLocal(s) === fmtDateLocal(e)
        ? `${DAY_NAMES[s.getDay()].substring(0, 3)} ${s.getDate()} ${MONTH_LABELS[s.getMonth()]}`
        : `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]}`;
      return { start: fmtDateLocal(s), end: fmtDateLocal(e), label };
    }
    if (compareWith === "same_period_last_month") {
      if (todayPeriod === "month") {
        const prevMonthStart = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1, 12, 0, 0);
        const prevMonthEnd = new Date(currentStart.getFullYear(), currentStart.getMonth(), 0, 12, 0, 0);
        const label = `${MONTH_LABELS[prevMonthStart.getMonth()]} ${prevMonthStart.getFullYear()}`;
        return { start: fmtDateLocal(prevMonthStart), end: fmtDateLocal(prevMonthEnd), label };
      }
      const s = new Date(currentStart);
      s.setMonth(s.getMonth() - 1);
      const e = new Date(currentEnd);
      e.setMonth(e.getMonth() - 1);
      const label = fmtDateLocal(s) === fmtDateLocal(e)
        ? `${DAY_NAMES[s.getDay()].substring(0, 3)} ${s.getDate()} ${MONTH_LABELS[s.getMonth()]}`
        : `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]}`;
      return { start: fmtDateLocal(s), end: fmtDateLocal(e), label };
    }
    if (compareWith === "same_period_last_year") {
      if (todayPeriod === "month") {
        const sameMonthLastYear = new Date(currentStart.getFullYear() - 1, currentStart.getMonth(), 1, 12, 0, 0);
        const sameMonthLastYearEnd = new Date(currentStart.getFullYear() - 1, currentStart.getMonth() + 1, 0, 12, 0, 0);
        const label = `${MONTH_LABELS[sameMonthLastYear.getMonth()]} ${sameMonthLastYear.getFullYear()}`;
        return { start: fmtDateLocal(sameMonthLastYear), end: fmtDateLocal(sameMonthLastYearEnd), label };
      }
      const s = new Date(currentStart);
      s.setFullYear(s.getFullYear() - 1);
      const e = new Date(currentEnd);
      e.setFullYear(e.getFullYear() - 1);
      const label = fmtDateLocal(s) === fmtDateLocal(e)
        ? `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} ${s.getFullYear()}`
        : `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]} ${e.getFullYear()}`;
      return { start: fmtDateLocal(s), end: fmtDateLocal(e), label };
    }
    return null;
  }, [compareWith, todayPeriod, todayPeriodDates, compareCustomRange]);

  const {
    data: compareDataRaw,
    isFetching: compareFetching,
  } = useQuery<DashboardSummaryData>({
    queryKey: ["/api/branch/range", branchKey, compareDates?.start, compareDates?.end, "compare"],
    queryFn: () => fetchBranchRange(compareDates!.start, compareDates!.end),
    enabled: !!compareDates && compareWith !== "none",
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: (previousData) => previousData,
  });

  const forecastCompareData = useMemo<DashboardSummaryData | null>(() => {
    if (compareWith !== "forecast") return null;
    const fc = getForecastForDateRange(todayPeriodDates.start, todayPeriodDates.end, activeBranches);
    const catBreakdown: Record<string, CategoryData> = {};
    for (const [cat, rev] of Object.entries(fc.categoryBreakdown)) {
      catBreakdown[cat] = { revenue: rev, quantity: 0 };
    }
    return {
      totalRevenue: fc.totalRevenue,
      totalOrders: fc.kids,
      avgOrderValue: fc.totalRevenue / (fc.kids || 1),
      paymentBreakdown: {},
      topProducts: [],
      categoryBreakdown: catBreakdown,
      discountTotal: 0,
      guestBreakdown: {
        kidTickets: fc.kids,
        adultTickets: fc.adults,
        kidRevenue: fc.kidRevenue,
        adultRevenue: fc.adultRevenue,
        avgStayHours: 0,
        estimatedTotalAdults: fc.adults,
        totalInPark: fc.totalGuests,
        stayDistribution: [],
        details: [],
      },
      hourlyBreakdown: [],
      customerTypeSplit: fc.customerTypes.map(ct => ({
        type: ct.type,
        orders: ct.orders,
        revenue: ct.revenue,
        kidTickets: ct.kids,
        adultTickets: ct.adults,
        totalGuests: ct.totalGuests,
      })),
      voucherSwingAmount: 0,
      pureTicketRevenue: fc.categoryBreakdown["Tickets & Packages"] || 0,
      dailyRevenue: [],
    };
  }, [compareWith, todayPeriodDates, activeBranches]);

  const compareLabel = compareWith === "forecast" ? "Model Forecast" : compareWith === "stly" ? `STLY ${compareDates?.label || ""}` : (compareDates?.label || "");

  const pollSyncProgress = () => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/funtopia/sync-progress");
        const data = await res.json();
        if (cancelled) return;
        if (data.running) {
          setSyncMessage(data.progress || "Syncing...");
          setSyncing(true);
          if (data.totalDays > 0) {
            setSyncTotalDays(data.totalDays);
            setSyncSyncedDays(data.syncedDays || 0);
            setSyncEta(data.eta || "");
          }
          setTimeout(poll, 2000);
        } else {
          if (data.error) {
            setSyncMessage(`Sync failed: ${data.error}`);
            setTimeout(() => setSyncMessage(null), 6000);
          } else if (data.progress && data.progress.startsWith("Completed")) {
            const warnCount = (data.warnings || []).length;
            const skipCount = (data.skippedDates || []).length;
            if (warnCount > 0) {
              setSyncMessage(`⚠ ${data.progress} — ${skipCount} date(s) skipped to protect existing data`);
            } else {
              setSyncMessage(`✓ ${data.progress}`);
            }
            setSyncTotalDays(0);
            setSyncSyncedDays(0);
            setSyncEta("");
            setTodayPeriod("today");
            setDateOffset(0);
            refetchSyncStatus();
            refetchToday();
            if (todayPeriod !== "today") refetchPeriod();
          }
          setSyncing(false);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    const checkActive = async () => {
      try {
        const res = await fetch("/api/funtopia/sync-progress");
        const data = await res.json();
        if (data.running) {
          setSyncing(true);
          setSyncMessage(data.progress || "Syncing...");
          if (data.totalDays > 0) {
            setSyncTotalDays(data.totalDays);
            setSyncSyncedDays(data.syncedDays || 0);
            setSyncEta(data.eta || "");
          }
          const cancel = pollSyncProgress();
          return cancel;
        }
      } catch {}
    };
    let cancelFn: (() => void) | undefined;
    checkActive().then((fn) => {
      cancelFn = fn;
    });
    return () => {
      if (cancelFn) cancelFn();
    };
  }, []);

  const doSync = async (
    mode: "quick" | "full",
    start?: string,
    end?: string,
  ) => {
    setSyncing(true);
    setSyncMessage(
      mode === "quick"
        ? "Quick syncing yesterday & today..."
        : "Full sync starting — downloading data (skips already cached days)...",
    );
    try {
      const body: any = { mode };
      if (start) body.start = start;
      if (end) body.end = end;
      const res = await apiRequest("POST", "/api/funtopia/sync", body);
      const result = await res.json();

      if (result.status === "push_protected") {
        setSyncMessage(`⚠ ${result.message}`);
        setTimeout(() => setSyncMessage(null), 8000);
        setSyncing(false);
        return;
      }

      if (result.status === "started") {
        if (result.pushWarning) {
          setSyncMessage(`⚠ ${result.pushWarning}`);
          setTimeout(() => {
            setSyncMessage(null);
          }, 6000);
        }
        setSyncTotalDays(0);
        setSyncSyncedDays(0);
        setSyncEta("");
        pollSyncProgress();
        return;
      }

      if (result.status === "already_running") {
        const dateRange = result.syncStartDate && result.syncEndDate
          ? `${result.syncStartDate} → ${result.syncEndDate}`
          : "";
        setSyncMessage(`A sync is already in progress${dateRange ? `: ${dateRange}` : ""}. Please wait for it to finish.`);
        setSyncTotalDays(result.totalDays || 0);
        setSyncSyncedDays(result.syncedDays || 0);
        setSyncEta(result.eta || "");
        pollSyncProgress();
        return;
      }

      const warnCount = (result.warnings || []).length;
      const skipCount = (result.skippedDates || []).length;
      const warnSuffix = warnCount > 0 ? ` (${warnCount} warning(s), ${skipCount} date(s) skipped due to data drop)` : "";
      setSyncMessage(`✓ Synced ${result.synced} day(s) to database${warnSuffix}`);
      refetchSyncStatus();
      refetchToday();
      if (todayPeriod !== "today") refetchPeriod();
      setTimeout(() => setSyncMessage(null), warnCount > 0 ? 8000 : 4000);
      setSyncing(false);
    } catch (err: any) {
      setSyncMessage("Sync failed: " + (err.message || "Unknown error"));
      setTimeout(() => setSyncMessage(null), 5000);
      setSyncing(false);
    }
  };

  const doPapayaSync = async (mode: "quick" | "full", terminal?: string) => {
    setPapayaSyncing(true);
    const termLabel = terminal === "reception" ? "Park" : terminal === "restaurant" ? "Cafe" : "Chalong";
    setPapayaSyncMessage(mode === "quick" ? `Quick syncing ${termLabel} data...` : `Full syncing ${termLabel} data...`);
    try {
      const now = new Date(Date.now() + 7 * 3600 * 1000);
      const todayStr = now.toISOString().split("T")[0];
      const yesterday = new Date(now.getTime() - 86400000).toISOString().split("T")[0];
      const from = mode === "quick" ? yesterday : (() => { const d = new Date(now); d.setDate(d.getDate() - 90); return d.toISOString().split("T")[0]; })();
      const to = todayStr;
      const body: any = { from, to, mode };
      if (terminal) body.terminal = terminal;
      const res = await apiRequest("POST", "/api/papaya/sync", body);
      const result = await res.json();
      if (result.status === "started" || result.status === "already_running") {
        const poll = setInterval(async () => {
          try {
            const pr = await fetch("/api/papaya/sync-progress");
            const pd = await pr.json();
            setPapayaSyncMessage(pd.progress || "Syncing...");
            if (!pd.running) {
              clearInterval(poll);
              setPapayaSyncing(false);
              setPapayaSyncMessage(`✓ ${pd.progress || "Sync complete"}`);
              refetchPapayaSyncStatus();
              refetchToday();
              if (todayPeriod !== "today") refetchPeriod();
              setTimeout(() => setPapayaSyncMessage(null), 5000);
            }
          } catch {
            clearInterval(poll);
            setPapayaSyncing(false);
          }
        }, 2000);
        return;
      }
      setPapayaSyncMessage("✓ Sync complete");
      refetchPapayaSyncStatus();
      refetchToday();
      setTimeout(() => setPapayaSyncMessage(null), 4000);
      setPapayaSyncing(false);
    } catch (err: any) {
      setPapayaSyncMessage("Sync failed: " + (err.message || "Unknown error"));
      setTimeout(() => setPapayaSyncMessage(null), 5000);
      setPapayaSyncing(false);
    }
  };

  const doPushToProduction = async () => {
    if (!prodUrl.trim()) {
      setPushMessage("Error: Please enter your published app URL first.");
      return;
    }
    localStorage.setItem("funtopia_prod_url", prodUrl.trim());
    setPushing(true);
    setPushMessage("Starting push to production...");
    try {
      const pushBody: { productionUrl: string; fromDate?: string; toDate?: string } = { productionUrl: prodUrl.trim() };
      if (pushDateFrom && pushDateTo) {
        pushBody.fromDate = pushDateFrom;
        pushBody.toDate = pushDateTo;
      }
      const res = await apiRequest("POST", "/api/funtopia/push-to-production", pushBody);
      const result = await res.json();
      if (!result.success) {
        setPushMessage(result.message || "Failed to start push");
        setPushing(false);
        return;
      }
      const poll = setInterval(async () => {
        try {
          const pr = await fetch("/api/funtopia/push-progress");
          const pd = await pr.json();
          setPushMessage(pd.progress || "Pushing...");
          if (!pd.running) {
            clearInterval(poll);
            setPushing(false);
            if (pd.error) {
              setPushMessage(`Error: ${pd.error}`);
            } else {
              setPushMessage(pd.progress || "Push complete!");
            }
          }
        } catch {
          clearInterval(poll);
          setPushing(false);
        }
      }, 3000);
    } catch (err: any) {
      setPushMessage(`Error: ${err.message}`);
      setPushing(false);
    }
  };

  const doWipeProductionData = async () => {
    if (wipeConfirmText !== "DELETE EVERYTHING") return;
    setWiping(true);
    try {
      const resp = await apiRequest("POST", "/api/funtopia/wipe-production", {
        productionUrl: prodUrl.trim(),
      });
      const data = await resp.json();
      if (!data.success) {
        if (data.partial) {
          const errors = data.results?.filter((r: any) => r.status.startsWith("error")) || [];
          toast({ title: "Partial wipe failure", description: `Some tables failed: ${errors.map((r: any) => r.table).join(", ")}`, variant: "destructive" });
        } else {
          toast({ title: "Wipe failed", description: data.message || "Wipe request failed", variant: "destructive" });
        }
      } else {
        const wiped = data.results?.filter((r: any) => r.status === "wiped").length || 0;
        toast({ title: "Production data wiped", description: `Successfully wiped ${wiped} table(s) on production.` });
      }
    } catch (err: any) {
      toast({ title: "Wipe failed", description: err.message, variant: "destructive" });
    } finally {
      setWiping(false);
      setWipeDialogOpen(false);
      setWipeConfirmText("");
    }
  };

  const doFlorestaFullSync = async (from: string, to: string) => {
    setSyncing(true);
    setSyncMessage(`Full sync: ${from} → ${to}...`);
    try {
      const res = await apiRequest("POST", "/api/funtopia/sync", { mode: "full", start: from, end: to, force: true });
      const result = await res.json();
      if (result.status === "started") {
        setSyncTotalDays(0);
        setSyncSyncedDays(0);
        setSyncEta("");
        pollSyncProgress();
        return;
      }
      if (result.status === "already_running") {
        const dateRange = result.syncStartDate && result.syncEndDate
          ? `${result.syncStartDate} → ${result.syncEndDate}`
          : "";
        setSyncMessage(`A sync is already in progress${dateRange ? `: ${dateRange}` : ""}. Please wait for it to finish.`);
        setSyncTotalDays(result.totalDays || 0);
        setSyncSyncedDays(result.syncedDays || 0);
        setSyncEta(result.eta || "");
        pollSyncProgress();
        return;
      }
      setSyncMessage(`✓ Synced ${result.synced} day(s)`);
      refetchSyncStatus();
      refetchToday();
      if (todayPeriod !== "today") refetchPeriod();
      setTimeout(() => setSyncMessage(null), 4000);
      setSyncing(false);
    } catch (err: any) {
      setSyncMessage("Sync failed: " + (err.message || "Unknown error"));
      setTimeout(() => setSyncMessage(null), 5000);
      setSyncing(false);
    }
  };

  const doFlorestaProcess = async (from: string, to: string) => {
    setFlorestaProcessing(true);
    setFlorestaProcessMessage(`Processing L1→L2: ${from} → ${to}...`);
    try {
      const res = await apiRequest("POST", "/api/funtopia/process", { from, to });
      const result = await res.json();
      if (result.status === "started" || result.status === "already_running") {
        const poll = setInterval(async () => {
          try {
            const pr = await fetch("/api/funtopia/process-progress");
            const pd = await pr.json();
            setFlorestaProcessMessage(pd.progress || "Processing...");
            if (!pd.running) {
              clearInterval(poll);
              setFlorestaProcessing(false);
              setFlorestaProcessMessage(`✓ ${pd.progress || "Processing complete"}`);
              refetchSyncStatus();
              refetchToday();
              if (todayPeriod !== "today") refetchPeriod();
              setTimeout(() => setFlorestaProcessMessage(null), 5000);
            }
          } catch {
            clearInterval(poll);
            setFlorestaProcessing(false);
          }
        }, 2000);
        return;
      }
      setFlorestaProcessMessage("✓ Processing complete");
      refetchSyncStatus();
      refetchToday();
      setTimeout(() => setFlorestaProcessMessage(null), 4000);
      setFlorestaProcessing(false);
    } catch (err: any) {
      setFlorestaProcessMessage("Processing failed: " + (err.message || "Unknown error"));
      setTimeout(() => setFlorestaProcessMessage(null), 5000);
      setFlorestaProcessing(false);
    }
  };

  const doChalongFullSync = async (from: string, to: string) => {
    setPapayaSyncing(true);
    setPapayaSyncMessage(`Full sync: ${from} → ${to}...`);
    try {
      const res = await apiRequest("POST", "/api/papaya/sync", { from, to, mode: "full" });
      const result = await res.json();
      if (result.status === "started" || result.status === "already_running") {
        const poll = setInterval(async () => {
          try {
            const pr = await fetch("/api/papaya/sync-progress");
            const pd = await pr.json();
            setPapayaSyncMessage(pd.progress || "Syncing...");
            if (!pd.running) {
              clearInterval(poll);
              setPapayaSyncing(false);
              setPapayaSyncMessage(`✓ ${pd.progress || "Sync complete"}`);
              refetchPapayaSyncStatus();
              refetchToday();
              if (todayPeriod !== "today") refetchPeriod();
              setTimeout(() => setPapayaSyncMessage(null), 5000);
            }
          } catch {
            clearInterval(poll);
            setPapayaSyncing(false);
          }
        }, 2000);
        return;
      }
      setPapayaSyncMessage("✓ Sync complete");
      refetchPapayaSyncStatus();
      refetchToday();
      setTimeout(() => setPapayaSyncMessage(null), 4000);
      setPapayaSyncing(false);
    } catch (err: any) {
      setPapayaSyncMessage("Sync failed: " + (err.message || "Unknown error"));
      setTimeout(() => setPapayaSyncMessage(null), 5000);
      setPapayaSyncing(false);
    }
  };

  const doChalongProcess = async (from: string, to: string) => {
    setChalongProcessing(true);
    setChalongProcessMessage(`Processing L1→L2: ${from} → ${to}...`);
    try {
      const res = await apiRequest("POST", "/api/papaya/process", { from, to });
      const result = await res.json();
      if (result.status === "started" || result.status === "already_running") {
        const poll = setInterval(async () => {
          try {
            const pr = await fetch("/api/papaya/process-progress");
            const pd = await pr.json();
            setChalongProcessMessage(pd.progress || "Processing...");
            if (!pd.running) {
              clearInterval(poll);
              setChalongProcessing(false);
              setChalongProcessMessage(`✓ ${pd.progress || "Processing complete"}`);
              refetchPapayaSyncStatus();
              refetchToday();
              if (todayPeriod !== "today") refetchPeriod();
              setTimeout(() => setChalongProcessMessage(null), 5000);
            }
          } catch {
            clearInterval(poll);
            setChalongProcessing(false);
          }
        }, 2000);
        return;
      }
      setChalongProcessMessage("✓ Processing complete");
      refetchPapayaSyncStatus();
      refetchToday();
      setTimeout(() => setChalongProcessMessage(null), 4000);
      setChalongProcessing(false);
    } catch (err: any) {
      setChalongProcessMessage("Processing failed: " + (err.message || "Unknown error"));
      setTimeout(() => setChalongProcessMessage(null), 5000);
      setChalongProcessing(false);
    }
  };

  const isLiveToday = todayPeriod === "today" && dateOffset === 0;
  const activeDataRaw = isLiveToday ? todayData : periodData;

  // task-119 follow-up: name-based Food / Drinks classifier for Papaya F&B
  // items. Mirrors classifyPapayaFnbSubCategory on the server so the
  // client-side BD-split merge can rebuild the F&B sub-grouping without a
  // refetch. Defaults to Food.
  const classifyPapayaFnbSubCategoryClient = (rawName: string): "Food" | "Drinks" => {
    const n = (rawName || "").toLowerCase();
    const drinkKeywords = [
      "espresso", "americano", "cappuccino", "latte", "mocha", "macchiato",
      "hot chocolate", "iced chocolate", "coffee",
      " tea", "earl grey", "english breakfast", "peppermint", "green tea", "camomile",
      "smoothie", "juice", "lemonade", "soda", " mors", "milk",
      "water", "pellegrino", "acqua panna", "sparkling",
      "beer", "singha", "wine", "prosecco", "bubbles",
      "(glass)", "(bottle)", " jug", "jug of", "jug ",
      "coke", "coke zero",
    ];
    return drinkKeywords.some((k) => n.includes(k)) ? "Drinks" : "Food";
  };

  // task-114 v3: apply the Chalong BD-allocation split client-side. The
  // server always returns the natural-category breakdown of birthday-channel
  // revenue as `birthdayChannelSplit` metadata; when the toggle is on we
  // subtract those amounts from "Events / Birthdays" and re-bucket them
  // under their natural categories without any refetch.
  const applyChalongBdSplit = useCallback(
    <T extends Partial<DashboardSummaryData> | null | undefined>(d: T): T => {
      if (!d || !chalongBdSplit || !hasChalong) return d;
      const split = d.birthdayChannelSplit;
      if (!split || Object.keys(split).length === 0) return d;
      const cats: Record<string, any> = {};
      for (const [k, v] of Object.entries(d.categoryBreakdown || {})) {
        cats[k] = { ...v, items: [...(v.items || [])] };
      }
      const bdayKey = "Events / Birthdays";
      for (const [natCat, info] of Object.entries(split)) {
        const i = info as { revenue: number; quantity: number; items: any[] };
        if (cats[bdayKey]) {
          cats[bdayKey].revenue = Math.max(0, (cats[bdayKey].revenue || 0) - (i.revenue || 0));
          cats[bdayKey].quantity = Math.max(0, (cats[bdayKey].quantity || 0) - (i.quantity || 0));
          const moveNames = new Set((i.items || []).map((it) => it.name));
          cats[bdayKey].items = (cats[bdayKey].items || []).filter((it: any) => !moveNames.has(it.name));
        }
        if (!cats[natCat]) cats[natCat] = { revenue: 0, quantity: 0, items: [] };
        cats[natCat].revenue = (cats[natCat].revenue || 0) + (i.revenue || 0);
        cats[natCat].quantity = (cats[natCat].quantity || 0) + (i.quantity || 0);
        // task-119: key by name + bday flag so the server's split rows
        // (one bday row + one non-bday row for the same product) survive
        // this merge. Otherwise the chalong grouping toggle has no split
        // rows to toggle because they get collapsed back here.
        const itemKeyOf = (it: any) => `${it.name}::${(it.bdayRevenue || 0) > 0 ? 1 : 0}`;
        const itemMap = new Map<string, any>();
        for (const it of cats[natCat].items || []) itemMap.set(itemKeyOf(it), { ...it });
        for (const it of i.items || []) {
          const incoming = { ...it, bdayRevenue: it.bdayRevenue || it.revenue || 0 };
          const key = itemKeyOf(incoming);
          const ex = itemMap.get(key);
          if (ex) {
            ex.revenue += incoming.revenue || 0;
            ex.quantity += incoming.quantity || 0;
            ex.bdayRevenue = (ex.bdayRevenue || 0) + (incoming.bdayRevenue || 0);
          } else {
            itemMap.set(key, incoming);
          }
        }
        cats[natCat].items = Array.from(itemMap.values()).sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
        // task-119 follow-up: rebuild F&B Food/Drinks sub-categories from the
        // merged item list so the Chalong drill-down keeps its sub-grouping
        // after the BD split toggle re-buckets birthday F&B into F&B.
        if (natCat === "F&B") {
          const subs: Record<string, { revenue: number; quantity: number; items: any[] }> = {
            Food: { revenue: 0, quantity: 0, items: [] },
            Drinks: { revenue: 0, quantity: 0, items: [] },
          };
          for (const it of cats[natCat].items) {
            const sub = classifyPapayaFnbSubCategoryClient(it.name);
            subs[sub].revenue += it.revenue || 0;
            subs[sub].quantity += it.quantity || 0;
            subs[sub].items.push(it);
          }
          for (const k of Object.keys(subs)) {
            subs[k].items.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
          }
          cats[natCat].subCategories = subs;
        }
        if (cats[bdayKey] && cats[bdayKey].revenue <= 0.5 && (cats[bdayKey].quantity || 0) <= 0) {
          delete cats[bdayKey];
        }
      }
      return { ...d, categoryBreakdown: cats } as T;
    },
    [chalongBdSplit, hasChalong],
  );

  const activeData = useMemo(() => applyChalongBdSplit(activeDataRaw), [activeDataRaw, applyChalongBdSplit]);
  const compareData = useMemo(
    () => applyChalongBdSplit(compareDataRaw as DashboardSummaryData | null | undefined) as DashboardSummaryData | undefined,
    [compareDataRaw, applyChalongBdSplit],
  );

  const syncHealthDates = useMemo(() => {
    if (todayPeriod === "today") {
      if (dateOffset === 0) return [getBangkokToday()];
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
      d.setDate(d.getDate() + dateOffset);
      return [fmtDateLocal(d)];
    }
    if (todayPeriodDates?.start && todayPeriodDates?.end) {
      const dates: string[] = [];
      let d = new Date(todayPeriodDates.start + "T12:00:00");
      const end = new Date(todayPeriodDates.end + "T12:00:00");
      while (d <= end) {
        dates.push(d.toISOString().split("T")[0]);
        d.setDate(d.getDate() + 1);
      }
      return dates;
    }
    return [getBangkokToday()];
  }, [todayPeriod, dateOffset, todayPeriodDates]);

  const { data: syncHealthData, refetch: refetchSyncHealthData } = useQuery<{
    health: Array<{
      id: number;
      date: string;
      syncedAt: string;
      status: "clean" | "partial" | "failed" | "skipped";
      ordersExpected: number;
      ordersReceived: number;
      productsExpected: number;
      productsReceived: number;
      paymentsExpected: number;
      paymentsReceived: number;
      errorMessage: string | null;
      warnings: string[] | null;
      revenueDivergence: { cached: number; fresh: number; diff: number } | null;
    }>;
  }>({
    queryKey: ["/api/funtopia/sync-health", syncHealthDates.join(",")],
    queryFn: () => fetch(`/api/funtopia/sync-health?dates=${syncHealthDates.join(",")}`).then(r => r.json()),
    enabled: hasFloresta && syncHealthDates.length > 0,
    staleTime: 60 * 1000,
  });

  const { data: papayaSyncHealthData, refetch: refetchPapayaSyncHealthData } = useQuery<{
    health: Array<{
      id: number;
      date: string;
      syncedAt: string;
      status: "clean" | "partial" | "failed" | "skipped";
      ordersExpected: number;
      ordersReceived: number;
      errorMessage: string | null;
      warnings: string[] | null;
    }>;
  }>({
    queryKey: ["/api/papaya/sync-health", syncHealthDates.join(",")],
    queryFn: () => fetch(`/api/papaya/sync-health?dates=${syncHealthDates.join(",")}`).then(r => r.json()),
    enabled: hasChalong && syncHealthDates.length > 0,
    staleTime: 60 * 1000,
  });

  const resyncMutation = useMutation({
    mutationFn: async (date: string) => {
      const res = await apiRequest("POST", "/api/funtopia/resync-date", { date });
      return res.json();
    },
    onSuccess: () => {
      refetchSyncHealthData();
      refetchToday();
      if (todayPeriod !== "today") refetchPeriod();
      queryClient.invalidateQueries({ queryKey: ["/api/branch/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/branch/range"] });
    },
  });

  const papayaResyncMutation = useMutation({
    mutationFn: async (date: string) => {
      const res = await apiRequest("POST", "/api/papaya/resync-date", { date });
      return res.json();
    },
    onSuccess: () => {
      refetchPapayaSyncHealthData();
      refetchToday();
      if (todayPeriod !== "today") refetchPeriod();
      queryClient.invalidateQueries({ queryKey: ["/api/branch/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/branch/range"] });
      queryClient.invalidateQueries({ queryKey: ["/api/papaya/sync-health"] });
    },
  });

  type BranchSyncIssue = {
    date: string;
    status: "partial" | "failed" | "skipped" | "divergence";
    ordersExpected: number;
    ordersReceived: number;
    errorMessage: string | null;
    warnings: string[] | null;
    branch: "floresta" | "chalong";
    revenueDivergence?: { cached: number; fresh: number; diff: number } | null;
  };

  const syncHealthStatus = useMemo(() => {
    const allIssues: BranchSyncIssue[] = [];
    const allRecords: Array<{ ordersExpected: number; ordersReceived: number; status: string }>  = [];

    if (hasFloresta && syncHealthData?.health) {
      for (const h of syncHealthData.health) {
        allRecords.push(h);
        if (h.status !== "clean") {
          allIssues.push({ date: h.date, status: h.status as BranchSyncIssue["status"], ordersExpected: h.ordersExpected, ordersReceived: h.ordersReceived, errorMessage: h.errorMessage, warnings: h.warnings, branch: "floresta", revenueDivergence: h.revenueDivergence });
        } else if (h.revenueDivergence && Math.abs(h.revenueDivergence.diff) > 1) {
          allIssues.push({ date: h.date, status: "divergence", ordersExpected: h.ordersExpected, ordersReceived: h.ordersReceived, errorMessage: null, warnings: null, branch: "floresta", revenueDivergence: h.revenueDivergence });
        }
      }
    }

    if (hasChalong && papayaSyncHealthData?.health) {
      for (const h of papayaSyncHealthData.health) {
        allRecords.push(h);
        if (h.status !== "clean") {
          allIssues.push({ date: h.date, status: h.status as BranchSyncIssue["status"], ordersExpected: h.ordersExpected, ordersReceived: h.ordersReceived, errorMessage: h.errorMessage, warnings: h.warnings, branch: "chalong" });
        }
      }
    }

    const hasAnyData = allRecords.length > 0;

    if (!hasAnyData) return null;

    let totalExpected = 0;
    let totalReceived = 0;
    let hasFailed = false;
    for (const r of allRecords) {
      if (r.status === "failed") { hasFailed = true; }
      totalExpected += r.ordersExpected || 0;
      totalReceived += r.ordersReceived || 0;
    }
    const rawAccuracy = hasFailed ? 0 : totalExpected > 0 ? Math.round((totalReceived / totalExpected) * 100) : 100;
    const accuracy = Math.min(rawAccuracy, 100);
    const hasDivergence = allIssues.some(i => i.status === "divergence");
    let accuracyColor: "green" | "orange" | "red" = hasFailed ? "red" : accuracy >= 99 ? "green" : accuracy >= 90 ? "orange" : "red";
    if (accuracyColor === "green" && hasDivergence) accuracyColor = "orange";

    const allClean = allIssues.length === 0 && accuracy >= 99;
    return { allClean, issues: allIssues, records: allRecords, accuracy, accuracyColor, totalExpected, totalReceived };
  }, [syncHealthData, papayaSyncHealthData, hasFloresta, hasChalong]);

  const getBangkokTime = () => {
    const now = new Date();
    const bangkokOffset = 7 * 60;
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const totalMin = (utcMinutes + bangkokOffset) % (24 * 60);
    return { hour: Math.floor(totalMin / 60), minute: totalMin % 60 };
  };

  const effectiveCompareData = useMemo(() => {
    if (compareWith === "forecast") return forecastCompareData;
    if (!compareData || compareWith === "none") return null;

    const compCashTotals = compareData.cashReportsDailyTotals || [];
    const compCashTotal = compCashTotals.reduce((s: number, d: any) => s + (d.revenue || 0), 0);
    const hasPosData = (compareData.totalRevenue || 0) > 0;
    const hasCashOnly = !hasPosData && compCashTotal > 0;

    if (hasCashOnly) {
      return {
        ...compareData,
        totalRevenue: compCashTotal,
        totalOrders: compareData.totalOrders || 0,
      } as DashboardSummaryData;
    }

    if (isLiveToday && hasPosData) {
      const bkk = getBangkokTime();
      const hourly = compareData.hourlyBreakdown || [];
      const is20Min = hourly.length > 24;
      const currentSlot = is20Min
        ? bkk.hour * 3 + Math.floor(bkk.minute / 20)
        : bkk.hour;
      const filteredHourly = hourly.filter((h: any) => h.hour <= currentSlot);
      const timeRevenue = filteredHourly.reduce((s: number, h: any) => s + (h.revenue || 0), 0);
      const timeOrders = filteredHourly.reduce((s: number, h: any) => s + (h.orders || 0), 0);
      const timeTickets = filteredHourly.reduce((s: number, h: any) => s + (h.ticketsSold || 0), 0);

      const filteredDailyHourly = (compareData.dailyHourly || []).map((dh: any) => ({
        ...dh,
        hourlyBreakdown: (dh.hourlyBreakdown || []).filter((h: any) => h.hour <= currentSlot),
      }));

      const gb = compareData.guestBreakdown;
      let filteredGuests = gb;
      if (gb && compareData.totalOrders > 0 && timeOrders > 0) {
        const ratio = timeOrders / compareData.totalOrders;
        filteredGuests = {
          ...gb,
          kidTickets: Math.round(gb.kidTickets * ratio),
          adultTickets: Math.round(gb.adultTickets * ratio),
          adultRevenue: gb.adultRevenue * ratio,
          kidRevenue: gb.kidRevenue * ratio,
          estimatedTotalAdults: Math.round(gb.estimatedTotalAdults * ratio),
          totalInPark: Math.round(gb.totalInPark * ratio),
        };
      }

      const cts = compareData.customerTypeSplit;
      let filteredCTS = cts;
      if (cts && compareData.totalOrders > 0 && timeOrders > 0) {
        const ratio = timeOrders / compareData.totalOrders;
        filteredCTS = cts.map((ct: any) => ({
          ...ct,
          revenue: ct.revenue * ratio,
          orders: Math.round(ct.orders * ratio),
          kidTickets: Math.round(ct.kidTickets * ratio),
          adultTickets: Math.round(ct.adultTickets * ratio),
          totalGuests: Math.round(ct.totalGuests * ratio),
        }));
      }

      const catBreakdown = compareData.categoryBreakdown;
      let filteredCats = catBreakdown;
      if (catBreakdown && compareData.totalRevenue > 0 && timeRevenue > 0) {
        const ratio = timeRevenue / compareData.totalRevenue;
        filteredCats = {} as any;
        for (const [key, val] of Object.entries(catBreakdown as Record<string, any>)) {
          filteredCats[key] = {
            ...val,
            revenue: val.revenue * ratio,
            quantity: Math.round(val.quantity * ratio),
          };
        }
      }

      const payBreakdown = compareData.paymentBreakdown;
      let filteredPay = payBreakdown;
      if (payBreakdown && compareData.totalRevenue > 0 && timeRevenue > 0) {
        const ratio = timeRevenue / compareData.totalRevenue;
        filteredPay = {} as any;
        for (const [key, val] of Object.entries(payBreakdown as Record<string, number>)) {
          filteredPay[key] = val * ratio;
        }
      }

      return {
        ...compareData,
        totalRevenue: timeRevenue,
        totalOrders: timeOrders,
        avgOrderValue: timeOrders > 0 ? timeRevenue / timeOrders : 0,
        hourlyBreakdown: filteredHourly,
        dailyHourly: filteredDailyHourly,
        guestBreakdown: filteredGuests,
        customerTypeSplit: filteredCTS,
        categoryBreakdown: filteredCats,
        paymentBreakdown: filteredPay,
        pureTicketRevenue: (compareData.pureTicketRevenue || 0) * (compareData.totalRevenue > 0 ? timeRevenue / compareData.totalRevenue : 0),
        discountTotal: (compareData.discountTotal || 0) * (compareData.totalRevenue > 0 ? timeRevenue / compareData.totalRevenue : 0),
      } as DashboardSummaryData;
    }

    return compareData;
  }, [compareData, compareWith, isLiveToday, forecastCompareData]);

  const effectiveCompareLabel = useMemo(() => {
    if (compareWith === "forecast") return "Model Forecast";
    if (compareWith === "stly") {
      if (isLiveToday && compareData && (compareData.totalRevenue || 0) > 0) {
        const bkk = getBangkokTime();
        const h12 = bkk.hour > 12 ? bkk.hour - 12 : bkk.hour === 0 ? 12 : bkk.hour;
        const ampm = bkk.hour >= 12 ? "PM" : "AM";
        const mm = String(bkk.minute).padStart(2, "0");
        return `STLY ${compareDates?.label || ""} (by ${h12}:${mm}${ampm})`;
      }
      return `STLY ${compareDates?.label || ""}`;
    }
    if (isLiveToday && compareWith !== "none" && compareData && (compareData.totalRevenue || 0) > 0) {
      const bkk = getBangkokTime();
      const h12 = bkk.hour > 12 ? bkk.hour - 12 : bkk.hour === 0 ? 12 : bkk.hour;
      const ampm = bkk.hour >= 12 ? "PM" : "AM";
      const mm = String(bkk.minute).padStart(2, "0");
      const suffix = ` (by ${h12}:${mm}${ampm})`;
      return compareLabel + suffix;
    }
    return compareLabel;
  }, [compareLabel, isLiveToday, compareWith, compareData]);

  const metrics: Partial<DashboardSummaryData> = activeData || {};
  const cashReportDailyTotals = activeData?.cashReportsDailyTotals || [];
  const cashReportTotal = cashReportDailyTotals.reduce(
    (s: number, d: { revenue: number }) => s + d.revenue,
    0,
  );

  const combinedRevenue = useMemo(() => {
    if (!activeData) return 0;
    if (isLiveToday) return activeData.totalRevenue || 0;
    const posDaily = activeData.dailyRevenue || [];
    const cashDaily = cashReportDailyTotals;
    if (posDaily.length === 0 && cashDaily.length === 0) return 0;

    const posDates = new Set(posDaily.map((d: any) => d.date));
    let total = activeData.totalRevenue || 0;
    for (const c of cashDaily) {
      if (!posDates.has((c as any).date)) {
        total += c.revenue;
      }
    }
    return total;
  }, [activeData, isLiveToday, cashReportDailyTotals]);

  const combinedRevenueSource = useMemo(() => {
    if (!activeData || isLiveToday) return "pos";
    const posDaily = activeData.dailyRevenue || [];
    const cashDaily = cashReportDailyTotals;
    const posDates = new Set(posDaily.map((d: any) => d.date));
    const hasCashOnly = cashDaily.some((c: any) => !posDates.has(c.date));
    if (posDaily.length > 0 && hasCashOnly) return "mixed";
    if (posDaily.length === 0 && cashDaily.length > 0) return "cash";
    return "pos";
  }, [activeData, isLiveToday, cashReportDailyTotals]);

  const hasData =
    activeData &&
    (activeData.totalOrders > 0 ||
      activeData.totalRevenue > 0 ||
      cashReportTotal > 0);
  const isConnected = isChalongOnly
    ? (todayData as any)?.papayaConnected ?? true
    : todayData?.funtopiaConnected ?? syncStatus?.funtopiaConnected;
  const isTodayTabLoading = !activeDataRaw && (isLiveToday
    ? todayFetching || todayLoading
    : periodFetching || periodLoading);
  const periodLabels: Record<TodayPeriod, string> = useMemo(() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const weekLabel = (() => {
      if (dateOffset === 0) return "This Week";
      if (dateOffset === -1) return "Last Week";
      const s = todayPeriodDates.start;
      const e = todayPeriodDates.end;
      const sd = new Date(s + "T12:00:00");
      const ed = new Date(e + "T12:00:00");
      return `${sd.getDate()} ${MONTH_LABELS[sd.getMonth()]} – ${ed.getDate()} ${MONTH_LABELS[ed.getMonth()]}`;
    })();
    const monthLabel = (() => {
      if (dateOffset === 0) return "This Month";
      if (dateOffset === -1) return "Last Month";
      const sd = new Date(todayPeriodDates.start + "T12:00:00");
      return MONTH_LABELS[sd.getMonth()];
    })();
    const todayLabel = (() => {
      if (dateOffset === 0) return "Today";
      const target = new Date(now);
      target.setDate(target.getDate() + dateOffset);
      return `${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]}`;
    })();
    const yesterdayLabel = (() => {
      if (dateOffset === 0) return "Yesterday";
      const target = new Date(now);
      target.setDate(target.getDate() - 1 + dateOffset);
      return `${DAY_NAMES[target.getDay()]}, ${target.getDate()} ${MONTH_LABELS[target.getMonth()]}`;
    })();
    return {
      today: todayLabel,
      yesterday: yesterdayLabel,
      week: weekLabel,
      month: monthLabel,
      custom: customDateRange
        ? customDateRange.to && customDateRange.from.getTime() !== customDateRange.to.getTime()
          ? `${customDateRange.from.getDate()} ${MONTH_LABELS[customDateRange.from.getMonth()]} – ${customDateRange.to.getDate()} ${MONTH_LABELS[customDateRange.to.getMonth()]}`
          : `${customDateRange.from.getDate()} ${MONTH_LABELS[customDateRange.from.getMonth()]}`
        : "Custom",
    };
  }, [dateOffset, todayPeriod, todayPeriodDates, customDateRange]);

  const getParentCreditFromCategories = (catBreakdown: Record<string, any> | undefined) => {
    if (!catBreakdown) return 0;
    const ticketsCat = catBreakdown["Tickets & Packages"];
    if (!ticketsCat?.items) return 0;
    return ticketsCat.items
      .filter((item: any) => {
        const n = (item.name || "").toLowerCase();
        return n.includes("parent") && n.includes("credit");
      })
      .reduce((sum: number, item: any) => sum + (item.revenue || 0), 0);
  };
  const floRestaVoucher = metrics.paymentBreakdown?.Voucher || 0;
  const parentCreditAmount = useMemo(() => {
    if (!hasChalong) return 0;
    return getParentCreditFromCategories(metrics.categoryBreakdown);
  }, [metrics.categoryBreakdown, hasChalong]);
  const voucherAmount = floRestaVoucher + parentCreditAmount;
  const bdTickets = hasFloresta
    ? Math.round(
        metrics.birthdayLinks?.bdTickets ??
          metrics.birthdayLinks?.partyPackageRevenue ??
          0,
      )
    : 0;
  const bdFnb = hasFloresta ? Math.round(metrics.birthdayLinks?.partyFnbRevenue || 0) : 0;
  const bdAmount = bdFnb;
  const bdShowAmount = bdFnb > 0;
  const showBdToggle = hasFloresta;
  const bdHasData = bdTickets > 0 || bdFnb > 0;
  const chalongBdShiftAmount = useMemo(() => {
    if (!hasChalong) return 0;
    const split = metrics.birthdayChannelSplit;
    if (!split) return 0;
    let total = 0;
    for (const v of Object.values(split)) {
      total += (v as { revenue?: number })?.revenue || 0;
    }
    return Math.round(total);
  }, [metrics.birthdayChannelSplit, hasChalong]);

  // task-111: Shared BD-shift plan. Default view ("BD→Bday", bdToFnb=false)
  // is the combined view — the server already ships with allocation="events"
  // (linked F&B merged into Events / Birthdays). Toggling ON ("BD→Tix/F&B")
  // splits the linked F&B back out of Events into F&B so the user can see
  // tickets/F&B as discrete buckets again. If a user's persisted preference
  // is still "fnb" (server returns F&B separated already), the default
  // combined view moves party-F&B from F&B into Events instead.
  const bdShiftPlan = useMemo(() => {
    if (!hasFloresta) return null;
    const partyFnb = metrics.birthdayLinks?.partyFnbRevenue || 0;
    if (partyFnb <= 0) return null;
    const allocationIsEvents = (metrics.birthdayMovedAmount || 0) > 0;
    if (bdToFnb) {
      // Split mode (BD→Tix/F&B): F&B must end up in F&B.
      if (allocationIsEvents) return { amount: partyFnb, from: "Events / Birthdays", to: "F&B" };
      return null;
    }
    // Combined mode (BD→Bday, default): F&B must end up in Events.
    if (!allocationIsEvents) return { amount: partyFnb, from: "F&B", to: "Events / Birthdays" };
    return null;
  }, [bdToFnb, hasFloresta, metrics.birthdayLinks?.partyFnbRevenue, metrics.birthdayMovedAmount]);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <div
        className="sticky top-0 z-40 bg-background/85 glass-header border-b border-border/40"
        data-testid="universal-bar"
      >
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2 space-y-2">
          <div className="relative flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 shrink-0">
              <img src={otoLogoFullPath} alt="OTO Radar" className="h-9 object-contain shrink-0 hidden sm:block max-w-[180px]" draggable={false} data-testid="text-funtopia-title" />
              <div className="flex bg-muted/40 rounded-full p-0.5 border border-border/30" data-testid="branch-toggle">
                {([
                  { mode: "floresta" as const, label: "Floresta", short: "FL" },
                  { mode: "chalong" as const, label: "Chalong", short: "CL" },
                ]).map(({ mode, label, short }) => {
                  const isActive = mode === "floresta" ? hasFloresta : hasChalong;
                  return (
                    <button
                      key={mode}
                      onClick={() => toggleBranch(mode)}
                      className={cn(
                        "px-3.5 sm:px-2.5 py-1.5 sm:py-1 text-[12px] sm:text-[11px] font-bold rounded-full transition-all duration-200 inline-flex items-center justify-center gap-1 whitespace-nowrap min-h-[36px] sm:min-h-0",
                        isActive
                          ? "bg-orange-500 text-white shadow-lg shadow-orange-500/30"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      )}
                      data-testid={`button-branch-${mode}`}
                    >
                      <MapPin className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
                      <span className="hidden sm:inline">{label}</span>
                      <span className="sm:hidden">{short}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none">
              <Link
                href="/redeem"
                className="pointer-events-auto hidden sm:inline-flex items-center justify-center gap-1.5 h-7 px-6 min-w-[150px] rounded-full bg-primary text-primary-foreground text-[11px] font-semibold shadow-sm hover:shadow-md hover:-translate-y-px transition-all"
                data-testid="header-link-redeem"
                title="Open Reception Redeem page"
              >
                <ScanLine className="h-3.5 w-3.5" />
                Redeem
              </Link>
              <Link
                href="/redeem"
                className="pointer-events-auto sm:hidden inline-flex items-center justify-center h-9 px-6 rounded-full bg-primary text-primary-foreground shadow-sm"
                data-testid="header-link-redeem-mobile"
                title="Open Reception Redeem page"
                aria-label="Redeem"
              >
                <ScanLine className="h-3.5 w-3.5" />
              </Link>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
                <SyncStatusToggle
                  isConnected={isConnected}
                  syncStatus={syncStatus}
                  papayaSyncStatus={papayaSyncStatus}
                  showFloresta={hasFloresta}
                  showChalong={hasChalong}
                  onSyncFloresta={hasFloresta ? () => doSync("quick") : undefined}
                  onSyncChalong={hasChalong ? () => doPapayaSync("quick") : undefined}
                  syncing={syncing || papayaSyncing}
                />
                <ThemeToggle />
                <SignOutButton />
              </div>
            </div>

            {/* Period selector row — full width, equal-width buttons */}
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={navigateBack}
                className="h-9 w-9 sm:h-8 sm:w-8 shrink-0"
                aria-label="Previous date"
                data-testid="button-navigate-back"
              >
                <ChevronLeft className="h-4 w-4 text-slate-600 dark:text-slate-300" />
              </Button>

              <div className="flex flex-1 min-w-0 bg-muted/40 rounded-full p-0.5 border border-border/30 gap-0.5">
                {(["today", "yesterday", "week", "month"] as TodayPeriod[]).map(
                  (p) => {
                    const desktopLabel = p === "week" ? "Week" : p === "month" ? "Month" : periodLabels[p];
                    const mobileLabel = dateOffset === 0
                      ? (p === "today" ? "Today" : p === "yesterday" ? "Yest" : p === "week" ? "Week" : "Month")
                      : desktopLabel;
                    return (
                      <button
                        key={p}
                        onClick={() => {
                          setTodayPeriod(p);
                          setDateOffset(0);
                          if (compareWith !== "none" && compareWith !== "custom") {
                            if (p === "month" && (compareWith === "yesterday" || compareWith === "same_period_last_week")) {
                              setCompareWith("same_period_last_month");
                            } else if (p === "week" && compareWith === "yesterday") {
                              setCompareWith("same_period_last_week");
                            }
                          }
                        }}
                        className={cn(
                          "flex-1 min-w-0 px-2 py-1.5 text-[12px] sm:text-xs font-semibold rounded-full transition-all duration-200 min-h-[34px] sm:min-h-[28px] inline-flex items-center justify-center truncate",
                          todayPeriod === p
                            ? "bg-orange-500 text-white shadow-sm shadow-orange-500/30"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                        )}
                        data-testid={`btn-period-${p}`}
                        aria-label={desktopLabel}
                      >
                        <span className="sm:hidden truncate">{mobileLabel}</span>
                        <span className="hidden sm:inline truncate">{desktopLabel}</span>
                      </button>
                    );
                  },
                )}
                <Popover
                  open={customPickerOpen}
                  onOpenChange={(open) => {
                    setCustomPickerOpen(open);
                    if (open) setCustomDraftRange(undefined);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      className={cn(
                        "shrink-0 px-3 py-1.5 text-[12px] sm:text-xs font-semibold rounded-full transition-all duration-200 min-h-[34px] sm:min-h-[28px] inline-flex items-center justify-center gap-1",
                        todayPeriod === "custom"
                          ? "bg-orange-500 text-white shadow-sm shadow-orange-500/30"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      )}
                      data-testid="btn-period-custom"
                      aria-label="Custom date range"
                    >
                      <CalendarDays className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{periodLabels.custom}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="end" sideOffset={8}>
                    <Calendar
                      mode="range"
                      selected={customDraftRange}
                      onSelect={(range) => {
                        setCustomDraftRange(range);
                        if (range?.from && range.to) {
                          const normalized = normalizeDashboardDateRange(range.from, range.to);
                          setCustomDateRange(normalized);
                          setTodayPeriod("custom");
                          setDateOffset(0);
                          setCustomPickerOpen(false);
                        }
                      }}
                      disabled={(date) => date > new Date()}
                      numberOfMonths={2}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={navigateForward}
                disabled={dateOffset >= 0}
                className="h-9 w-9 sm:h-8 sm:w-8 shrink-0"
                aria-label="Next date"
                data-testid="button-navigate-forward"
              >
                <ChevronRight className="h-4 w-4 text-slate-600 dark:text-slate-300" />
              </Button>

              {dateOffset !== 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetToToday}
                  className="h-8 px-2 text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 font-semibold shrink-0"
                  data-testid="btn-reset-today"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Now
                </Button>
              )}
            </div>

            {/* Date label + modifiers row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div
                className="text-xs text-muted-foreground font-medium flex items-center gap-2 flex-wrap min-w-0"
                data-testid="text-period-label"
              >
                <span className="truncate">{todayPeriodDates.label}</span>
                {todayPeriod === "today" &&
                  (() => {
                    const holidays = getAllHolidaysForDate(todayPeriodDates.start);
                    if (holidays.length === 0) return null;
                    return (
                      <>
                        {holidays.map((h, i) => {
                          const hc = HOLIDAY_COLORS[h.type];
                          return (
                            <span
                              key={i}
                              className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium",
                                hc.text, hc.bg,
                              )}
                              data-testid={`badge-holiday-${i}`}
                            >
                              <CalendarHeart className="h-3 w-3" />
                              {h.name}
                            </span>
                          );
                        })}
                      </>
                    );
                  })()}
              </div>

              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar tab-bar-fade -mx-1 px-1 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible justify-center sm:justify-end w-full sm:w-auto">
                {hasFloresta && isLiveToday && todayData?.guestBreakdown && ((todayData.guestBreakdown as any).totalInPark > 0 || (todayData.guestBreakdown as any).ongoingTotal > 0) && (
                  <InParkPill guestBreakdown={todayData.guestBreakdown} />
                )}
                <Popover open={compareDropdownOpen} onOpenChange={setCompareDropdownOpen}>
                  <PopoverTrigger asChild>
                    <button
                      className={cn(
                        "text-[12px] sm:text-[10px] h-8 sm:h-6 px-3 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center gap-1.5 sm:gap-1 shrink-0",
                        compareWith === "forecast"
                          ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                          : compareWith === "stly"
                            ? "bg-cyan-600 text-white border-cyan-600 shadow-sm"
                            : compareWith !== "none"
                              ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                              : "bg-violet-600/10 text-violet-500 dark:text-violet-400 border-violet-500/30 hover:bg-violet-600/20",
                      )}
                      data-testid="btn-compare-toggle"
                    >
                      <BarChartLucide className="h-3 w-3" />
                      {compareWith !== "none" ? `vs ${effectiveCompareLabel}` : "Compare"}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-1.5" align="end" sideOffset={8}>
                    <div className="space-y-0.5">
                      {(() => {
                        const opts: Array<{ key: CompareOption; label: string }> = [
                          { key: "none", label: "Off" },
                        ];
                        if (todayPeriod === "today" || todayPeriod === "yesterday") {
                          opts.push(
                            { key: "yesterday", label: "Previous Day" },
                            { key: "same_period_last_week", label: "Same Day Last Week" },
                            { key: "same_period_last_month", label: "Same Day Last Month" },
                            { key: "same_period_last_year", label: "Same Day Last Year" },
                          );
                        } else if (todayPeriod === "week") {
                          opts.push(
                            { key: "same_period_last_week", label: "Previous Week" },
                            { key: "same_period_last_month", label: "Same Week Last Month" },
                            { key: "same_period_last_year", label: "Same Week Last Year" },
                          );
                        } else if (todayPeriod === "month") {
                          opts.push(
                            { key: "same_period_last_month", label: "Previous Month" },
                            { key: "same_period_last_year", label: "Same Month Last Year" },
                          );
                        } else {
                          opts.push(
                            { key: "yesterday", label: "Yesterday" },
                            { key: "same_period_last_week", label: "Same Period Last Week" },
                            { key: "same_period_last_month", label: "Same Period Last Month" },
                            { key: "same_period_last_year", label: "Same Period Last Year" },
                          );
                        }
                        if (!isChalongOnly) {
                          opts.push({ key: "forecast", label: "📊 vs Model Forecast" });
                        }
                        if (hasChalong) {
                          opts.push({ key: "stly", label: "📈 vs Same Time Last Year" });
                        }
                        return opts;
                      })().flatMap((opt) => {
                        const items = [];
                        if (opt.key === "forecast" || (opt.key === "stly" && isChalongOnly)) {
                          items.push(<div key={`${opt.key}-sep`} className="border-t border-border my-1" />);
                        }
                        items.push(
                          <button
                            key={opt.key}
                            onClick={() => {
                              setCompareWith(opt.key);
                              setCompareDropdownOpen(false);
                            }}
                            className={cn(
                              "w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors",
                              compareWith === opt.key
                                ? opt.key === "forecast"
                                  ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium"
                                  : opt.key === "stly"
                                  ? "bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 font-medium"
                                  : "bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium"
                                : "hover:bg-muted text-foreground/80",
                            )}
                            data-testid={`btn-compare-option-${opt.key}`}
                          >
                            {opt.label}
                          </button>
                        );
                        return items;
                      })}
                      <Popover open={comparePickerOpen} onOpenChange={setComparePickerOpen}>
                        <PopoverTrigger asChild>
                          <button
                            className={cn(
                              "w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors flex items-center gap-1.5",
                              compareWith === "custom"
                                ? "bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium"
                                : "hover:bg-muted text-foreground/80",
                            )}
                            data-testid="btn-compare-option-custom"
                          >
                            <CalendarDays className="h-3 w-3" />
                            {compareWith === "custom" && compareCustomRange
                              ? compareCustomRange.to && compareCustomRange.from.getTime() !== compareCustomRange.to.getTime()
                                ? `${compareCustomRange.from.getDate()} ${MONTH_LABELS[compareCustomRange.from.getMonth()]} – ${compareCustomRange.to.getDate()} ${MONTH_LABELS[compareCustomRange.to.getMonth()]}`
                                : `${compareCustomRange.from.getDate()} ${MONTH_LABELS[compareCustomRange.from.getMonth()]}`
                              : "Custom Period..."}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="end" side="left" sideOffset={8}>
                          <Calendar
                            mode="range"
                            selected={compareCustomRange ? { from: compareCustomRange.from, to: compareCustomRange.to } : undefined}
                            onSelect={(range) => {
                              if (range?.from) {
                                setCompareCustomRange({ from: range.from, to: range.to });
                                setCompareWith("custom");
                                if (range.to) {
                                  setComparePickerOpen(false);
                                  setCompareDropdownOpen(false);
                                }
                              }
                            }}
                            disabled={(date) => date > new Date()}
                            numberOfMonths={2}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </PopoverContent>
                </Popover>
                {(voucherAmount > 0 || showBdToggle || hasChalong) && (
                  <div className="inline-flex items-center gap-1.5 shrink-0">
                    {(voucherAmount > 0 || hasChalong) && (
                      <button
                        onClick={() => setVouchersToFnb((v) => !v)}
                        className={cn(
                          "text-[12px] sm:text-[10px] h-8 sm:h-6 px-3 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center shrink-0",
                          vouchersToFnb
                            ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                            : "bg-blue-600/10 text-blue-400 border-blue-500/30 hover:bg-blue-600/20",
                        )}
                        data-testid="btn-voucher-toggle"
                        aria-label={
                          voucherAmount > 0
                            ? `${vouchersToFnb ? "A to F&B" : "A to Tickets"} ${voucherAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} baht`
                            : `${vouchersToFnb ? "A to F&B" : "A to Tickets"} (no amount in this period)`
                        }
                      >
                        <span className="sm:hidden">
                          {vouchersToFnb ? "A→F&B" : "A→Tix"}{voucherAmount > 0 ? ` ฿${voucherAmount >= 1000 ? `${Math.round(voucherAmount / 100) / 10}k` : voucherAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                        <span className="hidden sm:inline">
                          {vouchersToFnb ? "A→F&B" : "A→Tickets"}{voucherAmount > 0 ? ` ฿${voucherAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                      </button>
                    )}
                    {showBdToggle && hasChalong && (() => {
                      const chalongPrefLoading = chalongBdSplitLocal === null && !chalongAllocationPref;
                      const mixed = chalongPrefLoading || bdToFnb !== chalongBdSplit;
                      const combinedSplit = !mixed && bdToFnb;
                      const combinedAmount = bdAmount + chalongBdShiftAmount;
                      const combinedShowAmount = combinedAmount > 0;
                      const combinedHasData = bdHasData || chalongBdShiftAmount > 0;
                      const formatAmt = (n: number) =>
                        n >= 1000
                          ? `${Math.round(n / 100) / 10}k`
                          : n.toLocaleString(undefined, { maximumFractionDigits: 0 });
                      return (
                        <button
                          onClick={() => {
                            // If states disagree, force both to split (default).
                            // Otherwise flip both together.
                            const next = mixed ? true : !bdToFnb;
                            setBdToFnb(next);
                            setChalongBdSplitLocal(next);
                            chalongAllocationMutation.mutate(next);
                          }}
                          disabled={!combinedHasData && !mixed}
                          className={cn(
                            "text-[12px] sm:text-[10px] h-8 sm:h-6 px-3 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center shrink-0",
                            mixed
                              ? "bg-muted/40 text-muted-foreground border-border/60"
                              : !combinedHasData
                                ? "bg-muted/30 text-muted-foreground border-border/50 cursor-default opacity-70"
                                : combinedSplit
                                  ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                                  : "bg-blue-600/10 text-blue-400 border-blue-500/30 hover:bg-blue-600/20",
                          )}
                          data-testid="btn-bd-toggle-combined"
                          aria-label={
                            mixed
                              ? "BD allocation (mixed across branches) — click to align both to split"
                              : `BD allocation (both branches): ${combinedSplit ? "split into tickets and F and B" : "combined as Birthdays"}${combinedShowAmount ? `, shifts ${combinedAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} baht` : ""}`
                          }
                          title={
                            mixed
                              ? "Floresta and Chalong are out of sync — click to align both"
                              : combinedSplit
                                ? "Birthday revenue routed to Tickets / F&B for both branches"
                                : "Birthday revenue rolled up under Events / Birthdays for both branches"
                          }
                        >
                          <span className="sm:hidden">
                            {mixed ? "BD→…" : combinedSplit ? "BD→Tix/F&B" : "BD→Bday"}{combinedShowAmount ? ` ฿${formatAmt(combinedAmount)}` : ""}
                          </span>
                          <span className="hidden sm:inline">
                            {mixed ? "BD→…" : combinedSplit ? "BD→Tix/F&B" : "BD→Bday"}{combinedShowAmount ? ` ฿${combinedAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                          </span>
                        </button>
                      );
                    })()}
                    {showBdToggle && !hasChalong && (
                      <button
                        onClick={() => bdHasData && setBdToFnb((v) => !v)}
                        disabled={!bdHasData}
                        className={cn(
                          "text-[12px] sm:text-[10px] h-8 sm:h-6 px-3 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center shrink-0",
                          !bdHasData
                            ? "bg-muted/30 text-muted-foreground border-border/50 cursor-default opacity-70"
                            : bdToFnb
                              ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                              : "bg-blue-600/10 text-blue-400 border-blue-500/30 hover:bg-blue-600/20",
                        )}
                        data-testid="btn-bd-toggle"
                        aria-label={`${bdToFnb ? "BD split into tickets and F and B" : "BD combined as Birthdays"}${bdShowAmount ? `, linked party F and B that shifts between Events and F and B: ${bdAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} baht` : ""}`}
                      >
                        <span className="sm:hidden">
                          {bdToFnb ? "BD→Tix/F&B" : "BD→Bday"}{bdShowAmount ? ` ฿${bdAmount >= 1000 ? `${Math.round(bdAmount / 100) / 10}k` : bdAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                        <span className="hidden sm:inline">
                          {bdToFnb ? "BD→Tix/F&B" : "BD→Bday"}{bdShowAmount ? ` ฿${bdAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                      </button>
                    )}
                    {hasChalong && !showBdToggle && (
                      <button
                        onClick={() => {
                          const next = !chalongBdSplit;
                          // Flip the view instantly; mutation only persists
                          // the preference, no refetch is triggered.
                          setChalongBdSplitLocal(next);
                          chalongAllocationMutation.mutate(next);
                        }}
                        className={cn(
                          "text-[12px] sm:text-[10px] h-8 sm:h-6 px-3 sm:px-2.5 rounded-full transition-all duration-200 font-semibold sm:font-medium border whitespace-nowrap inline-flex items-center justify-center shrink-0",
                          chalongBdSplit
                            ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                            : "bg-blue-600/10 text-blue-400 border-blue-500/30 hover:bg-blue-600/20",
                        )}
                        data-testid="btn-bd-toggle-chalong"
                        aria-label={
                          chalongBdShiftAmount > 0
                            ? `Chalong BD allocation: ${chalongBdSplit ? "split to natural categories" : "all under Events / Birthdays"} — shifts ${chalongBdShiftAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} baht between Events / Birthdays and natural categories`
                            : `Chalong BD allocation: ${chalongBdSplit ? "split to natural categories" : "all under Events / Birthdays"} (no birthday-channel revenue in this period)`
                        }
                        title={
                          chalongBdSplit
                            ? "Birthday-channel line items routed to Tickets / F&B / Socks / etc."
                            : "All birthday-channel revenue rolled up under Events / Birthdays"
                        }
                      >
                        <span className="sm:hidden">
                          {chalongBdSplit ? "BD→Tix/F&B" : "BD→Bday"}{chalongBdShiftAmount > 0 ? ` ฿${chalongBdShiftAmount >= 1000 ? `${Math.round(chalongBdShiftAmount / 100) / 10}k` : chalongBdShiftAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                        <span className="hidden sm:inline">
                          {chalongBdSplit ? "BD→Tix/F&B" : "BD→Bday"}{chalongBdShiftAmount > 0 ? ` ฿${chalongBdShiftAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}
                        </span>
                      </button>
                    )}
                  </div>
                )}
                {compareWith !== "none" && (
                  <button
                    onClick={() => setCompDeltaMode(compDeltaMode === "pct" ? "abs" : "pct")}
                    className={cn(
                      "text-[14px] sm:text-[10px] font-bold sm:font-medium h-8 w-8 sm:h-6 sm:w-auto sm:px-2 rounded-full transition-all duration-200 border whitespace-nowrap inline-flex items-center justify-center shrink-0",
                      "bg-violet-600/10 text-violet-500 dark:text-violet-400 border-violet-500/30 hover:bg-violet-600/20",
                    )}
                    data-testid="btn-delta-mode"
                  >
                    {compDeltaMode === "pct" ? "%" : "#"}
                  </button>
                )}
              </div>
            </div>
          </div>

        {syncMessage && (
          <div
            className={cn(
              "border-t",
              syncMessage.startsWith("⚠")
                ? "bg-amber-50 dark:bg-amber-950/30"
                : "bg-blue-50 dark:bg-blue-950/30"
            )}
            data-testid="sync-progress-bar"
          >
            <div className={cn(
              "max-w-6xl mx-auto px-4 py-2 text-sm space-y-1",
              syncMessage.startsWith("⚠")
                ? "text-amber-700 dark:text-amber-300"
                : "text-blue-700 dark:text-blue-300"
            )}>
              <div className="flex items-center gap-2">
                {syncing && (
                  <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                )}
                <span className="flex-1">{syncMessage}</span>
              </div>
              {syncing && syncTotalDays > 0 && (
                <div className="space-y-1">
                  <div className="w-full bg-blue-200 dark:bg-blue-900 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-600 dark:bg-blue-400 h-2 rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, Math.round((syncSyncedDays / syncTotalDays) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-blue-600/70 dark:text-blue-400/70">
                    <span>
                      {syncSyncedDays} of {syncTotalDays} days (
                      {Math.round((syncSyncedDays / syncTotalDays) * 100)}%)
                    </span>
                    {syncEta && <span>{syncEta}</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-2 sm:px-4">
        <div ref={tabBarScrollRef} className="flex sm:justify-center pt-3 pb-1 overflow-x-auto no-scrollbar tab-bar-fade" data-testid="nav-tabs">
          <TabsList className="h-9 bg-muted/60 dark:bg-muted/30 rounded-full p-1 inline-flex mx-auto sm:mx-0">
            <TabsTrigger
              value="today"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-today"
            >
              Dashboard
            </TabsTrigger>
            <TabsTrigger
              value="calendar"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-calendar"
            >
              Calendar
            </TabsTrigger>
            <TabsTrigger
              value="trends"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-trends"
            >
              Trends
            </TabsTrigger>
            <TabsTrigger
              value="events"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-events"
            >
              Events
            </TabsTrigger>
            <TabsTrigger
              value="campaigns"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-campaigns"
            >
              Campaigns
            </TabsTrigger>
            <TabsTrigger
              value="accounting"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-accounting"
            >
              Accounting
            </TabsTrigger>
            <TabsTrigger
              value="config"
              className="text-[13px] sm:text-xs rounded-full px-3.5 sm:px-4 min-h-[36px] sm:min-h-[28px] data-[state=active]:shadow-sm whitespace-nowrap"
              data-testid="tab-config"
            >
              Config
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      {posStalenessAlerts.length > 0 && (
        <div className="max-w-6xl mx-auto px-2 sm:px-4 pt-3 space-y-2" data-testid="pos-staleness-banners">
          {posStalenessAlerts.map((a) => (
            <div
              key={a.branch}
              className="flex items-start gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2.5 sm:px-4"
              data-testid={`pos-staleness-banner-${a.branch}`}
            >
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-red-800 dark:text-red-300">
                  {a.message}
                </div>
                <div className="text-xs text-red-700/80 dark:text-red-400/80 mt-0.5">
                  Today's revenue may be under-reported. Check the {a.branchLabel} POS terminal and its internet connection.
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {sourceGapAlerts.length > 0 && (
        <details className="max-w-6xl mx-auto px-2 sm:px-4 pt-3" data-testid="source-gap-banners">
          <summary className="cursor-pointer rounded-lg border border-amber-300/60 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 focus-visible:outline focus-visible:outline-2">
            Sales-source activity: {sourceGapAlerts.length} {sourceGapAlerts.length === 1 ? "source needs" : "sources need"} review
            <span className="ml-2 text-xs opacity-75">View details</span>
          </summary>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            These are activity notices, not confirmed POS failures. A source may be inactive or its attribution may need checking.
          </p>
          {sourceGapAlerts.map((a) => (
            <div
              key={a.source}
              className="flex items-start gap-3"
              data-testid={`source-gap-banner-${a.source.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  {a.source} has recorded 0 orders for {a.consecutiveZeroDays}+ days
                  {a.lastSeenDate ? ` (last seen ${a.lastSeenDate})` : ""}
                </div>
                <div className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">
                  This source normally generates orders on {a.activeDaysInWindow} of the last {a.windowDays} days.
                  Check the Revenue by Source card and confirm whether this source is still in use.
                </div>
              </div>
            </div>
          ))}
          </div>
        </details>
      )}

      <div className="max-w-6xl mx-auto px-2 sm:px-4 py-3">
        <TabsContent value="today" className="space-y-3 sm:space-y-4 mt-0">
          {isTodayTabLoading ? (
            <div className="space-y-3 sm:space-y-4 animate-fade-in">
              <div className="flex items-center justify-center gap-2 py-6">
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading analytics...</span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
                <MetricCardSkeleton />
                <MetricCardSkeleton />
                <MetricCardSkeleton />
                <MetricCardSkeleton />
              </div>
            </div>
          ) : !hasData ? (
            <div className="neu-card p-8 text-center">
              {activeData && (activeData.funtopiaConnected || activeData.papayaConnected) && (
                (hasFloresta && syncStatus?.lastSyncedDate === (activeData.date || getBangkokToday())) ||
                (hasChalong && papayaSyncStatus?.latestDate && papayaSyncStatus.latestDate >= (activeData.date || getBangkokToday()))
              ) ? (
                <>
                  <img src={otoLoadingPath} alt="OTO" className="h-16 w-16 mx-auto mb-3 opacity-60" draggable={false} />
                  <p className="text-muted-foreground mb-1 text-sm font-medium">
                    No orders yet {todayPeriod === "today" ? "today" : "for this period"}
                  </p>
                  <p className="text-muted-foreground/60 mb-3 text-xs">
                    Data is synced and up to date. New orders will appear automatically.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (hasFloresta) doSync("quick");
                      if (hasChalong) doPapayaSync("quick");
                    }}
                    disabled={syncing || papayaSyncing}
                    size="sm"
                    data-testid="btn-sync-empty"
                  >
                    <RefreshCw
                      className={`h-4 w-4 mr-2 ${(syncing || papayaSyncing) ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </Button>
                </>
              ) : (
                <>
                  <RefreshCw className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground mb-3 text-sm">
                    {(hasFloresta && syncStatus?.cachedDates > 0) || (hasChalong && papayaSyncStatus?.cachedDates > 0)
                      ? "Tap Quick Sync to load the latest data."
                      : 'Go to "Config" tab and press "Sync Now" to fetch POS data.'}
                  </p>
                  <Button
                    onClick={() => {
                      if (hasFloresta) doSync("quick");
                      if (hasChalong) doPapayaSync("quick");
                    }}
                    disabled={syncing || papayaSyncing}
                    size="sm"
                    data-testid="btn-sync-empty"
                  >
                    <RefreshCw
                      className={`h-4 w-4 mr-2 ${(syncing || papayaSyncing) ? "animate-spin" : ""}`}
                    />
                    Quick Sync
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <div className="relative">
                  <MetricCard
                    title={`${periodLabels[todayPeriod]} Revenue`}
                    value={`฿${Number(combinedRevenue).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                    subtitle={
                      combinedRevenueSource === "mixed"
                        ? "POS net sales + cash reports"
                        : combinedRevenueSource === "cash"
                          ? "From cash reports"
                          : "POS net sales (cash basis)"
                    }
                    annotation={
                      (() => {
                        const parts: string[] = [];
                        if (voucherAmount > 0) {
                          parts.push(`Excl. ฿${voucherAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} voucher payments`);
                        }
                        if (combinedRevenueSource === "mixed") {
                          const posDaily = activeData?.dailyRevenue || [];
                          const cashOnly = cashReportDailyTotals.filter((c: any) => !new Set(posDaily.map((d: any) => d.date)).has(c.date));
                          parts.push(`POS: ${posDaily.length}d + Cash reports: ${cashOnly.length}d`);
                        }
                        return parts.length > 0 ? parts.join("\n") : undefined;
                      })()
                    }
                    icon={OtoCurrency}
                    color="green"
                    className="animate-slide-up stagger-1"
                    comparison={compareWith !== "none" && effectiveCompareData ? {
                      currValue: combinedRevenue,
                      prevValue: effectiveCompareData.totalRevenue || 0,
                      label: effectiveCompareLabel,
                      format: "baht" as const,
                    } : null}
                    deltaMode={compDeltaMode}
                  />
                  {(hasFloresta || hasChalong) && syncHealthStatus && (
                    <div className="absolute top-1.5 right-1.5 z-10" data-testid="sync-health-indicator">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 cursor-pointer transition-colors ${
                              syncHealthStatus.accuracyColor === "green"
                                ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
                                : syncHealthStatus.accuracyColor === "orange"
                                ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/60"
                                : "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60"
                            }`}
                            data-testid="btn-sync-health-badge"
                          >
                            {syncHealthStatus.allClean ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                            <span className="text-[9px] font-bold">{syncHealthStatus.accuracy}%</span>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80 p-3" align="end">
                          <div className="space-y-2">
                            {syncHealthStatus.allClean ? (
                              <>
                                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                                  <ShieldCheck className="h-4 w-4" />
                                  Sync Health — {syncHealthStatus.accuracy}%
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  All data synced successfully. {syncHealthStatus.records.length > 0 && `${syncHealthStatus.records.reduce((s, r) => s + (r.ordersReceived || 0), 0)} orders received across ${syncHealthStatus.records.length} sync(s).`}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className={`flex items-center gap-2 text-sm font-semibold ${
                                  syncHealthStatus.accuracyColor === "orange"
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-red-600 dark:text-red-400"
                                }`}>
                                  <AlertTriangle className="h-4 w-4" />
                                  Sync Issues — {syncHealthStatus.accuracy}%
                                </div>
                                {syncHealthStatus.issues.length === 0 && syncHealthStatus.accuracy < 100 && (
                                  <div className="space-y-2">
                                    <div className="text-xs text-muted-foreground p-2 rounded bg-muted/50">
                                      Got {syncHealthStatus.totalReceived}/{syncHealthStatus.totalExpected} orders — {Math.round((1 - syncHealthStatus.totalReceived / syncHealthStatus.totalExpected) * 100)}% missing
                                    </div>
                                    <div className="flex gap-2">
                                      {hasFloresta && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="flex-1 h-7 text-[10px]"
                                          onClick={() => {
                                            const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
                                            resyncMutation.mutate(today);
                                          }}
                                          disabled={resyncMutation.isPending}
                                          data-testid="btn-resync-floresta-shortfall"
                                        >
                                          {resyncMutation.isPending ? (
                                            <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Re-syncing...</>
                                          ) : (
                                            <><RotateCcw className="h-3 w-3 mr-1" /> {hasChalong ? "Re-sync Floresta" : "Re-sync"}</>
                                          )}
                                        </Button>
                                      )}
                                      {hasChalong && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="flex-1 h-7 text-[10px]"
                                          onClick={() => {
                                            const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
                                            papayaResyncMutation.mutate(today);
                                          }}
                                          disabled={papayaResyncMutation.isPending}
                                          data-testid="btn-resync-chalong-shortfall"
                                        >
                                          {papayaResyncMutation.isPending ? (
                                            <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Re-syncing...</>
                                          ) : (
                                            <><RotateCcw className="h-3 w-3 mr-1" /> {hasFloresta ? "Re-sync Chalong" : "Re-sync"}</>
                                          )}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                )}
                                {syncHealthStatus.issues.length > 0 && (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                  {syncHealthStatus.issues.map((issue: BranchSyncIssue) => {
                                    const isFlorestaIssue = issue.branch === "floresta";
                                    const isPapayaIssue = issue.branch === "chalong";
                                    const hasBoth = hasFloresta && hasChalong;
                                    const mutation = isPapayaIssue ? papayaResyncMutation : resyncMutation;
                                    return (
                                      <div key={`${issue.branch}-${issue.date}`} className="text-xs space-y-1 p-2 rounded bg-muted/50">
                                        <div className="flex items-center justify-between">
                                          <span className="font-medium">
                                            {hasBoth && (
                                              <span className={`mr-1 px-1 py-0.5 rounded text-[8px] font-bold ${isFlorestaIssue ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400" : "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400"}`}>
                                                {isFlorestaIssue ? "Floresta" : "Chalong"}
                                              </span>
                                            )}
                                            {issue.date}
                                          </span>
                                          <Badge variant="destructive" className="text-[9px]" data-testid={`badge-sync-status-${issue.branch}-${issue.date}`}>
                                            {issue.status.toUpperCase()}
                                          </Badge>
                                        </div>
                                        {issue.status === "partial" && issue.ordersExpected > 0 && issue.ordersReceived < issue.ordersExpected && (
                                          <div className="text-muted-foreground">
                                            Got {issue.ordersReceived}/{issue.ordersExpected} orders — {Math.round((1 - issue.ordersReceived / issue.ordersExpected) * 100)}% missing
                                          </div>
                                        )}
                                        {issue.status === "divergence" && issue.revenueDivergence && (
                                          <div className="text-muted-foreground" data-testid={`text-revenue-divergence-${issue.branch}-${issue.date}`}>
                                            Cached ฿{issue.revenueDivergence.cached.toLocaleString(undefined, { maximumFractionDigits: 0 })} vs Pisell ฿{issue.revenueDivergence.fresh.toLocaleString(undefined, { maximumFractionDigits: 0 })} — diff {issue.revenueDivergence.diff >= 0 ? "+" : ""}฿{issue.revenueDivergence.diff.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                          </div>
                                        )}
                                        {issue.errorMessage && (
                                          <div className="text-muted-foreground">{issue.errorMessage}</div>
                                        )}
                                        {issue.warnings && issue.warnings.length > 0 && (
                                          <div className="text-muted-foreground">{issue.warnings.join("; ")}</div>
                                        )}
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="w-full mt-1 h-6 text-[10px]"
                                          onClick={() => mutation.mutate(issue.date)}
                                          disabled={mutation.isPending}
                                          data-testid={`btn-resync-${issue.branch}-${issue.date}`}
                                        >
                                          {mutation.isPending ? (
                                            <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Re-syncing...</>
                                          ) : (
                                            <><RotateCcw className="h-3 w-3 mr-1" /> Re-sync this date</>
                                          )}
                                        </Button>
                                      </div>
                                    );
                                  })}
                                </div>
                                )}
                              </>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                </div>
                <MetricCard
                  title="Avg. Order Value"
                  value={`฿${Number(
                    metrics.totalOrders > 0 && metrics.totalRevenue > 0
                      ? metrics.totalRevenue / metrics.totalOrders
                      : metrics.avgOrderValue || 0,
                  ).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  subtitle="Per transaction"
                  icon={OtoPlayCoin}
                  color="orange"
                  className="animate-slide-up stagger-4"
                  comparison={compareWith !== "none" && effectiveCompareData ? {
                    currValue: metrics.totalOrders > 0 && metrics.totalRevenue > 0
                      ? metrics.totalRevenue / metrics.totalOrders
                      : metrics.avgOrderValue || 0,
                    prevValue: effectiveCompareData.totalOrders > 0
                      ? (effectiveCompareData.totalRevenue || 0) / effectiveCompareData.totalOrders
                      : effectiveCompareData.avgOrderValue || 0,
                    label: effectiveCompareLabel,
                    format: "baht" as const,
                  } : null}
                  deltaMode={compDeltaMode}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-slide-up stagger-5">
                {metrics.guestBreakdown && (
                  <CollapsibleCard
                    title="Guest Overview"
                    icon={OtoHeadcount}
                    defaultOpen={true}
                  >
                    <GuestBreakdownCard
                      data={metrics.guestBreakdown}
                      embedded={true}
                      customerTypeSplit={metrics.customerTypeSplit}
                      onGraphFilter={setGraphFilter}
                      compData={compareWith !== "none" ? effectiveCompareData?.guestBreakdown ?? null : null}
                      compCustomerTypes={compareWith !== "none" ? effectiveCompareData?.customerTypeSplit : undefined}
                      compLabel={compareWith !== "none" ? effectiveCompareLabel : undefined}
                      voucherAmount={voucherAmount}
                      vouchersToFnb={vouchersToFnb}
                      deltaMode={compDeltaMode}
                    />
                  </CollapsibleCard>
                )}

                <CollapsibleCard
                  title="Revenue by Category"
                  icon={OtoCurrency}
                  defaultOpen={true}
                  subtitle={voucherAmount > 0 ? `฿${voucherAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} paid via vouchers` : undefined}
                >
                  <CategoryRevenueBreakdown
                    data={metrics.categoryBreakdown || {}}
                    voucherMode={vouchersToFnb ? "fnb" : "tickets"}
                    voucherAmount={voucherAmount}
                    bdShift={bdShiftPlan}
                    onGraphFilter={setGraphFilter}
                    compData={compareWith !== "none" ? effectiveCompareData?.categoryBreakdown ?? null : null}
                    compLabel={compareWith !== "none" ? effectiveCompareLabel : undefined}
                    compVoucherAmount={(effectiveCompareData?.paymentBreakdown?.Voucher || 0) + (hasChalong ? getParentCreditFromCategories(effectiveCompareData?.categoryBreakdown) : 0)}
                    deltaMode={compDeltaMode}
                    birthdayLinks={hasFloresta ? metrics.birthdayLinks ?? null : null}
                    birthdayMovedAmount={hasFloresta ? metrics.birthdayMovedAmount ?? 0 : 0}
                    branchKey={Array.from(activeBranches).sort().join("+") || "floresta"}
                  />
                </CollapsibleCard>
              </div>

              {hasFloresta && (() => {
                const sourceData: SourceBreakdownEntry[] = metrics.sourceBreakdown || [];
                const compTyped = effectiveCompareData as Partial<DashboardSummaryData> | null;
                const compSourceData: SourceBreakdownEntry[] | null = compareWith !== "none"
                  ? (compTyped?.sourceBreakdown || [])
                  : null;
                return (
                  <CollapsibleCard
                    title="Ticket Revenue by Source"
                    icon={OtoCurrency}
                    defaultOpen={false}
                    subtitle="Ticket revenue attributed by voucher channel (Floresta)"
                  >
                    <SourceRevenueBreakdown
                      data={sourceData}
                      compData={compSourceData}
                      deltaMode={compDeltaMode}
                    />
                  </CollapsibleCard>
                );
              })()}

              {(() => {
                let heatmapData = metrics.dailyHourly;
                if ((todayPeriod === "today" || todayPeriod === "yesterday") &&
                    metrics.hourlyBreakdown && metrics.hourlyBreakdown.length > 0) {
                  heatmapData = [{
                    date: metrics.date || getBangkokToday(),
                    hourlyBreakdown: metrics.hourlyBreakdown,
                  }];
                }
                let compHeatmap: DailyHourlyData[] | undefined;
                if (compareWith !== "none" && effectiveCompareData) {
                  if (todayPeriod === "today" || todayPeriod === "yesterday") {
                    const compHourly = effectiveCompareData.hourlyBreakdown || [];
                    const compDH = effectiveCompareData.dailyHourly || [];
                    const compDate = effectiveCompareData.date
                      || (compDH.length > 0 ? compDH[0].date : "")
                      || compareDates?.start || "";
                    if (compHourly.length > 0) {
                      compHeatmap = [{
                        date: compDate,
                        hourlyBreakdown: compHourly,
                      }];
                    } else if (compDH.length > 0) {
                      compHeatmap = compDH;
                    }
                  } else {
                    compHeatmap = effectiveCompareData.dailyHourly;
                  }
                }
                heatmapData = fillActivityDateRange(
                  heatmapData || [],
                  todayPeriodDates.start,
                  todayPeriodDates.end,
                ) as NonNullable<DashboardSummaryData["dailyHourly"]>;
                if (compHeatmap && compareDates) {
                  compHeatmap = fillActivityDateRange(
                    compHeatmap,
                    compareDates.start,
                    compareDates.end,
                  ) as DailyHourlyData[];
                }
                if (isChalongOnly && !includeSummerCamp) {
                  heatmapData = excludeSummerCamp(heatmapData || []) as NonNullable<DashboardSummaryData["dailyHourly"]>;
                  compHeatmap = excludeSummerCamp(compHeatmap || []) as DailyHourlyData[];
                }
                if (!includeWeekends) {
                  heatmapData = excludeWeekends(heatmapData || []) as NonNullable<DashboardSummaryData["dailyHourly"]>;
                  compHeatmap = excludeWeekends(compHeatmap || []) as DailyHourlyData[];
                }
                const heatmapMetricLabels: Record<HeatmapMetric, string> = { orders: "Orders", revenue: "Revenue", ticketsSold: "Tickets" };
                const heatmapBranchStatus = getActivityBranchStatus(hasFloresta, hasChalong);
                return heatmapData.length > 0 ? (
                  <CollapsibleCard
                    title={`Activity Heatmap — ${periodLabels[todayPeriod]}`}
                    icon={Activity}
                    defaultOpen={false}
                    subtitle={heatmapBranchStatus}
                    headerExtras={
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          className="h-7 rounded-md border border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            setIncludeWeekends((current) => !current);
                          }}
                          data-testid="btn-toggle-weekends"
                        >
                          {includeWeekends ? "Exclude Weekends" : "Include Weekends"}
                        </button>
                        {isChalongOnly && (
                          <button
                            type="button"
                            className="h-7 rounded-md border border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-muted"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIncludeSummerCamp((current) => !current);
                            }}
                            data-testid="btn-toggle-summer-camp"
                          >
                            {includeSummerCamp ? "Exclude Summer Camp" : "Include Summer Camp"}
                          </button>
                        )}
                        <div className="dash-segmented" role="tablist" aria-label="Heatmap metric">
                          {(Object.keys(heatmapMetricLabels) as HeatmapMetric[]).map((m) => (
                            <button
                              key={m}
                              type="button"
                              className="dash-segmented-btn"
                              data-active={heatmapMetric === m}
                              onClick={(e) => {
                                e.stopPropagation();
                                setHeatmapMetric(m);
                              }}
                              data-testid={`btn-multi-heatmap-${m}`}
                            >
                              {heatmapMetricLabels[m]}
                            </button>
                          ))}
                        </div>
                      </div>
                    }
                  >
                    <MultiDayHeatmap
                      dailyHourly={heatmapData}
                      periodLabel={periodLabels[todayPeriod]}
                      compDailyHourly={compHeatmap && compHeatmap.length > 0 ? compHeatmap : undefined}
                      compLabel={compareWith !== "none" ? effectiveCompareLabel : undefined}
                      voucherAmount={voucherAmount}
                      compVoucherAmount={(effectiveCompareData?.paymentBreakdown?.Voucher || 0) + (hasChalong ? getParentCreditFromCategories(effectiveCompareData?.categoryBreakdown) : 0)}
                      metric={heatmapMetric}
                      onMetricChange={setHeatmapMetric}
                    />
                  </CollapsibleCard>
                ) : null;
              })()}

              <CollapsibleCard
                title="Performance Graph"
                icon={OtoPerfGraph}
                defaultOpen={false}
                headerExtras={
                  <div className="dash-segmented" role="tablist" aria-label="Chart type">
                    <button
                      type="button"
                      className="dash-segmented-btn"
                      data-active={perfChartType === "line"}
                      onClick={(e) => { e.stopPropagation(); setPerfChartType("line"); }}
                      data-testid="btn-perf-line"
                      aria-label="Line chart"
                    >
                      <LineChartLucide className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="dash-segmented-btn"
                      data-active={perfChartType === "bar"}
                      onClick={(e) => { e.stopPropagation(); setPerfChartType("bar"); }}
                      data-testid="btn-perf-bar"
                      aria-label="Bar chart"
                    >
                      <BarChartLucide className="h-3.5 w-3.5" />
                    </button>
                  </div>
                }
              >
                <PerformanceGraph
                  activeData={activeData}
                  compareData={compareWith !== "none" ? effectiveCompareData ?? null : null}
                  compareLabel={compareWith !== "none" ? effectiveCompareLabel : undefined}
                  periodLabel={periodLabels[todayPeriod]}
                  isLiveToday={isLiveToday}
                  isSingleDay={todayPeriod === "today" || todayPeriod === "yesterday" || (todayPeriod === "custom" && todayPeriodDates.start === todayPeriodDates.end)}
                  graphFilter={graphFilter}
                  onClearFilter={() => setGraphFilter(null)}
                  voucherAmount={voucherAmount}
                  compVoucherAmount={(effectiveCompareData?.paymentBreakdown?.Voucher || 0) + (hasChalong ? getParentCreditFromCategories(effectiveCompareData?.categoryBreakdown) : 0)}
                  bdShift={bdShiftPlan}
                  chartType={perfChartType}
                  onChartTypeChange={setPerfChartType}
                />
              </CollapsibleCard>


              <div className="animate-slide-up stagger-6">
                <CollapsibleCard
                  title="Sales Insights"
                  icon={OtoTopProducts}
                  defaultOpen={false}
                >
                  <SalesInsights
                    paymentData={metrics.paymentBreakdown || {}}
                    products={metrics.topProducts || []}
                    compPaymentData={compareWith !== "none" ? effectiveCompareData?.paymentBreakdown ?? null : null}
                    compProducts={compareWith !== "none" ? effectiveCompareData?.topProducts ?? null : null}
                    compLabel={compareWith !== "none" ? effectiveCompareLabel : undefined}
                    deltaMode={compDeltaMode}
                  />
                </CollapsibleCard>
              </div>

              {(metrics.discountBreakdown && metrics.discountBreakdown.length > 0) && (
                <div className="animate-slide-up stagger-7">
                  <CollapsibleCard
                    title="Discount Breakdown"
                    icon={OtoEvents}
                    defaultOpen={false}
                  >
                    <DiscountBreakdown
                      discounts={metrics.discountBreakdown}
                      date={todayPeriodDates.start === todayPeriodDates.end ? todayPeriodDates.start : undefined}
                      from={todayPeriodDates.start}
                      to={todayPeriodDates.end}
                    />
                  </CollapsibleCard>
                </div>
              )}

              {todayPeriodDates.start === todayPeriodDates.end && hasFloresta && (
                <div className="animate-slide-up stagger-8">
                  <CollapsibleCard
                    title="Daily Adjustments & Audit"
                    icon={ShieldAlert}
                    defaultOpen={false}
                  >
                    <DailyAdjustmentsAudit date={todayPeriodDates.start} />
                  </CollapsibleCard>
                </div>
              )}

              <div className="animate-slide-up stagger-8">
                <CollapsibleCard
                  title="Visitor Survey"
                  icon={Users}
                  defaultOpen={false}
                >
                  <VisitorSurveySection
                    startDate={todayPeriodDates.start}
                    endDate={todayPeriodDates.end}
                  />
                </CollapsibleCard>
              </div>

            </>
          )}
        </TabsContent>

        {/* Weekly tab hidden — will bring back when we have enough historical data
        <TabsContent value="weekly" className="space-y-6 mt-4">
          <RevenueComparisonChart />
        </TabsContent>
        */}

        {/* ========== CALENDAR TAB ========== */}
        <TabsContent value="calendar" className="mt-4">
          <IntelligenceCalendarTab activeBranches={activeBranches} />
          <BirthdaysFootnote branches={activeBranches} />
        </TabsContent>

        {/* ========== TRENDS TAB ========== */}
        <TabsContent value="trends" className="mt-4" forceMount style={{ display: activeTab === "trends" ? undefined : "none" }}>
          <TrendsTab activeBranches={activeBranches} />
        </TabsContent>

        {/* ========== EVENTS TAB ========== */}
        <TabsContent value="events" className="mt-4">
          <EventsTab activeBranches={activeBranches} />
        </TabsContent>

        {/* ========== CAMPAIGNS TAB ========== */}
        <TabsContent value="campaigns" className="mt-4">
          <Suspense fallback={<div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>}>
          <CampaignsTab
            periodStart={todayPeriodDates.start}
            periodEnd={todayPeriodDates.end}
            periodLabel={todayPeriodDates.label}
            granularity={(() => {
              if (todayPeriod === "month") return "week";
              if (todayPeriod === "custom") {
                const s = new Date(todayPeriodDates.start + "T12:00:00");
                const e = new Date(todayPeriodDates.end + "T12:00:00");
                const days =
                  Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
                if (days > 92) return "month";
                if (days > 31) return "week";
                return "day";
              }
              return "day";
            })()}
            compare={
              compareWith !== "none" && compareWith !== "forecast" && compareDates
                ? { start: compareDates.start, end: compareDates.end, label: effectiveCompareLabel }
                : null
            }
          />
          </Suspense>
        </TabsContent>

        {/* ========== ACCOUNTING TAB ========== */}
        <TabsContent value="accounting" className="space-y-6 mt-4">
          {hasFloresta && (
            <div className="neu-card">
              <div className="p-4 pb-3">
                <div className="flex items-center gap-2 text-base font-semibold">
                  <Receipt className="h-4 w-4 text-emerald-500" />
                  Cash Collection Details — Floresta
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Accounting report based on the date and amount actually paid. Partial payments
                  count only when received; refunds reduce the collected total.
                </p>
              </div>
              <div className="px-4 pb-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <DateRangePicker
                    from={reportRange.from}
                    to={reportRange.to}
                    onChange={(r) => setReportRange({ from: r.from || "", to: r.to || "" })}
                    className="border rounded px-2 py-1 text-sm bg-background"
                    data-testid="input-cash-collection-range"
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!reportRange.from || !reportRange.to) return;
                      try {
                        setCashCollectionGenerating(true);
                        const url = `/api/funtopia/reports/cash-collections?from=${encodeURIComponent(reportRange.from)}&to=${encodeURIComponent(reportRange.to)}`;
                        const resp = await fetch(url);
                        if (!resp.ok) {
                          const text = await resp.text();
                          throw new Error(text || `Request failed (${resp.status})`);
                        }
                        const blob = await resp.blob();
                        const dlUrl = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = dlUrl;
                        a.download = `Floresta_Cash_Collections_${reportRange.from}_to_${reportRange.to}.xlsx`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(dlUrl);
                        toast({
                          title: "Cash collection report downloaded",
                          description: `${reportRange.from} → ${reportRange.to}`,
                        });
                      } catch (err: any) {
                        toast({
                          title: "Failed to generate report",
                          description: err?.message || String(err),
                          variant: "destructive",
                        });
                      } finally {
                        setCashCollectionGenerating(false);
                      }
                    }}
                    disabled={cashCollectionGenerating || !reportRange.from || !reportRange.to}
                    data-testid="btn-generate-cash-collection-report"
                  >
                    {cashCollectionGenerating ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Database className="h-4 w-4 mr-2" />
                    )}
                    Generate Excel
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  <p>
                    <span className="font-medium">Net Payment</span> = Payment Received − Refund.
                    The date range follows the payment timestamp, not the original order date.
                  </p>
                  <p>
                    Pisell does not provide a separate refund timestamp, so refunds use the date
                    of their payment record.
                  </p>
                </div>
              </div>
            </div>
          )}

          {hasFloresta && (
            <div className="neu-card">
              <div className="p-4 pb-3">
                <div className="flex items-center gap-2 text-base font-semibold">
                  <Receipt className="h-4 w-4 text-orange-500" />
                  Detail Transaction Report — Floresta
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Per-order ledger reproducing the Funtopia POS "Detail Transaction Report"
                  for any custom date range. Voided orders are excluded.
                </p>
              </div>
              <div className="px-4 pb-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <DateRangePicker
                    from={reportRange.from}
                    to={reportRange.to}
                    onChange={(r) => setReportRange({ from: r.from || "", to: r.to || "" })}
                    className="border rounded px-2 py-1 text-sm bg-background"
                    data-testid="input-report-range"
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!reportRange.from || !reportRange.to) return;
                      try {
                        setReportGenerating(true);
                        const url = `/api/funtopia/reports/detail-transactions?from=${encodeURIComponent(reportRange.from)}&to=${encodeURIComponent(reportRange.to)}`;
                        const resp = await fetch(url);
                        if (!resp.ok) {
                          const text = await resp.text();
                          throw new Error(text || `Request failed (${resp.status})`);
                        }
                        const blob = await resp.blob();
                        const dlUrl = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = dlUrl;
                        a.download = `Floresta_Detail_Transactions_${reportRange.from}_to_${reportRange.to}.xlsx`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(dlUrl);
                        toast({ title: "Report downloaded", description: `${reportRange.from} → ${reportRange.to}` });
                      } catch (err: any) {
                        toast({ title: "Failed to generate report", description: err?.message || String(err), variant: "destructive" });
                      } finally {
                        setReportGenerating(false);
                      }
                    }}
                    disabled={reportGenerating || !reportRange.from || !reportRange.to}
                    data-testid="btn-generate-detail-transaction-report"
                  >
                    {reportGenerating ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Database className="h-4 w-4 mr-2" />
                    )}
                    Generate Excel
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  <p className="font-medium">Known limitations:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>Deposit column is always blank — Pisell does not expose this field. Fill in manually.</li>
                    <li>Receipt Number is rebuilt as YYYYMMDD + order code suffix (Pisell does not return it).</li>
                    <li>Terminal column always shows "Terminal" — the API does not identify the till.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {hasChalong && (
            <div className="neu-card">
              <div className="p-4 pb-3">
                <div className="flex items-center gap-2 text-base font-semibold">
                  <FileText className="h-4 w-4 text-emerald-500" />
                  Tax Invoices (ABB) — Robinsons Chalong
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Issue, search, and reprint abbreviated tax invoices for the Chalong branch.
                </p>
              </div>
              <div className="px-4 pb-4">
                <Link href="/tax-invoices">
                  <Button size="sm" data-testid="link-tax-invoices">
                    <Receipt className="h-4 w-4 mr-2" />
                    Open Tax Invoices
                  </Button>
                </Link>
              </div>
            </div>
          )}

          {!hasFloresta && !hasChalong && (
            <div className="text-sm text-muted-foreground p-6 text-center">
              Select a branch to view accounting tools.
            </div>
          )}
        </TabsContent>

        {/* ========== API CONFIG TAB ========== */}
        <TabsContent value="config" className="space-y-6 mt-4">
          <SyncStatusSection />

          {hasFloresta && <FlorestaProductRegistryPanel />}

          {hasFloresta && (
          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center gap-2 text-base font-semibold">
                <MapPin className="h-4 w-4 text-orange-500" />
                Floresta — Pisell POS
              </div>
            </div>
            <div className="px-4 pb-4 space-y-6">
              <div className="flex items-center gap-3">
                <div
                  className={`w-3 h-3 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
                />
                <div>
                  <p className="font-medium">
                    {isConnected ? "Pisell POS Connected" : "POS Disconnected"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Pisell API Gateway — ap.pisellapi.com
                  </p>
                </div>
              </div>

              {syncStatus && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="neu-card p-3">
                    <p className="text-xs text-muted-foreground">Cached Days</p>
                    <p
                      className="text-lg font-bold"
                      data-testid="metric-cached-days"
                    >
                      {syncStatus.cachedDates || 0}
                    </p>
                  </div>
                  <div className="neu-card p-3">
                    <p className="text-xs text-muted-foreground">Raw Orders</p>
                    <p
                      className="text-lg font-bold"
                      data-testid="metric-raw-orders"
                    >
                      {(syncStatus.totalRawOrders || 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="neu-card p-3">
                    <p className="text-xs text-muted-foreground">Date Range</p>
                    <p className="text-sm font-medium">
                      {syncStatus.earliestDate && syncStatus.latestDate
                        ? `${format(parseISO(syncStatus.earliestDate), "dd/MM/yyyy")} → ${format(parseISO(syncStatus.latestDate), "dd/MM/yyyy")}`
                        : "—"}
                    </p>
                  </div>
                  <div className="neu-card p-3">
                    <p className="text-xs text-muted-foreground">Last Synced</p>
                    <p className="text-sm font-medium">
                      {syncStatus.lastSyncedAt
                        ? format(parseISO(syncStatus.lastSyncedAt), "dd/MM/yyyy, HH:mm:ss")
                        : "Never"}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    onClick={() => doSync("quick")}
                    disabled={syncing || florestaProcessing}
                    data-testid="btn-config-quick-sync"
                  >
                    <RefreshCw
                      className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`}
                    />
                    Quick Sync Floresta
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const now = new Date(Date.now() + 7 * 3600 * 1000);
                      const todayStr = now.toISOString().split("T")[0];
                      const d90 = new Date(now); d90.setDate(d90.getDate() - 90);
                      setFlorestaFullSyncRange({ from: d90.toISOString().split("T")[0], to: todayStr });
                      setFlorestaFullSyncOpen(!florestaFullSyncOpen);
                    }}
                    disabled={syncing || florestaProcessing}
                    data-testid="btn-config-full-sync"
                  >
                    <Database className="h-4 w-4 mr-2" />
                    Full Sync Floresta
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const now = new Date(Date.now() + 7 * 3600 * 1000);
                      const todayStr = now.toISOString().split("T")[0];
                      const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
                      setFlorestaProcessRange({ from: d30.toISOString().split("T")[0], to: todayStr });
                      setFlorestaProcessOpen(!florestaProcessOpen);
                    }}
                    disabled={syncing || florestaProcessing}
                    data-testid="btn-config-process-floresta"
                  >
                    <Cpu className="h-4 w-4 mr-2" />
                    Processing Only
                  </Button>
                </div>

                {florestaFullSyncOpen && (
                  <div className="neu-card-inner p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Full Sync — API → L1 → L2 (date range)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <DateRangePicker
                        from={florestaFullSyncRange.from}
                        to={florestaFullSyncRange.to}
                        onChange={(r) => setFlorestaFullSyncRange({ from: r.from || "", to: r.to || "" })}
                        className="border rounded px-2 py-1 text-sm bg-background"
                        data-testid="input-floresta-full-sync-range"
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (florestaFullSyncRange.from && florestaFullSyncRange.to) {
                            doFlorestaFullSync(florestaFullSyncRange.from, florestaFullSyncRange.to);
                            setFlorestaFullSyncOpen(false);
                          }
                        }}
                        disabled={syncing || !florestaFullSyncRange.from || !florestaFullSyncRange.to}
                        data-testid="btn-floresta-full-sync-go"
                      >
                        Start Full Sync
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setFlorestaFullSyncOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {florestaProcessOpen && (
                  <div className="neu-card-inner p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Processing Only — L1 → L2 (recompute daily cache, no API call)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <DateRangePicker
                        from={florestaProcessRange.from}
                        to={florestaProcessRange.to}
                        onChange={(r) => setFlorestaProcessRange({ from: r.from || "", to: r.to || "" })}
                        className="border rounded px-2 py-1 text-sm bg-background"
                        data-testid="input-floresta-process-range"
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (florestaProcessRange.from && florestaProcessRange.to) {
                            doFlorestaProcess(florestaProcessRange.from, florestaProcessRange.to);
                            setFlorestaProcessOpen(false);
                          }
                        }}
                        disabled={florestaProcessing || !florestaProcessRange.from || !florestaProcessRange.to}
                        data-testid="btn-floresta-process-go"
                      >
                        Start Processing
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setFlorestaProcessOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {florestaProcessMessage && (
                  <div className={`text-sm px-3 py-2 rounded-md ${florestaProcessMessage.startsWith("Processing failed") ? "bg-red-500/10 text-red-500" : florestaProcessing ? "bg-blue-500/10 text-blue-400" : "bg-emerald-500/10 text-emerald-500"}`}>
                    {florestaProcessing && <Loader2 className="h-3 w-3 animate-spin inline mr-2" />}
                    {florestaProcessMessage}
                  </div>
                )}
              </div>

              {syncStatus?.lastFullSyncAt && (
                <p className="text-xs text-muted-foreground">
                  Last full sync:{" "}
                  {new Date(syncStatus.lastFullSyncAt).toLocaleString()}
                </p>
              )}

            </div>
          </div>
          )}

          {hasChalong && (
          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center gap-2 text-base font-semibold">
                <MapPin className="h-4 w-4 text-emerald-500" />
                Chalong — Papaya POS
              </div>
            </div>
            <div className="px-4 pb-4 space-y-6">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${papayaSyncStatus?.receptionConnected || papayaSyncStatus?.restaurantConnected ? "bg-green-500" : "bg-red-500"}`} />
                <div>
                  <p className="font-medium">
                    {papayaSyncStatus?.receptionConnected && papayaSyncStatus?.restaurantConnected
                      ? "Papaya POS Connected (Park + Cafe)"
                      : papayaSyncStatus?.receptionConnected
                        ? "Papaya POS Connected (Park only)"
                        : papayaSyncStatus?.restaurantConnected
                          ? "Papaya POS Connected (Cafe only)"
                          : "Papaya POS Disconnected"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Papaya API Gateway — api.papaya.co.th
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="neu-card p-3">
                  <p className="text-xs text-muted-foreground">Cached Days</p>
                  <p className="text-lg font-bold" data-testid="metric-papaya-cached-days">
                    {papayaSyncStatus?.cachedDays || 0}
                  </p>
                </div>
                <div className="neu-card p-3">
                  <p className="text-xs text-muted-foreground">Total Orders</p>
                  <p className="text-lg font-bold" data-testid="metric-papaya-total-orders">
                    {(papayaSyncStatus?.totalOrders || 0).toLocaleString()}
                  </p>
                </div>
                <div className="neu-card p-3">
                  <p className="text-xs text-muted-foreground">Date Range</p>
                  <p className="text-sm font-medium">
                    {papayaSyncStatus?.earliestDate && papayaSyncStatus?.latestDate
                      ? `${format(parseISO(papayaSyncStatus.earliestDate), "dd/MM/yyyy")} → ${format(parseISO(papayaSyncStatus.latestDate), "dd/MM/yyyy")}`
                      : "—"}
                  </p>
                </div>
                <div className="neu-card p-3">
                  <p className="text-xs text-muted-foreground">Last Synced</p>
                  <p className="text-sm font-medium">
                    {papayaSyncStatus?.lastSyncedAt
                      ? format(parseISO(papayaSyncStatus.lastSyncedAt), "dd/MM/yyyy, HH:mm:ss")
                      : "Never"}
                  </p>
                </div>
              </div>

              {papayaSyncMessage && (
                <div className={`text-sm px-3 py-2 rounded-md ${papayaSyncMessage.startsWith("Sync failed") ? "bg-red-500/10 text-red-500" : papayaSyncing ? "bg-blue-500/10 text-blue-400" : "bg-emerald-500/10 text-emerald-500"}`}>
                  {papayaSyncing && <Loader2 className="h-3 w-3 animate-spin inline mr-2" />}
                  {papayaSyncMessage}
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    onClick={() => doPapayaSync("quick")}
                    disabled={papayaSyncing || chalongProcessing}
                    data-testid="btn-papaya-quick-sync"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${papayaSyncing ? "animate-spin" : ""}`} />
                    Quick Sync Chalong
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const now = new Date(Date.now() + 7 * 3600 * 1000);
                      const todayStr = now.toISOString().split("T")[0];
                      const d90 = new Date(now); d90.setDate(d90.getDate() - 90);
                      setChalongFullSyncRange({ from: d90.toISOString().split("T")[0], to: todayStr });
                      setChalongFullSyncOpen(!chalongFullSyncOpen);
                    }}
                    disabled={papayaSyncing || chalongProcessing}
                    data-testid="btn-papaya-full-sync"
                  >
                    <Database className="h-4 w-4 mr-2" />
                    Full Sync Chalong
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const now = new Date(Date.now() + 7 * 3600 * 1000);
                      const todayStr = now.toISOString().split("T")[0];
                      const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
                      setChalongProcessRange({ from: d30.toISOString().split("T")[0], to: todayStr });
                      setChalongProcessOpen(!chalongProcessOpen);
                    }}
                    disabled={papayaSyncing || chalongProcessing}
                    data-testid="btn-config-process-chalong"
                  >
                    <Cpu className="h-4 w-4 mr-2" />
                    Processing Only
                  </Button>
                </div>

                {chalongFullSyncOpen && (
                  <div className="neu-card-inner p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Full Sync — API → L1 → L2 (date range)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <DateRangePicker
                        from={chalongFullSyncRange.from}
                        to={chalongFullSyncRange.to}
                        onChange={(r) => setChalongFullSyncRange({ from: r.from || "", to: r.to || "" })}
                        className="border rounded px-2 py-1 text-sm bg-background"
                        data-testid="input-chalong-full-sync-range"
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (chalongFullSyncRange.from && chalongFullSyncRange.to) {
                            doChalongFullSync(chalongFullSyncRange.from, chalongFullSyncRange.to);
                            setChalongFullSyncOpen(false);
                          }
                        }}
                        disabled={papayaSyncing || !chalongFullSyncRange.from || !chalongFullSyncRange.to}
                        data-testid="btn-chalong-full-sync-go"
                      >
                        Start Full Sync
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setChalongFullSyncOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {chalongProcessOpen && (
                  <div className="neu-card-inner p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Processing Only — L1 → L2 (recompute daily cache, no API call)</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <DateRangePicker
                        from={chalongProcessRange.from}
                        to={chalongProcessRange.to}
                        onChange={(r) => setChalongProcessRange({ from: r.from || "", to: r.to || "" })}
                        className="border rounded px-2 py-1 text-sm bg-background"
                        data-testid="input-chalong-process-range"
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (chalongProcessRange.from && chalongProcessRange.to) {
                            doChalongProcess(chalongProcessRange.from, chalongProcessRange.to);
                            setChalongProcessOpen(false);
                          }
                        }}
                        disabled={chalongProcessing || !chalongProcessRange.from || !chalongProcessRange.to}
                        data-testid="btn-chalong-process-go"
                      >
                        Start Processing
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setChalongProcessOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {chalongProcessMessage && (
                  <div className={`text-sm px-3 py-2 rounded-md ${chalongProcessMessage.startsWith("Processing failed") ? "bg-red-500/10 text-red-500" : chalongProcessing ? "bg-blue-500/10 text-blue-400" : "bg-emerald-500/10 text-emerald-500"}`}>
                    {chalongProcessing && <Loader2 className="h-3 w-3 animate-spin inline mr-2" />}
                    {chalongProcessMessage}
                  </div>
                )}

                <div className="border-t pt-3">
                  <p className="text-xs text-muted-foreground mb-2">Quick sync by terminal:</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => doPapayaSync("quick", "reception")}
                      disabled={papayaSyncing}
                      data-testid="btn-papaya-sync-park"
                    >
                      <RefreshCw className={`h-3 w-3 mr-1.5 ${papayaSyncing ? "animate-spin" : ""}`} />
                      Park Only
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => doPapayaSync("quick", "restaurant")}
                      disabled={papayaSyncing}
                      data-testid="btn-papaya-sync-cafe"
                    >
                      <RefreshCw className={`h-3 w-3 mr-1.5 ${papayaSyncing ? "animate-spin" : ""}`} />
                      Cafe Only
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}

          {hasFloresta && (
          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center gap-2 text-base font-semibold">
                <Lock className="h-4 w-4" />
                Locked Months
              </div>
            </div>
            <div className="px-4 pb-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Lock completed months to protect historical data. Locked months are skipped during sync and preserved during push to production.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {availableMonths.map(({ month, label, complete }) => {
                  const isLocked = lockedMonths.includes(month);
                  return (
                    <button
                      key={month}
                      onClick={() => toggleLockedMonth(month)}
                      disabled={lockingMonth || !complete}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all border",
                        isLocked
                          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                          : complete
                            ? "neu-card-inner hover:border-primary/30 text-muted-foreground"
                            : "neu-card-inner opacity-50 cursor-not-allowed text-muted-foreground/50",
                      )}
                      data-testid={`btn-lock-${month}`}
                    >
                      {isLocked ? (
                        <Lock className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Unlock className="h-3.5 w-3.5" />
                      )}
                      <span>{label}</span>
                      {isLocked && <Check className="h-3.5 w-3.5 ml-auto text-emerald-500" />}
                      {!complete && <span className="text-[10px] ml-auto">(in progress)</span>}
                    </button>
                  );
                })}
              </div>
              {lockedMonths.length > 0 && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  <Lock className="h-3 w-3 inline mr-1" />
                  {lockedMonths.length} month{lockedMonths.length > 1 ? "s" : ""} locked — data is protected from sync overwrite and push deletion.
                </p>
              )}
            </div>
          </div>
          )}

          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center gap-2 text-base font-semibold">
                Push Data to Production
              </div>
            </div>
            <div className="px-4 pb-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Copy all synced data (Floresta + Chalong cache, orders, cash reports, calendar notes) to the published app. Run this after syncing so you don't have to re-sync in production.
              </p>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Published App URL</label>
                <input
                  type="url"
                  placeholder="https://your-app.replit.app"
                  value={prodUrl}
                  onChange={(e) => setProdUrl(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background"
                  data-testid="input-prod-url"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Date Range (optional — leave empty to push all data)</label>
                <div className="flex items-center gap-2">
                  <DateRangePicker
                    from={pushDateFrom}
                    to={pushDateTo}
                    onChange={(range) => {
                      setPushDateFrom(range.from);
                      setPushDateTo(range.to);
                    }}
                    disabled={pushing}
                    data-testid="push-date-range-picker"
                  />
                  {(pushDateFrom || pushDateTo) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setPushDateFrom(undefined); setPushDateTo(undefined); }}
                      disabled={pushing}
                      data-testid="btn-clear-push-date-range"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
              {pushMessage && (
                <div className={`text-sm px-3 py-2 rounded-md ${pushMessage.startsWith("Error") || pushMessage.startsWith("Failed") ? "bg-red-500/10 text-red-500" : pushing ? "bg-blue-500/10 text-blue-400" : "bg-emerald-500/10 text-emerald-500"}`}>
                  {pushing && <Loader2 className="h-3 w-3 animate-spin inline mr-2" />}
                  {pushMessage}
                </div>
              )}
              <Button
                variant="outline"
                onClick={doPushToProduction}
                disabled={pushing || syncing || !prodUrl.trim()}
                data-testid="btn-push-to-production"
              >
                <Database className="h-4 w-4 mr-2" />
                {pushing ? "Pushing..." : "Push to Production"}
              </Button>

              <div className="border-t border-border pt-3 mt-3">
                <p className="text-xs text-muted-foreground mb-2">
                  Wipe all Funtopia &amp; Papaya API data on production. This is irreversible.
                </p>
                <Button
                  variant="outline"
                  className="border-red-500/50 text-red-500 hover:bg-red-500/10 hover:text-red-600"
                  onClick={() => setWipeDialogOpen(true)}
                  disabled={wiping || !prodUrl.trim()}
                  data-testid="btn-wipe-production-data"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {wiping ? "Wiping..." : "Wipe API Data on Production"}
                </Button>
              </div>

              <Dialog open={wipeDialogOpen} onOpenChange={(open) => { setWipeDialogOpen(open); if (!open) setWipeConfirmText(""); }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-red-500">
                      <AlertTriangle className="h-5 w-5" />
                      Wipe All API Data on Production
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <p className="text-sm text-muted-foreground">
                      This will permanently delete all Funtopia and Papaya data on the production database. This action cannot be undone.
                    </p>
                    <p className="text-sm font-medium">
                      Type <span className="font-mono text-red-500">DELETE EVERYTHING</span> to confirm:
                    </p>
                    <input
                      type="text"
                      value={wipeConfirmText}
                      onChange={(e) => setWipeConfirmText(e.target.value)}
                      placeholder="Type DELETE EVERYTHING"
                      className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background"
                      data-testid="input-wipe-confirm"
                    />
                  </div>
                  <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => { setWipeDialogOpen(false); setWipeConfirmText(""); }} data-testid="btn-wipe-cancel">
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={doWipeProductionData}
                      disabled={wipeConfirmText !== "DELETE EVERYTHING" || wiping}
                      data-testid="btn-wipe-confirm"
                    >
                      {wiping && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      {wiping ? "Wiping..." : "Wipe All Data"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {hasFloresta && (
          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center gap-2 text-base font-semibold">
                Cash Reports (Manual Entry)
              </div>
            </div>
            <div className="px-4 pb-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                72 manual cash report records for Central Floresta are seeded
                for Jan 12 – Mar 24, 2026. These appear as green bars in the
                daily revenue chart alongside POS API data.
              </p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-emerald-500/80 inline-block" />{" "}
                  Cash Report
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-primary/60 inline-block" />{" "}
                  POS API (live)
                </span>
              </div>
            </div>
          </div>
          )}


          <div className="neu-card">
            <div className="p-4 pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-base font-semibold">
                  <BookOpen className="h-4 w-4" />
                  Formula Definitions
                </div>
                {formulaData && (
                  <Badge variant="outline" className="text-[10px]" data-testid="badge-formula-version">
                    {formulaData.version} · {formulaData.lastUpdated}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Declared calculation formulas — the single source of truth for how every number is computed.
              </p>
            </div>
            <div className="px-4 pb-4 space-y-2" data-testid="section-formula-definitions">
              {formulaData?.categories.map((cat) => {
                const isExpanded = expandedFormulaCategories[cat.category] ?? false;
                return (
                  <div key={cat.category} className="neu-card-inner rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleFormulaCategory(cat.category)}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium hover:bg-muted/50 transition-colors"
                      data-testid={`btn-formula-cat-${cat.category.replace(/\s+/g, "-").toLowerCase()}`}
                    >
                      <span className="flex items-center gap-2">
                        {cat.category}
                        <span className="text-xs text-muted-foreground font-normal">({cat.formulas.length})</span>
                      </span>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                    {isExpanded && (
                      <div className="border-t divide-y">
                        {cat.formulas.map((f) => (
                          <div key={f.id} className="px-3 py-3 space-y-1.5" data-testid={`formula-${f.id}`}>
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">{f.name}</span>
                              <Badge variant="secondary" className="text-[10px]">{f.version}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{f.description}</p>
                            <div className="bg-muted/50 rounded-md px-2.5 py-2 text-xs font-mono leading-relaxed">
                              {f.formula}
                            </div>
                            <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                              <Clock className="h-2.5 w-2.5" />
                              Last updated: {f.lastUpdated}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {formulaLoading && (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading formula definitions...
                </div>
              )}
              {formulaError && (
                <div className="flex items-center justify-center py-6 text-sm text-red-500">
                  Failed to load formula definitions.
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </div>
    </Tabs>
  );
}
