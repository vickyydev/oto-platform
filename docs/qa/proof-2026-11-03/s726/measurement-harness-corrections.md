# SCRUM-726 measurement corrections

Recorded 2026-11-03T02:16:58.945Z. No product source change.

- The second native order tried to click F&B, but the active tab is a span. The harness now navigates only when outside /order-station. The earlier first sale remains independently reconciled; the next payment was never pressed.
- A separate short rehearsal timed an order before its new display pairing finished. The rehearsal now uses the load setup's 20-second warm-up and requires three open server streams before measurement. The one-second display guard remains unchanged. Three successive native cash orders pass, with display updates 451, 337, 337 ms.
- Render returned HTTP 429. Its live response headers state a 30-request limit. The five metric types now each request all relevant resources, reducing 13 calls/window to five. Resource IDs come from exact returned labels; a malformed label or missing fresh value stops. CPU series are retained per resource rather than aggregated across resources. A 20-second cache avoids duplicate setup reads while the steady schedule remains every minute. Rate-limit headers are retained and retry waits respect the reported reset within the bounded deadline.
- Stopped setup/ramp receipts and the corresponding manifests remain alongside the new proof. No application POST/PATCH/DELETE is retried. Unknown sales and every original quiet/resource/error threshold still stop the run.

References: [Render metric resource filters](https://api-docs.render.com/reference/get-cpu), [Render rate-limit guidance](https://api-docs.render.com/reference/rate-limiting). The actual observed response headers are in batched-metric-labels.json; they take precedence over a generic published quota.
