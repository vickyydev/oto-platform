import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cake } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type StaffBirthday = {
  id: string;
  name: string;
  fullName: string | null;
  branch: "floresta" | "chalong";
  department: string;
  birthMonth: number;
  birthDay: number;
  birthYear: number | null;
};

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const BRANCH_LABEL: Record<string, string> = {
  floresta: "Floresta",
  chalong: "Chalong",
};

function bangkokNow(): Date {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
}

function isSameMonthDay(b: StaffBirthday, d: Date): boolean {
  return b.birthMonth === d.getMonth() + 1 && b.birthDay === d.getDate();
}

export function useBirthdays(branches: Set<string>) {
  const branchKey = Array.from(branches).sort().join(",");
  return useQuery<StaffBirthday[]>({
    queryKey: ["/api/staff-birthdays", branchKey],
    queryFn: async () => {
      const url = branchKey
        ? `/api/staff-birthdays?branches=${encodeURIComponent(branchKey)}`
        : "/api/staff-birthdays";
      const res = await fetch(url);
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
  });
}

export function BirthdaysFootnote({ branches }: { branches: Set<string> }) {
  const { data } = useBirthdays(branches);
  const today = bangkokNow();
  const currentMonth = today.getMonth() + 1;

  const { monthList, todayList, tomorrowList } = useMemo(() => {
    if (!data) return { monthList: [], todayList: [], tomorrowList: [] };
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return {
      monthList: data
        .filter((b) => b.birthMonth === currentMonth)
        .sort((a, b) => a.birthDay - b.birthDay),
      todayList: data.filter((b) => isSameMonthDay(b, today)),
      tomorrowList: data.filter((b) => isSameMonthDay(b, tomorrow)),
    };
  }, [data, currentMonth, today]);

  if (!data) return null;

  const count = monthList.length;
  const hasToday = todayList.length > 0;

  return (
    <div className="flex justify-center pt-1 pb-3" data-testid="birthdays-footnote">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center gap-1.5 text-xs text-muted-foreground rounded-full px-3 py-1 hover-elevate",
              hasToday && "text-pink-600 dark:text-pink-300 font-medium",
            )}
            data-testid="birthdays-trigger"
          >
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                hasToday ? "bg-pink-500 animate-pulse" : "bg-pink-400/50",
              )}
            />
            <Cake className="h-3.5 w-3.5" />
            <span>
              {hasToday
                ? `${todayList.length} birthday${todayList.length > 1 ? "s" : ""} today`
                : `${count} birthday${count === 1 ? "" : "s"} in ${MONTHS_SHORT[currentMonth - 1]}`}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs p-3">
          <div className="space-y-2 text-xs">
            {todayList.length > 0 && (
              <div>
                <p className="font-semibold text-pink-600 dark:text-pink-300 mb-1">
                  🎉 Today
                </p>
                <ul className="space-y-0.5">
                  {todayList.map((b) => (
                    <li key={b.id}>
                      <span className="font-medium">{b.name}</span>{" "}
                      <span className="text-muted-foreground">
                        — {BRANCH_LABEL[b.branch]} · {b.department}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tomorrowList.length > 0 && (
              <div>
                <p className="font-semibold mb-1">Tomorrow</p>
                <ul className="space-y-0.5">
                  {tomorrowList.map((b) => (
                    <li key={b.id}>
                      <span className="font-medium">{b.name}</span>{" "}
                      <span className="text-muted-foreground">
                        — {BRANCH_LABEL[b.branch]} · {b.department}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="font-semibold mb-1">
                {MONTHS_SHORT[currentMonth - 1]}
                {monthList.length > 0 && ` (${monthList.length})`}
              </p>
              {monthList.length === 0 ? (
                <p className="text-muted-foreground italic">No birthdays this month.</p>
              ) : (
                <ul className="space-y-0.5">
                  {monthList.map((b) => {
                    const isToday = isSameMonthDay(b, today);
                    return (
                      <li
                        key={b.id}
                        className={cn(isToday && "text-pink-600 dark:text-pink-300 font-medium")}
                      >
                        <span className="font-mono text-muted-foreground">
                          {String(b.birthDay).padStart(2, "0")}
                        </span>{" "}
                        <span className="font-medium">{b.name}</span>{" "}
                        <span className="text-muted-foreground">
                          — {BRANCH_LABEL[b.branch]} · {b.department}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
