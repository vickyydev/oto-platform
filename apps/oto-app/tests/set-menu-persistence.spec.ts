// seed: full
import { test, expect, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import {
  beoKitchenPlans,
  beoSetMenuSelections,
  beoSetMenuTemplates,
  branches,
  coreEvents,
  tenants,
} from "../shared/schema";
import { login, testId } from "./helpers";

type MenuLine = {
  id: string;
  itemName: string;
  source?: string;
  groupId?: string;
  quantity?: number;
};

const templateItems = [
  { id: "included_starter", type: "always_included", label: "Fruit platter" },
  {
    id: "main_choice",
    type: "choice_group",
    label: "Choose a main",
    options: ["Pasta", "Pizza"],
    allowMultiple: false,
  },
];

const selections = [{ groupId: "main_choice", chosenOptions: ["Pizza"] }];

async function createEvent(name: string) {
  const [tenant] = await db.select().from(tenants).limit(1);
  const [branch] = await db
    .select()
    .from(branches)
    .where(eq(branches.tenantId, tenant.id))
    .limit(1);
  expect(tenant, "Full seed must include a tenant").toBeTruthy();
  expect(branch, "Full seed must include a branch").toBeTruthy();

  const [event] = await db.insert(coreEvents).values({
    tenantId: tenant.id,
    branchId: branch.id,
    title: name,
    eventDate: "2035-01-15",
    startTime: "10:00",
  }).returning();
  return { event, tenant };
}

async function createTemplate(tenantId: string, name: string) {
  const [template] = await db.insert(beoSetMenuTemplates).values({
    tenantId,
    name,
    items: templateItems,
  }).returning();
  return template;
}

async function createParentLink(page: Page, eventId: string, templateId: string) {
  const response = await page.evaluate(async ({ eventId, templateId }) => {
    const res = await fetch("/api/beo/set-menu-selections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ eventId, templateId }),
    });
    return { status: res.status, body: await res.json() };
  }, { eventId, templateId });
  expect(response.status).toBe(201);
  return response.body as { token: string };
}

async function submitAsParent(page: Page, token: string) {
  const response = await page.evaluate(async ({ token, selections }) => {
    const res = await fetch(`/api/beo/set-menu-selections/public/${token}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections }),
    });
    return { status: res.status, body: await res.json() };
  }, { token, selections });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true });
}

function setMenuLines(items: unknown): MenuLine[] {
  return (Array.isArray(items) ? items : []).filter(
    (item): item is MenuLine => !!item && typeof item === "object" && (item as MenuLine).source === "set_menu",
  );
}

function expectResolvedItems(items: unknown) {
  const resolved = setMenuLines(items);
  expect(resolved).toHaveLength(2);
  expect(resolved.map((item) => item.itemName)).toEqual(["Fruit platter", "Pizza"]);
  expect(resolved.map((item) => item.groupId)).toEqual(["included_starter", "main_choice"]);
}

test("parent set-menu submissions persist both menu representations and cleanup stale choices", async ({ page }) => {
  await login(page);
  const suffix = testId();

  // A new kitchen plan receives every resolved line, including the fixed item's group identity.
  const fresh = await createEvent(`Set Menu Fresh ${suffix}`);
  const freshTemplate = await createTemplate(fresh.tenant.id, `Set Menu Fresh ${suffix}`);
  const freshLink = await createParentLink(page, fresh.event.id, freshTemplate.id);
  await submitAsParent(page, freshLink.token);

  const [freshPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, fresh.event.id));
  expect(freshPlan).toBeTruthy();
  expectResolvedItems((freshPlan!.menus as { kids?: unknown[] }).kids);
  expectResolvedItems((freshPlan!.simplifiedMenus as { kids?: unknown[] }).kids);

  // Existing kids menus retain manual entries and write the same resolved lines to both representations.
  const kids = await createEvent(`Set Menu Kids ${suffix}`);
  const kidsTemplate = await createTemplate(kids.tenant.id, `Set Menu Kids ${suffix}`);
  const manualKids: MenuLine = { id: "manual_kids", itemName: "Manual kids item", source: "additional" };
  await db.insert(beoKitchenPlans).values({
    eventId: kids.event.id,
    menus: { kids: [manualKids], adults: [], kidsFoodTime: "12:00" },
    simplifiedMenus: { kids: [manualKids], adults: [] },
  });
  const kidsLink = await createParentLink(page, kids.event.id, kidsTemplate.id);
  await submitAsParent(page, kidsLink.token);
  const [kidsPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  expectResolvedItems((kidsPlan!.menus as { kids?: unknown[] }).kids);
  expectResolvedItems((kidsPlan!.simplifiedMenus as { kids?: unknown[] }).kids);
  expect((kidsPlan!.menus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("manual_kids");
  expect((kidsPlan!.simplifiedMenus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("manual_kids");
  expect((kidsPlan!.menus as { kidsFoodTime?: string }).kidsFoodTime).toBe("12:00");

  // A stale staff editor payload can add a manual item but cannot erase parent-resolved lines.
  const staffAddedItem: MenuLine = { id: "staff_added", itemName: "Staff-added item", source: "additional" };
  const staleSaveResponse = await page.evaluate(async ({ eventId, manualKids, staffAddedItem }) => {
    const res = await fetch(`/api/events/${eventId}/beo/kitchen-plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        menus: { kids: [manualKids, staffAddedItem], adults: [], kidsFoodTime: "12:30" },
        simplifiedMenus: { kids: [manualKids, staffAddedItem], adults: [] },
      }),
    });
    return { status: res.status, body: await res.json() };
  }, { eventId: kids.event.id, manualKids, staffAddedItem });
  expect(staleSaveResponse.status).toBe(200);

  const [staleSavePlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  expectResolvedItems((staleSavePlan!.menus as { kids?: unknown[] }).kids);
  expectResolvedItems((staleSavePlan!.simplifiedMenus as { kids?: unknown[] }).kids);
  expect((staleSavePlan!.menus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("staff_added");
  expect((staleSavePlan!.simplifiedMenus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("staff_added");

  const fullBeoStaffItem: MenuLine = { id: "full_beo_staff_added", itemName: "Full BEO staff item", source: "additional" };
  const staleFullBeoSaveResponse = await page.evaluate(async ({ eventId, templateId, manualKids, fullBeoStaffItem }) => {
    const res = await fetch(`/api/events/${eventId}/beo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        kitchenPlan: {
          foodRequired: true,
          setMenuEnabled: true,
          setMenuTemplateId: templateId,
          menus: { kids: [manualKids, fullBeoStaffItem], adults: [], kidsFoodTime: "13:00" },
          simplifiedMenus: { kids: [manualKids, fullBeoStaffItem], adults: [] },
        },
      }),
    });
    return { status: res.status, body: await res.json() };
  }, {
    eventId: kids.event.id,
    templateId: kidsTemplate.id,
    manualKids,
    fullBeoStaffItem,
  });
  expect(staleFullBeoSaveResponse.status).toBe(200);

  const [staleFullBeoPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  expectResolvedItems((staleFullBeoPlan!.menus as { kids?: unknown[] }).kids);
  expectResolvedItems((staleFullBeoPlan!.simplifiedMenus as { kids?: unknown[] }).kids);
  expect((staleFullBeoPlan!.menus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("full_beo_staff_added");
  expect((staleFullBeoPlan!.simplifiedMenus as { kids: MenuLine[] }).kids.map((item) => item.id)).toContain("full_beo_staff_added");

  // Adults-only events write choices to adults without disturbing the empty kids menu.
  const adults = await createEvent(`Set Menu Adults ${suffix}`);
  const adultsTemplate = await createTemplate(adults.tenant.id, `Set Menu Adults ${suffix}`);
  const manualAdults: MenuLine = { id: "manual_adults", itemName: "Manual adult item", source: "additional" };
  await db.insert(beoKitchenPlans).values({
    eventId: adults.event.id,
    menus: { kids: [], adults: [manualAdults] },
    simplifiedMenus: { kids: [], adults: [manualAdults] },
  });
  const adultsLink = await createParentLink(page, adults.event.id, adultsTemplate.id);
  await submitAsParent(page, adultsLink.token);
  const [adultsPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, adults.event.id));
  expectResolvedItems((adultsPlan!.menus as { adults?: unknown[] }).adults);
  expectResolvedItems((adultsPlan!.simplifiedMenus as { adults?: unknown[] }).adults);
  expect((adultsPlan!.menus as { adults: MenuLine[] }).adults.map((item) => item.id)).toContain("manual_adults");

  // Reset and regenerated links clear stale set-menu lines in both buckets while retaining manual items.
  const staleSetLine: MenuLine = { id: "stale_set", itemName: "Stale selection", source: "set_menu", groupId: "old_group" };
  await db.update(beoKitchenPlans)
    .set({
      menus: { kids: [manualKids, staleSetLine], adults: [manualAdults, staleSetLine] },
      simplifiedMenus: { kids: [manualKids, staleSetLine], adults: [manualAdults, staleSetLine] },
    })
    .where(eq(beoKitchenPlans.eventId, kids.event.id));

  const resetResponse = await page.evaluate(async (eventId) => {
    const res = await fetch(`/api/beo/set-menu-selections/${eventId}/reset`, {
      method: "POST",
      credentials: "include",
    });
    return { status: res.status, body: await res.json() };
  }, kids.event.id);
  expect(resetResponse.status).toBe(200);

  const [resetPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  for (const menuData of [resetPlan!.menus, resetPlan!.simplifiedMenus]) {
    const menus = menuData as { kids: MenuLine[]; adults: MenuLine[] };
    expect(setMenuLines(menus.kids)).toEqual([]);
    expect(setMenuLines(menus.adults)).toEqual([]);
    expect(menus.kids.map((item) => item.id)).toContain("manual_kids");
    expect(menus.adults.map((item) => item.id)).toContain("manual_adults");
  }

  await db.update(beoKitchenPlans)
    .set({
      menus: { kids: [manualKids, staleSetLine], adults: [manualAdults, staleSetLine] },
      simplifiedMenus: { kids: [manualKids, staleSetLine], adults: [manualAdults, staleSetLine] },
    })
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  await createParentLink(page, kids.event.id, kidsTemplate.id);

  const [regeneratedPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, kids.event.id));
  for (const menuData of [regeneratedPlan!.menus, regeneratedPlan!.simplifiedMenus]) {
    const menus = menuData as { kids: MenuLine[]; adults: MenuLine[] };
    expect(setMenuLines(menus.kids)).toEqual([]);
    expect(setMenuLines(menus.adults)).toEqual([]);
    expect(menus.kids.map((item) => item.id)).toContain("manual_kids");
    expect(menus.adults.map((item) => item.id)).toContain("manual_adults");
  }

  const [selection] = await db.select().from(beoSetMenuSelections)
    .where(and(
      eq(beoSetMenuSelections.eventId, kids.event.id),
      eq(beoSetMenuSelections.templateId, kidsTemplate.id),
    ));
  expect(selection?.isSubmitted).toBe(false);
});