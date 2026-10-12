import assert from "node:assert/strict";
import { createServer } from "node:http";
import { attendanceEvidenceUpload, attendanceConfirmationBody } from "../server/attendance-evidence-upload";

// Actual multipart parser, isolated from all identity/clock routes and storage.
// Never enable the app's face switch to exercise attendance evidence.
let accepted = 0;
const parse = attendanceConfirmationBody(attendanceEvidenceUpload, () => true, {});
const disabled = attendanceConfirmationBody(attendanceEvidenceUpload, () => false, { message: "Unavailable" });
const server = createServer((req, res) => {
  const request = Object.assign(req, { is: () => true });
  const response = Object.assign(res, {
    status(code: number) { res.statusCode = code; return response; },
    json(body: unknown) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); },
  });
  (req.url === "/disabled" ? disabled : parse)(request as never, response as never, () => {
    accepted++;
    const body = request as typeof request & { body: object; file?: { size: number } };
    response.json({ payload: body.body, size: body.file?.size });
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const payload = { employeeId: "employee-a", confidenceScore: 80 };
  const form = (size = 8, type = "application/pdf", extra = false) => {
    const body = new FormData();
    body.append("payload", JSON.stringify(payload));
    body.append("file", new Blob([new Uint8Array(size)], { type }), "ZZ TEST proof.pdf");
    if (extra) body.append("file", new Blob(["extra"], { type }), "ZZ TEST second.pdf");
    return body;
  };
  const send = (body: FormData, route = "/parse-only") => fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", body });
  const valid = await send(form());
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { payload, size: 8 });
  assert.equal((await send(form(8, "application/pdf", true))).status, 400);
  assert.equal((await send(form(10 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await send(form(8, "text/html"))).status, 400);
  assert.equal((await send(form(0))).status, 400);
  for (const value of ["{", "null", "[]", '"text"']) {
    const malformed = new FormData();
    malformed.append("payload", value);
    assert.equal((await send(malformed)).status, 400);
  }
  // The disabled response wins even over an otherwise oversized upload.
  assert.equal((await send(form(10 * 1024 * 1024 + 1), "/disabled")).status, 403);
  assert.equal(accepted, 1);

  let parsed = 0;
  let continued = 0;
  const jsonRequest = { is: () => false, body: payload };
  const jsonOnly = attendanceConfirmationBody(() => { parsed++; }, () => true, {});
  jsonOnly(jsonRequest as never, {} as never, () => { continued++; });
  assert.equal(parsed, 0);
  assert.equal(continued, 1);
  assert.deepEqual(jsonRequest.body, payload);
  console.log("PASS: valid multipart, extra-file/size/type/empty/malformed refusals, disabled-first refusal and unchanged JSON confirmation.");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
