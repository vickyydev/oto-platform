// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

test("parent set-menu choices retain their groups and refresh the staff BEO response", async ({ page, browser }) => {
  await login(page);
  const suffix = testId();

  const setup = await page.evaluate(async ({ suffix }) => {
    const request = async (url: string, method = "GET", body?: unknown) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const branches = await request("/api/branches");
    const branch = branches.body.find((item: { name: string }) => item.name === "Bangkok") ?? branches.body[0];
    const event = await request("/api/admin/events", "POST", {
      branchId: branch.id,
      eventType: "birthday",
      title: `Set Menu Refresh ${suffix}`,
      eventDate: "2031-01-20",
      startTime: "14:00",
      endTime: "16:00",
      childName: `Child ${suffix}`,
      bookingName: `Parent ${suffix}`,
      parentName: `Parent ${suffix}`,
      whatsappPhoneRaw: "0810000000",
      numChildren: 12,
      numAdults: 4,
      status: "upcoming",
    });

    const template = await request("/api/beo/set-menu-templates", "POST", {
      name: `Refresh Menu ${suffix}`,
      items: [
        { id: "fixed-main", type: "always_included", label: "Fruit platter" },
        { id: "drink-choice", type: "choice_group", label: "Choose a drink", options: ["Water", "Juice"], allowMultiple: false },
        { id: "side-choice", type: "choice_group", label: "Choose sides", options: ["Fries", "Salad"], allowMultiple: true },
      ],
    });

    const kitchenPlan = await request(`/api/events/${event.body.id}/beo`, "PUT", {
      kitchenPlan: {
        foodRequired: true,
        setMenuEnabled: true,
        setMenuTemplateId: template.body.id,
        simplifiedMenus: {
          kids: [{ id: "stale-kids", itemName: "Stale kids choice", quantity: 1, notes: "", included: true, price: 0, source: "set_menu" }],
          adults: [{ id: "stale-adults", itemName: "Stale adults choice", quantity: 1, notes: "", included: true, price: 0, source: "set_menu" }],
        },
        menus: {
          kids: [{ id: "extra-kids", itemName: "Birthday candles", quantity: 1, notes: "", included: false, price: 0, source: "additional" }],
          adults: [{ id: "extra-adults", itemName: "Coffee", quantity: 1, notes: "", included: false, price: 0, source: "additional" }],
          kidsFoodTime: "",
          adultsFoodTime: "",
        },
      },
    });

    const selection = await request("/api/beo/set-menu-selections", "POST", {
      eventId: event.body.id,
      templateId: template.body.id,
    });

    return { event, template, kitchenPlan, selection };
  }, { suffix });

  expect(setup.event.status, JSON.stringify(setup.event.body)).toBe(201);
  expect(setup.template.status, JSON.stringify(setup.template.body)).toBe(201);
  expect(setup.kitchenPlan.status, JSON.stringify(setup.kitchenPlan.body)).toBe(200);
  expect(setup.selection.status, JSON.stringify(setup.selection.body)).toBe(201);

  const staffBeforeSubmit = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(staffBeforeSubmit.kitchenPlan.setMenuSelectionStatus.isSubmitted).toBe(false);
  expect(staffBeforeSubmit.kitchenPlan.setMenuTemplate.name).toBe(setup.template.body.name);
  await page.goto(`/core/events/${setup.event.body.id}`);
  await expect(page.getByTestId("section-kitchen-plan")).toBeVisible();
  await page.getByTestId("button-toggle-kitchen-plan").click();

  const parentContext = await browser.newContext();
  const parentPage = await parentContext.newPage();
  await parentPage.goto(`/menu-select/${setup.selection.body.token}`);
  await expect(parentPage.getByText(setup.template.body.name)).toBeVisible();
  await parentPage.getByLabel("Juice").check();
  await parentPage.getByLabel("Fries").check();
  await parentPage.getByLabel("Salad").check();
  await parentPage.getByTestId("button-submit-menu-selections").click();
  await expect(parentPage.getByText("Selections Received!")).toBeVisible();
  await parentContext.close();

  // The open Day-of staff view polls the lightweight selection status, then
  // refreshes its BEO data without a manual page reload.
  await expect(page.getByTestId("day-of-set-menu-group-drink-choice")).toContainText("Juice", { timeout: 12_000 });
  await expect(page.getByTestId("day-of-set-menu-group-side-choice")).toContainText("Fries, Salad");
  await expect(page.getByTestId("day-of-set-menu-fixed-items")).toContainText("Fruit platter");
  await expect(page.getByTestId("menu-item-kids-0")).toContainText("Birthday candles");
  await expect(page.getByTestId("menu-item-kids-0").getByText("EXTRA")).toBeVisible();

  await expect.poll(async () => {
    return page.evaluate(async (eventId) => {
      const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
      const data = await response.json();
      return data.kitchenPlan.setMenuSelectionStatus.isSubmitted;
    }, setup.event.body.id);
  }).toBe(true);

  const staffAfterSubmit = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  const resolvedItems = staffAfterSubmit.kitchenPlan.menus.kids;
  expect(resolvedItems).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Stale kids choice" }),
  ]));
  expect(resolvedItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Fruit platter", source: "set_menu", groupId: "fixed-main" }),
    expect.objectContaining({ itemName: "Juice", source: "set_menu", groupId: "drink-choice" }),
    expect.objectContaining({ itemName: "Fries", source: "set_menu", groupId: "side-choice" }),
    expect.objectContaining({ itemName: "Salad", source: "set_menu", groupId: "side-choice" }),
    expect.objectContaining({ itemName: "Birthday candles", source: "additional" }),
  ]));
  expect(staffAfterSubmit.kitchenPlan.menus.adults).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Coffee", source: "additional" }),
  ]));

  const staffSave = await page.evaluate(async ({ eventId, templateId, menus }) => {
    const response = await fetch(`/api/events/${eventId}/beo`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kitchenPlan: {
          foodRequired: true,
          setMenuEnabled: true,
          setMenuTemplateId: templateId,
          setMenuSelectionSubmittedAt: null,
          menus: {
            ...menus,
            // This is intentionally stale: the normal editor save lacks the
            // parent-resolved rows, and the server must preserve those rows.
            kids: [
              { id: "extra-kids", itemName: "Birthday candles", quantity: 1, notes: "", included: false, price: 0, source: "additional" },
              { id: "extra-napkins", itemName: "Extra napkins", quantity: 1, notes: "", included: false, price: 0, source: "additional" },
            ],
            adults: [{ id: "extra-adults", itemName: "Coffee", quantity: 1, notes: "", included: false, price: 0, source: "additional" }],
          },
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { eventId: setup.event.body.id, templateId: setup.template.body.id, menus: staffAfterSubmit.kitchenPlan.menus });
  expect(staffSave.status, JSON.stringify(staffSave.body)).toBe(200);

  const afterStaffSave = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(afterStaffSave.kitchenPlan.menus.kids).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Juice", source: "set_menu", groupId: "drink-choice" }),
    expect.objectContaining({ itemName: "Fries", source: "set_menu", groupId: "side-choice" }),
    expect.objectContaining({ itemName: "Salad", source: "set_menu", groupId: "side-choice" }),
    expect.objectContaining({ itemName: "Extra napkins", source: "additional" }),
  ]));

  const managerOverride = await page.evaluate(async ({ eventId, templateId, menus, submittedAt }) => {
    const response = await fetch(`/api/events/${eventId}/beo`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kitchenPlan: {
          foodRequired: true,
          setMenuEnabled: true,
          setMenuTemplateId: templateId,
          setMenuSelectionSubmittedAt: submittedAt,
          menus: {
            ...menus,
            kids: menus.kids.map((item: any) =>
              item.source === "set_menu" && item.groupId === "drink-choice"
                ? { ...item, itemName: "Sparkling water" }
                : item,
            ),
          },
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    eventId: setup.event.body.id,
    templateId: setup.template.body.id,
    menus: afterStaffSave.kitchenPlan.menus,
    submittedAt: afterStaffSave.kitchenPlan.setMenuSelectionStatus.submittedAt,
  });
  expect(managerOverride.status, JSON.stringify(managerOverride.body)).toBe(200);

  const afterManagerOverride = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(afterManagerOverride.kitchenPlan.menus.kids).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Fruit platter", source: "set_menu", groupId: "fixed-main" }),
    expect.objectContaining({ itemName: "Sparkling water", source: "set_menu", groupId: "drink-choice" }),
    expect.objectContaining({ itemName: "Fries", source: "set_menu", groupId: "side-choice" }),
    expect.objectContaining({ itemName: "Salad", source: "set_menu", groupId: "side-choice" }),
  ]));

  const convertResolvedItemsToExtras = await page.evaluate(async ({ eventId, templateId, menus, submittedAt }) => {
    const response = await fetch(`/api/events/${eventId}/beo`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kitchenPlan: {
          foodRequired: true,
          setMenuEnabled: true,
          setMenuTemplateId: templateId,
          setMenuSelectionSubmittedAt: submittedAt,
          menus: {
            ...menus,
            kids: menus.kids.map((item: any) =>
              item.source === "set_menu" ? { ...item, source: "additional" } : item,
            ),
          },
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    eventId: setup.event.body.id,
    templateId: setup.template.body.id,
    menus: afterManagerOverride.kitchenPlan.menus,
    submittedAt: afterManagerOverride.kitchenPlan.setMenuSelectionStatus.submittedAt,
  });
  expect(convertResolvedItemsToExtras.status, JSON.stringify(convertResolvedItemsToExtras.body)).toBe(200);

  const afterConversion = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(afterConversion.kitchenPlan.menus.kids.filter((item: any) => item.source === "set_menu")).toEqual([]);
  expect(afterConversion.kitchenPlan.menus.kids).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Fruit platter", source: "additional", groupId: "fixed-main" }),
    expect.objectContaining({ itemName: "Sparkling water", source: "additional", groupId: "drink-choice" }),
  ]));

  const deleteAllResolvedItems = await page.evaluate(async ({ eventId, templateId, menus, submittedAt }) => {
    const response = await fetch(`/api/events/${eventId}/beo`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kitchenPlan: {
          foodRequired: true,
          setMenuEnabled: true,
          setMenuTemplateId: templateId,
          setMenuSelectionSubmittedAt: submittedAt,
          menus: {
            ...menus,
            kids: menus.kids.filter((item: any) =>
              !["fixed-main", "drink-choice", "side-choice"].includes(item.groupId),
            ),
          },
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    eventId: setup.event.body.id,
    templateId: setup.template.body.id,
    menus: afterConversion.kitchenPlan.menus,
    submittedAt: afterConversion.kitchenPlan.setMenuSelectionStatus.submittedAt,
  });
  expect(deleteAllResolvedItems.status, JSON.stringify(deleteAllResolvedItems.body)).toBe(200);

  const afterDeletion = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(afterDeletion.kitchenPlan.menus.kids).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Fruit platter" }),
    expect.objectContaining({ itemName: "Sparkling water" }),
    expect.objectContaining({ itemName: "Fries" }),
    expect.objectContaining({ itemName: "Salad" }),
  ]));

  const reset = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/beo/set-menu-selections/${eventId}/reset`, {
      method: "POST",
      credentials: "include",
    });
    return { status: response.status, body: await response.json() };
  }, setup.event.body.id);
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);

  const afterReset = await page.evaluate(async (eventId) => {
    const response = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
    return response.json();
  }, setup.event.body.id);
  expect(afterReset.kitchenPlan.menus.kids).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemName: "Birthday candles", source: "additional" }),
    expect.objectContaining({ itemName: "Extra napkins", source: "additional" }),
  ]));
  expect(afterReset.kitchenPlan.menus.adults).toEqual([
    expect.objectContaining({ itemName: "Coffee", source: "additional" }),
  ]);

  const regenerated = await page.evaluate(async ({ eventId, templateId }) => {
    const response = await fetch("/api/beo/set-menu-selections", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, templateId }),
    });
    return { status: response.status, body: await response.json() };
  }, { eventId: setup.event.body.id, templateId: setup.template.body.id });
  expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(201);
});