import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  CalendarDays,
  Clock,
  Users,
  User,
  UtensilsCrossed,
  Mic2,
  Settings,
  CreditCard,
  AlertCircle,
  Check,
  Printer,
  UserCheck,
  Timer,
  Cake,
  Building2,
  CheckCircle2,
  Circle,
  Wine,
  Download,
} from "lucide-react";
import type { BeoEventWithDetails, BeoTimelineItem } from "@shared/schema";

interface BeoViewOnlyProps {
  eventId: string;
  showHeader?: boolean;
}

type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean };

type SetMenuTemplateSummary = {
  id: string;
  name: string;
  items: SetMenuTemplateItem[];
};

type MenuItem = {
  id?: string;
  itemName: string;
  quantity?: number;
  notes?: string;
  price?: number;
  source?: string;
  groupId?: string;
};

function MenuItemList({ items }: { items: MenuItem[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item, index) => (
        <li key={item.id || index} className="text-sm flex items-center gap-2">
          <span>{item.quantity && item.quantity > 1 ? `${item.quantity}× ` : ""}{item.itemName}</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${item.source === "set_menu" ? "bg-blue-500/10 text-blue-600 border-blue-500/30" : "bg-amber-500/10 text-amber-600 border-amber-500/30"}`}>
            {item.source === "set_menu" ? "SET" : "EXTRA"}
          </Badge>
          {item.source !== "set_menu" && item.price && item.price > 0 ? (
            <span className="text-xs text-muted-foreground">฿{Number(item.price).toLocaleString()}</span>
          ) : null}
          {item.notes && <span className="text-xs text-muted-foreground">({item.notes})</span>}
        </li>
      ))}
    </ul>
  );
}

function ReadOnlySetMenuChoices({
  template,
  resolvedItems,
  isSubmitted,
}: {
  template: SetMenuTemplateSummary | null;
  resolvedItems: MenuItem[];
  isSubmitted: boolean;
}) {
  if (!template) {
    return resolvedItems.length > 0 ? (
      <div className="p-3">
        <MenuItemList items={resolvedItems} />
      </div>
    ) : (
      <p className="px-3 py-2 text-xs text-muted-foreground italic">No selections yet — parent link sent</p>
    );
  }

  const fixedItems = template.items.filter((item) => item.type === "always_included");
  const choiceGroups = template.items.filter((item) => item.type === "choice_group");
  const usedIndexes = new Set<number>();

  const fixedRows = fixedItems.map((item) => {
    const index = resolvedItems.findIndex((menuItem, itemIndex) =>
      !usedIndexes.has(itemIndex) &&
      (
        menuItem.groupId === item.id ||
        (
          !menuItem.groupId &&
          menuItem.itemName === item.label &&
          (!menuItem.notes || !menuItem.notes.trim())
        )
      ),
    );
    if (index >= 0) usedIndexes.add(index);
    return { item, isResolved: index >= 0 };
  });

  const choiceRows = choiceGroups.map((group) => {
    const choices = resolvedItems.filter((menuItem, itemIndex) => {
      const hasSavedGroup = menuItem.groupId === group.id;
      const isLegacyMatch =
        !menuItem.groupId &&
        menuItem.notes?.trim() === `(${group.label})`;
      if (hasSavedGroup || isLegacyMatch) {
        usedIndexes.add(itemIndex);
        return true;
      }
      return false;
    });
    return { group, choices };
  });

  const ungroupedItems = resolvedItems.filter((_, index) => !usedIndexes.has(index));

  return (
    <div className="p-3 space-y-2">
      {fixedRows.length > 0 && (
        <div className="space-y-1" data-testid="view-set-menu-fixed-items">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Included items</p>
          {fixedRows.map(({ item, isResolved }) => (
            <div key={item.id} className="text-sm flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <span>{item.label}</span>
              {isSubmitted && !isResolved && <span className="text-xs text-muted-foreground italic">not yet resolved</span>}
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-600 border-emerald-500/30 ml-auto">Always</Badge>
            </div>
          ))}
        </div>
      )}

      {choiceRows.map(({ group, choices }) => (
        <div key={group.id} className="text-sm flex items-start gap-2" data-testid={`view-set-menu-choice-group-${group.id}`}>
          {isSubmitted && choices.length > 0 ? (
            <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <span className="font-medium">{group.label}</span>
            {isSubmitted && choices.length > 0 ? (
              <span className="text-emerald-600 ml-1" data-testid={`view-set-menu-choice-options-${group.id}`}>
                → {choices.map((item) => item.itemName).join(", ")}
              </span>
            ) : (
              <span className="text-muted-foreground ml-1 italic">pending parent selection</span>
            )}
          </div>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-500/10 text-blue-600 border-blue-500/30">Choice</Badge>
        </div>
      ))}

      {ungroupedItems.length > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Other set menu items</p>
          <MenuItemList items={ungroupedItems} />
        </div>
      )}
    </div>
  );
}

function KitchenMenuBucket({
  title,
  menuItems,
  serviceTime,
  showSetMenu,
  selectionStatus,
  template,
}: {
  title: string;
  menuItems: MenuItem[];
  serviceTime?: string;
  showSetMenu: boolean;
  selectionStatus?: { isSubmitted: boolean; submittedAt: string | Date | null } | null;
  template: SetMenuTemplateSummary | null;
}) {
  const setMenuItems = menuItems.filter((item) => item.source === "set_menu");
  const additionalItems = menuItems.filter((item) => item.source !== "set_menu");
  const isSubmitted = selectionStatus != null ? selectionStatus.isSubmitted : setMenuItems.length > 0;

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 mb-2">
        <p className="text-xs font-semibold uppercase text-muted-foreground">{title}</p>
        {serviceTime && <span className="text-xs text-muted-foreground">Service: {serviceTime}</span>}
      </div>

      {showSetMenu ? (
        <div className="space-y-3">
          <div className="border-2 border-emerald-500/40 rounded-lg overflow-hidden">
            <div className="bg-emerald-500/15 px-3 py-1.5 flex items-center gap-2">
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Set Menu</span>
              {template && <Badge variant="outline" className="text-[10px] px-1.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">{template.name}</Badge>}
              {!isSubmitted && (
                <Badge variant="outline" className="text-[10px] px-1.5 bg-amber-500/10 text-amber-600 border-amber-500/30 ml-auto">
                  Awaiting parent selections
                </Badge>
              )}
              {isSubmitted && selectionStatus?.submittedAt && (
                <Badge className="text-[10px] px-1.5 bg-emerald-500 text-white ml-auto">
                  Received {new Date(selectionStatus.submittedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </Badge>
              )}
            </div>
            <ReadOnlySetMenuChoices template={template} resolvedItems={setMenuItems} isSubmitted={isSubmitted} />
          </div>

          {additionalItems.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Additional Items</p>
              <MenuItemList items={additionalItems} />
            </div>
          )}
        </div>
      ) : (
        <MenuItemList items={menuItems} />
      )}
    </div>
  );
}

export function BeoViewOnly({ eventId, showHeader = true }: BeoViewOnlyProps) {
  const { data: beoData, isLoading } = useQuery<BeoEventWithDetails>({
    queryKey: ['/api/events', eventId, 'beo'],
    refetchInterval: (query) => {
      const kitchenPlan = query.state.data?.kitchenPlan as any;
      return kitchenPlan?.setMenuSelectionStatus && !kitchenPlan.setMenuSelectionStatus.isSubmitted ? 5000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const { data: timeline } = useQuery<BeoTimelineItem[]>({
    queryKey: ['/api/events', eventId, 'beo', 'timeline'],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/beo/timeline`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const beoTasks = ((beoData as any)?.beoTasks || []) as any[];

  const getBeoTaskStatus = (prefix: string) => {
    const task = beoTasks.find((t: any) => t.title?.startsWith(prefix));
    if (!task) return null;
    return task;
  };

  const toggleBeoTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const task = beoTasks.find((t: any) => t.id === taskId);
      const newStatus = task?.status === "completed" ? "pending" : "completed";
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status: newStatus });
      if (!res.ok) throw new Error("Failed to update task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const BeoTaskBadge = ({ prefix, label }: { prefix: string; label: string }) => {
    const task = getBeoTaskStatus(prefix);
    if (!task) return null;
    const isCompleted = task.status === "completed";
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggleBeoTaskMutation.mutate(task.id);
        }}
        className={`ml-auto flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
          isCompleted
            ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
            : "bg-muted text-muted-foreground border-border hover:bg-accent"
        }`}
        data-testid={`beo-task-toggle-${prefix.replace(/[^a-z]/gi, "").toLowerCase()}`}
      >
        {isCompleted ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
        {isCompleted ? "Done" : label}
      </button>
    );
  };

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!beoData) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <AlertCircle className="h-5 w-5 mr-2" />
        No BEO data found
      </div>
    );
  }

  const InfoRow = ({ icon: Icon, label, value }: { icon: any; label: string; value?: string | number | null }) => {
    if (!value) return null;
    return (
      <div className="flex items-start gap-3 py-1.5">
        <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1">
          <span className="text-xs text-muted-foreground">{label}: </span>
          <span className="text-sm">{value}</span>
        </div>
      </div>
    );
  };

  const CheckItem = ({ label, completed }: { label: string; completed?: boolean }) => (
    <div className="flex items-center gap-2 py-1">
      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${completed ? 'bg-primary border-primary' : 'border-muted-foreground/30'}`}>
        {completed && <Check className="h-3 w-3 text-primary-foreground" />}
      </div>
      <span className={`text-sm ${completed ? 'text-muted-foreground line-through' : ''}`}>{label}</span>
    </div>
  );

  const partyHost = beoData.partyHost as any;
  const entertainment = beoData.entertainment as any;
  const setupPlan = beoData.setupPlan as any;
  const kitchenPlan = beoData.kitchenPlan as any;
  const barPlan = (beoData as any).barPlan as any;
  const billing = beoData.billing as any;
  const partyDetails = (beoData as any).partyDetails as any;
  const sortedTimeline = timeline?.slice().sort((a, b) => a.offsetFromStartMinutes - b.offsetFromStartMinutes) || [];

  const formatTimelineTime = (offsetMinutes: number) => {
    if (!beoData?.startTime) return "";
    const [h, m] = beoData.startTime.split(":").map(Number);
    const totalMins = h * 60 + m + offsetMinutes;
    const hours = Math.floor(((totalMins % 1440) + 1440) % 1440 / 60);
    const mins = ((totalMins % 60) + 60) % 60;
    const hour12 = hours % 12 || 12;
    const ampm = hours >= 12 ? "PM" : "AM";
    return `${hour12}:${mins.toString().padStart(2, "0")} ${ampm}`;
  };

  const packageBasePrice = partyDetails?.packageBasePrice || 0;
  const packageItems = partyDetails?.items || [];
  const extrasTotal = packageItems.filter((i: any) => i.type === "extra").reduce((s: number, i: any) => s + (Number(i.price) || 0), 0);
  const packageTotal = packageBasePrice + extrasTotal;
  const prepaymentReceived = partyDetails?.prepaymentReceived || 0;
  const outstandingBalance = packageTotal - prepaymentReceived;

  const hasPartyHost = partyHost && (partyHost.assignedEmployeeId || partyHost.assignedUserId || partyHost.assignedRoleId || partyHost.resolvedUserName || partyHost.assignedEmployeeName);
  const hasEntertainment = entertainment && (entertainment.entertainmentRequired || entertainment.vendorName || entertainment.assignedUserId);

  const setupTasksData = setupPlan?.setupTasks as any;
  const setupSimplifiedTasks = setupTasksData?.simplifiedTasks || [];
  const hasSetup = setupPlan && (setupPlan.setupRequired || setupSimplifiedTasks.length > 0 || setupTasksData?.readyBy || setupTasksData?.responsible);

  // `menus` is the canonical persisted representation. Older BEO responses can
  // still provide simplifiedMenus, so use it only when the canonical bucket is absent.
  const kidsMenu = kitchenPlan?.menus?.kids ?? kitchenPlan?.simplifiedMenus?.kids ?? [];
  const adultsMenu = kitchenPlan?.menus?.adults ?? kitchenPlan?.simplifiedMenus?.adults ?? [];
  const hasKitchen = kitchenPlan && (kitchenPlan.foodRequired || kidsMenu.length > 0 || adultsMenu.length > 0 || (kitchenPlan.cakeMode && kitchenPlan.cakeMode !== "NONE") || (kitchenPlan as any).setMenuEnabled);
  const barItems: any[] = barPlan?.items || [];
  const hasBar = !!(barPlan?.serviceTime || barItems.length > 0);

  const hasPartyDetails = partyDetails && (partyDetails.packageName || packageItems.length > 0);
  const hasTimeline = sortedTimeline.length > 0;
  const hasNotes = beoData.allergiesNotes || beoData.cakeNotes || beoData.specialRequests || beoData.internalStaffNotes || partyDetails?.notes;
  const kidTurningAge = (beoData as any).kidTurningAge as number | null | undefined;

  const setupReadyBy = setupTasksData?.readyBy || null;
  const setupResponsible = setupTasksData?.responsible || null;

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="text-xl font-bold">{beoData.title}</h2>
            <p className="text-base font-medium text-foreground flex items-center gap-2 mt-0.5">
              <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                {(() => {
                  const d = new Date(beoData.eventDate + 'T00:00:00');
                  const day = d.getDate();
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  const month = months[d.getMonth()];
                  const year = String(d.getFullYear()).slice(-2);
                  return `${day} ${month} '${year}`;
                })()}
              </span>
              <span className="text-muted-foreground">•</span>
              <span className="font-extrabold tracking-tight text-foreground" style={{ fontSize: "2rem", lineHeight: 1.2 }}>
                {beoData.startTime}
                {beoData.endTime && <span style={{ margin: "0 0.25rem" }}>–</span>}
                {beoData.endTime}
              </span>
              {kidTurningAge != null && (
                <span className="text-sm font-medium text-muted-foreground" data-testid="text-kid-turning-age">• Turning {kidTurningAge}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(`/api/events/${eventId}/beo/pdf`, '_blank')}
              data-testid="button-print-beo-view"
            >
              <Printer className="h-4 w-4 mr-1" />
              Print
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const res = await fetch(`/api/events/${eventId}/beo/pdf`, { credentials: 'include' });
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `BEO.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              data-testid="button-download-beo-view"
            >
              <Download className="h-4 w-4 mr-1" />
              Download PDF
            </Button>
          </div>
        </div>
      )}

      {!showHeader && (
        <div className="flex justify-end gap-2 mb-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/api/events/${eventId}/beo/pdf`, '_blank')}
            data-testid="button-print-beo-inline"
          >
            <Printer className="h-4 w-4 mr-1" />
            Print BEO
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const res = await fetch(`/api/events/${eventId}/beo/pdf`, { credentials: 'include' });
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `BEO.pdf`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
            data-testid="button-download-beo-inline"
          >
            <Download className="h-4 w-4 mr-1" />
            Download PDF
          </Button>
        </div>
      )}

      <Accordion type="multiple" defaultValue={[]} className="space-y-2">
        {hasPartyHost && (
          <AccordionItem value="party-host" className="border rounded-lg px-4 border-l-4 border-l-pink-500 bg-pink-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-party-host">
              <div className="flex items-center gap-2">
                <UserCheck className="h-4 w-4 text-pink-500" />
                <span className="font-medium">Party Host</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-2">
                {(partyHost.assignedEmployeeName || partyHost.resolvedUserName) && (
                  <InfoRow icon={User} label="Assigned To" value={partyHost.assignedEmployeeName || partyHost.resolvedUserName} />
                )}
                {partyHost.backupEmployeeName && (
                  <InfoRow icon={User} label="Entertainment Host" value={partyHost.backupEmployeeName} />
                )}
                {partyHost.assignedRoleName && !partyHost.resolvedUserName && !partyHost.assignedEmployeeName && (
                  <InfoRow icon={Users} label="Role" value={partyHost.assignedRoleName} />
                )}
                {partyHost.notes && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground">Notes:</p>
                    <p className="text-sm">{partyHost.notes}</p>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasEntertainment && (
          <AccordionItem value="entertainment" className="border rounded-lg px-4 border-l-4 border-l-purple-500 bg-purple-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-entertainment">
              <div className="flex items-center gap-2">
                <Mic2 className="h-4 w-4 text-purple-500" />
                <span className="font-medium">Entertainment</span>
                {!entertainment.entertainmentRequired && (
                  <Badge variant="outline" className="text-xs">Not Required</Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-2">
                {entertainment.vendorName && (
                  <InfoRow icon={Building2} label="Vendor" value={entertainment.vendorName} />
                )}
                {entertainment.resolvedUserName && (
                  <InfoRow icon={User} label="Staff" value={entertainment.resolvedUserName} />
                )}
                {entertainment.assignedRoleName && !entertainment.resolvedUserName && (
                  <InfoRow icon={Users} label="Role" value={entertainment.assignedRoleName} />
                )}
                {entertainment.performanceType && (
                  <InfoRow icon={Mic2} label="Type" value={entertainment.performanceType} />
                )}
                {entertainment.notes && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground">Notes:</p>
                    <p className="text-sm">{entertainment.notes}</p>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasSetup && (
          <AccordionItem value="setup" className="border rounded-lg px-4 border-l-4 border-l-orange-500 bg-orange-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-setup">
              <div className="flex items-center gap-2 w-full">
                <Settings className="h-4 w-4 text-orange-500" />
                <span className="font-medium">Setup Plan</span>
                {setupReadyBy && (
                  <Badge variant="outline" className="ml-2">Ready by {setupReadyBy}</Badge>
                )}
                <BeoTaskBadge prefix="🔧 Setup:" label="Mark Setup Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-2">
                {setupReadyBy && (
                  <div className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-muted/50">
                    <Timer className="h-4 w-4 text-orange-500" />
                    <span className="text-sm font-medium">Setup must be ready by <span className="text-primary">{setupReadyBy}</span></span>
                  </div>
                )}
                {setupResponsible && (
                  <InfoRow icon={User} label="Responsible" value={setupResponsible} />
                )}
                {setupSimplifiedTasks.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Tasks:</p>
                    <div className="space-y-1">
                      {setupSimplifiedTasks.map((task: any, i: number) => (
                        <div key={task.id || i} className="flex items-start gap-2 py-0.5">
                          <span className="text-sm">• {task.itemLabel || task.itemKey}</span>
                          {task.notes && <span className="text-xs text-muted-foreground">({task.notes})</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {setupPlan.setupNotes && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground">Notes:</p>
                    <p className="text-sm">{setupPlan.setupNotes}</p>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasKitchen && (
          <AccordionItem value="kitchen" className="border rounded-lg px-4 border-l-4 border-l-blue-500 bg-blue-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-kitchen">
              <div className="flex items-center gap-2 w-full">
                <UtensilsCrossed className="h-4 w-4 text-blue-500" />
                <span className="font-medium">Kitchen Plan</span>
                {!kitchenPlan.foodRequired && kidsMenu.length === 0 && adultsMenu.length === 0 && (
                  <Badge variant="outline" className="text-xs">Not Required</Badge>
                )}
                <BeoTaskBadge prefix="🍽️ Kitchen:" label="Mark Kitchen Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-3">
                {(() => {
                  const kp = kitchenPlan as any;
                  const selectionStatus = kp.setMenuSelectionStatus as { isSubmitted: boolean; submittedAt: string | Date | null } | null | undefined;
                  const template = (kp.setMenuTemplate || null) as SetMenuTemplateSummary | null;
                  const setMenuEnabled = Boolean(kp.setMenuEnabled);
                  const kidsHasSetItems = kidsMenu.some((item: MenuItem) => item.source === "set_menu");
                  const adultsHasSetItems = adultsMenu.some((item: MenuItem) => item.source === "set_menu");
                  const defaultSetMenuBucket = adultsMenu.length > 0 && kidsMenu.length === 0 ? "adults" : "kids";

                  return (
                    <>
                      {(kidsMenu.length > 0 || (setMenuEnabled && (kidsHasSetItems || defaultSetMenuBucket === "kids"))) && (
                        <KitchenMenuBucket
                          title="Kids' Menu"
                          menuItems={kidsMenu}
                          serviceTime={kp.menus?.kidsFoodTime}
                          showSetMenu={setMenuEnabled && (kidsHasSetItems || (!adultsHasSetItems && defaultSetMenuBucket === "kids"))}
                          selectionStatus={selectionStatus}
                          template={template}
                        />
                      )}
                      {(adultsMenu.length > 0 || (setMenuEnabled && (adultsHasSetItems || defaultSetMenuBucket === "adults"))) && (
                        <KitchenMenuBucket
                          title="Adults' Menu"
                          menuItems={adultsMenu}
                          serviceTime={kp.menus?.adultsFoodTime}
                          showSetMenu={setMenuEnabled && (adultsHasSetItems || (!kidsHasSetItems && defaultSetMenuBucket === "adults"))}
                          selectionStatus={selectionStatus}
                          template={template}
                        />
                      )}
                    </>
                  );
                })()}

                {(() => {
                  const kp = kitchenPlan as any;
                  const menusData = kp.menus as any;
                  const cakeIncluded = menusData?.cakeIncluded;
                  const cakePrice = menusData?.cakePrice || 0;
                  const cakeQuantity = kp.cakeQuantity ?? 1;
                  if (kp.cakeMode === "NONE" && !kp.cakeTime && !kp.cakeNotes) return null;
                  return (
                    <div className="pt-1">
                      <p className="text-sm flex items-center gap-1">
                        <Cake className="h-3.5 w-3.5" />
                        {kp.cakeMode === "INTERNAL" ? "Our Cake" : kp.cakeMode === "EXTERNAL" ? "Own Cake" : "No Cake"}
                        {cakeQuantity > 1 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-0.5">x{cakeQuantity}</Badge>
                        )}
                        {cakeIncluded !== undefined && (
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ml-1 ${cakeIncluded ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-amber-500/10 text-amber-600 border-amber-500/30'}`}>
                            {cakeIncluded ? "INCL" : "EXTRA"}
                          </Badge>
                        )}
                        {!cakeIncluded && cakePrice > 0 && (
                          <span className="text-xs text-muted-foreground ml-1">฿{Number(cakePrice).toLocaleString()}</span>
                        )}
                      </p>
                      {kp.cakeTime && <p className="text-xs text-muted-foreground ml-5">Time: {kp.cakeTime}</p>}
                      {kp.cakeNotes && <p className="text-xs text-muted-foreground ml-5">{kp.cakeNotes}</p>}
                    </div>
                  );
                })()}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasBar && (
          <AccordionItem value="bar-plan" className="border rounded-lg px-4 border-l-4 border-l-teal-500 bg-teal-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-bar-plan">
              <div className="flex items-center gap-2">
                <Wine className="h-4 w-4 text-teal-500" />
                <span className="font-medium">Bar Plan</span>
                {barPlan?.serviceTime && (
                  <Badge variant="outline" className="ml-2 text-xs text-teal-600 border-teal-500/30">
                    {barPlan.serviceTime}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-1">
                {barItems.map((item: any, idx: number) => (
                  <div key={item.id || idx} className="space-y-0" data-testid={`bar-view-item-${idx}`}>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${item.source === "set_menu" ? "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400" : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"}`}>
                        {item.source === "set_menu" ? "SET" : "EXTRA"}
                      </span>
                      <span className="font-mono text-muted-foreground shrink-0">{item.quantity || 1}x</span>
                      <span>{item.itemName}</span>
                    </div>
                    {item.notes && <p className="text-xs text-muted-foreground ml-16">{item.notes}</p>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasNotes && (
          <AccordionItem value="notes" className="border rounded-lg px-4 border-l-4 border-l-amber-500 bg-amber-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-notes">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                <span className="font-medium">Important Notes</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-3">
                {beoData.allergiesNotes && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">Allergies & Dietary</p>
                    <p className="text-sm">{beoData.allergiesNotes}</p>
                  </div>
                )}
                {beoData.cakeNotes && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">Cake Notes</p>
                    <p className="text-sm">{beoData.cakeNotes}</p>
                  </div>
                )}
                {beoData.specialRequests && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">Special Requests</p>
                    <p className="text-sm">{beoData.specialRequests}</p>
                  </div>
                )}
                {beoData.internalStaffNotes && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">Staff Notes</p>
                    <p className="text-sm">{beoData.internalStaffNotes}</p>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasTimeline && (
          <AccordionItem value="timeline" className="border rounded-lg px-4 border-l-4 border-l-indigo-500 bg-indigo-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-timeline">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-indigo-500" />
                <span className="font-medium">Timeline</span>
                <Badge variant="secondary" className="ml-2">{sortedTimeline.length} items</Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-1">
                {sortedTimeline.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 py-1">
                    <span className="text-sm font-mono font-medium text-primary w-16 shrink-0">{formatTimelineTime(item.offsetFromStartMinutes)}</span>
                    <span className="text-sm flex-1">{item.label}</span>
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {hasPartyDetails && (
          <AccordionItem value="party-details" className="border rounded-lg px-4 border-l-4 border-l-green-500 bg-green-500/5">
            <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-party-details">
              <div className="flex items-center gap-2 w-full">
                <CreditCard className="h-4 w-4 text-green-500" />
                <span className="font-medium">Party Details</span>
                {outstandingBalance > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    ฿{outstandingBalance.toLocaleString()} outstanding
                  </Badge>
                )}
                {outstandingBalance <= 0 && prepaymentReceived > 0 && (
                  <Badge variant="default" className="ml-2 bg-emerald-500">Paid</Badge>
                )}
                <BeoTaskBadge prefix="💰 POS Setup:" label="Mark POS Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="space-y-4">
                {partyDetails.packageName && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">POS</p>
                    <p className="text-sm font-semibold">{partyDetails.packageName}</p>
                    {packageBasePrice > 0 && (
                      <p className="text-xs text-muted-foreground">Base price: ฿{packageBasePrice.toLocaleString()}</p>
                    )}
                  </div>
                )}

                {packageItems.length > 0 && (
                  <div className="space-y-1 border rounded-md p-3 bg-muted/30">
                    {packageItems.map((item: any, idx: number) => (
                      <div key={item.id || idx} className="flex items-center justify-between py-1 text-sm border-b last:border-0">
                        <div className="flex items-center gap-2">
                          <span>{item.label || item.description}</span>
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${item.type === 'included' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-amber-500/10 text-amber-600 border-amber-500/30'}`}>
                            {item.type === "included" ? "INCL" : "EXTRA"}
                          </Badge>
                        </div>
                        {item.type === "extra" && item.price > 0 && (
                          <span className="font-mono text-sm">฿{Number(item.price).toLocaleString()}</span>
                        )}
                      </div>
                    ))}

                    <div className="pt-2 mt-2 border-t space-y-1">
                      {extrasTotal > 0 && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Extras subtotal</span>
                          <span className="font-mono">฿{extrasTotal.toLocaleString()}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>POS Total</span>
                        <span className="font-mono">฿{packageTotal.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {prepaymentReceived > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground">Prepayment Received</p>
                      <p className="text-sm font-medium text-green-600">฿{prepaymentReceived.toLocaleString()}</p>
                      {partyDetails.depositDate && (
                        <p className="text-xs text-muted-foreground">on {partyDetails.depositDate}</p>
                      )}
                    </div>
                  )}
                  {outstandingBalance > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground">Outstanding Balance</p>
                      <p className="text-sm font-medium text-destructive">฿{outstandingBalance.toLocaleString()}</p>
                    </div>
                  )}
                </div>

                {partyDetails.notes && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground">Notes:</p>
                    <p className="text-sm">{partyDetails.notes}</p>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
}
