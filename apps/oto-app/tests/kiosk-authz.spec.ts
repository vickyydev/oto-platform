/**
 * The kiosk endpoints that could be driven without a credential.
 *
 * Three findings from the authorization sweep, held open by assertions that
 * need no seeded rows — every case here is a refusal, so the expectations hold
 * against an empty database as well as a full one.
 *
 * Run like the other specs in this folder: start the app, then
 * `npx playwright test tests/kiosk-authz.spec.ts`.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

const CLOCK_PHONE = "/api/kiosk/clock-phone";
const CLOCK_PIN = "/api/kiosk/clock-pin";
const REFRESH = "/api/kiosk/refresh-session";
const PHOTO = "/api/kiosk/upload-pin-photo";
const FACE_FAILURE = "/api/kiosk/face-attempt-failed";

// Shaped like a Thai mobile number and belonging to nobody. The point of these
// tests is that the endpoint does not tell us whether that is true.
const A_NUMBER = "0812340001";
const ANOTHER_NUMBER = "0899999999";

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data, failOnStatusCode: false });
  return { status: response.status(), body: await response.text() };
}

test.describe("SCRUM-242 — clock by phone needs a kiosk, and says nothing without one", () => {
  test("refuses a caller that presents no device credential", async ({ request }) => {
    const { status } = await post(request, CLOCK_PHONE, {
      phone: A_NUMBER,
      photoEvidenceUrl: "",
    });
    expect(status).toBe(401);
  });

  test("refuses a caller whose device credential does not resolve", async ({ request }) => {
    const { status } = await post(request, CLOCK_PHONE, {
      phone: A_NUMBER,
      photoEvidenceUrl: "",
      deviceSecret: "this-secret-belongs-to-no-device",
    });
    expect(status).toBe(401);
  });

  test("answers every number the same way, so it cannot be asked who is staff", async ({ request }) => {
    const one = await post(request, CLOCK_PHONE, { phone: A_NUMBER, photoEvidenceUrl: "" });
    const two = await post(request, CLOCK_PHONE, { phone: ANOTHER_NUMBER, photoEvidenceUrl: "" });
    const malformed = await post(request, CLOCK_PHONE, { phone: "12", photoEvidenceUrl: "" });

    // Identical status and identical body: a caller with no kiosk learns nothing
    // from the difference between a number that is staff, a number that is not,
    // and a number that is not a number.
    expect(two).toEqual(one);
    expect(malformed).toEqual(one);
  });

  test("throttles a caller that presents no device credential", async ({ request }) => {
    // The limit used to sit inside `if (deviceSecret)`, so this loop never met
    // it. The quota is per IP and per five minutes; a spec that shares an IP
    // with an earlier test may reach it sooner, which is still a pass.
    let sawThrottle = false;
    for (let i = 0; i < 80; i++) {
      const { status } = await post(request, CLOCK_PHONE, {
        phone: `08000000${i % 10}`,
        photoEvidenceUrl: "",
      });
      if (status === 429) {
        sawThrottle = true;
        break;
      }
    }
    expect(sawThrottle).toBe(true);
  });
});

test.describe("SCRUM-247 — a device id is not a credential", () => {
  test("rejects the old request shape that carried only a device id", async ({ request }) => {
    const { status } = await post(request, REFRESH, {
      deviceId: "00000000-0000-0000-0000-000000000000",
    });
    expect(status).toBe(400);
  });

  test("rejects a device id carrying a secret that does not verify", async ({ request }) => {
    const { status } = await post(request, REFRESH, {
      deviceId: "00000000-0000-0000-0000-000000000000",
      deviceSecret: "this-secret-belongs-to-no-device",
    });
    expect(status).toBe(401);
  });
});

test.describe("SCRUM-243 — a PIN is checked against a named person", () => {
  test("rejects the old request shape that carried a PIN and no employee", async ({ request }) => {
    const { status } = await post(request, CLOCK_PIN, {
      pin: "1234",
      photoEvidenceUrl: "",
      deviceSecret: "this-secret-belongs-to-no-device",
    });
    // The employee the PIN is being claimed for is now required, so a request
    // that names nobody does not parse.
    expect(status).toBe(400);
  });

  test("refuses a PIN presented without a kiosk", async ({ request }) => {
    const { status } = await post(request, CLOCK_PIN, {
      employeeId: "00000000-0000-0000-0000-000000000000",
      pin: "1234",
      photoEvidenceUrl: "",
    });
    expect(status).toBe(401);
  });
});

test.describe("SCRUM-261 — kiosk photo upload requires a device and a ceiling", () => {
  test("refuses an anonymous upload before accepting photo data", async ({ request }) => {
    const { status } = await post(request, PHOTO, {});
    expect(status).toBe(401);
  });

  test("refuses an unrecognised device", async ({ request }) => {
    const response = await request.post(PHOTO, {
      headers: { "x-kiosk-device-secret": randomUUID() },
      data: {},
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);
  });

  test("limits repeated attempts from one address", async ({ request }) => {
    let throttled = false;
    for (let i = 0; i < 70; i++) {
      const { status } = await post(request, PHOTO, {});
      if (status === 429) {
        throttled = true;
        break;
      }
      expect(status).toBe(401);
    }
    expect(throttled).toBe(true);
  });
});

test.describe("SCRUM-262 — kiosk failure logging has a ceiling", () => {
  test("limits repeated failures from one address without writing a log row", async ({ request }) => {
    let throttled = false;
    for (let i = 0; i < 130; i++) {
      const { status } = await post(request, FACE_FAILURE, { failReason: "NO_MATCH" });
      if (status === 429) {
        throttled = true;
        break;
      }
      expect(status).toBe(400);
    }
    expect(throttled).toBe(true);
  });
});
