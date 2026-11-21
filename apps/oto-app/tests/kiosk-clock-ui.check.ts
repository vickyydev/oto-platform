// Run with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json from apps/oto-app.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/kiosk/test" });
const { window } = dom;
for (const key of ["window", "document", "navigator", "location", "localStorage", "HTMLElement"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(navigator, "mediaDevices", {
  value: { getUserMedia: async () => ({ getTracks: () => [] }) },
});
window.HTMLMediaElement.prototype.play = async () => {};
Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
  value: () => ({ drawImage() {} }),
});
window.HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob(["test"], { type: "image/jpeg" }));

const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: KioskPage } = await import("../client/src/pages/kiosk-page");
async function checkClock(faceClockInEnabled?: boolean, tabletRegistered?: boolean) {
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  const branch = { name: "ZZ TEST", faceClockInEnabled, tabletRegistered };
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json(branch);
  };
  client.setQueryData(["/api/public/branches/test"], branch);
  const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  try {
    await act(async () => root.render(h(QueryClientProvider, { client }, h(KioskPage, { branchId: "test" }))));
    if (tabletRegistered === false) {
      assert.match(container.textContent!, /Register this time clock/);
      assert.equal(button("button-clock-in-out"), null);
      return;
    }
    await act(async () => button("button-clock-in-out")!.click());
    if (faceClockInEnabled === false) {
      assert.match(container.textContent!, /Take a photo, then enter your phone number\./);
      assert.equal(button("button-capture-face"), null);
      assert.equal(button("input-phone"), null);
      await act(async () => button("button-capture-photo")!.click());
      assert.ok(button("input-phone"));
    } else {
      assert.ok(button("button-capture-face"));
      assert.equal(button("button-capture-photo"), null);
    }
    assert.deepEqual(requests, ["/api/public/branches/test"]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
}

try {
  await checkClock(false, false);
  await checkClock(false, true);
  await checkClock(true, true);
  await checkClock();
  console.log("Kiosk clock UI: off, on and older branch replies passed");
} finally {
  window.close();
}
