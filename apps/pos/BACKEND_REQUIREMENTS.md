# Backend Requirements

This document lists the real-backend capabilities that this front-end prototype mocks.
The seams are the exported functions in `src/mockApi.ts` — swap each one for a real API call.

---

## WhatsApp Business connection check (drop-off registrations)

### What the prototype mocks

When a drop-off registration captures a parent's WhatsApp number (both the online-booking path and the walk-in/door path), the POS auto-sends a connection-check message and tracks whether the channel is verified and working:

- `waConnection.status`:
  - `pending` — confirmation template sent; waiting for the parent to tap "Confirm received"
  - `confirmed` — parent tapped the quick-reply button (inbound webhook received)
  - `failed` — staff marked the number unreachable

The "Sim: parent confirms" button on the drop-off board simulates the parent tapping the button; in production this is driven by the BSP's inbound webhook.

### What a real implementation needs

1. **Meta-approved button template.**
   The connection-check message uses a WhatsApp interactive message with a quick-reply button ("Confirm received ✓").  
   This requires a Meta-approved **button template** (`category: UTILITY` or `AUTHENTICATION`) submitted and approved through the WhatsApp Business Manager before it can be sent.  
   Free-text messages cannot carry buttons; the button payload is part of the template definition.

2. **BSP (Business Solution Provider) integration.**
   Sending the template requires an approved WhatsApp BSP (e.g. Twilio, MessageBird, Vonage, Meta Cloud API).  
   The API call must include: the approved template namespace/name, the language code, and the variable values (`parentName`, `childName`).

3. **Inbound webhook to receive the parent's button tap.**
   When the parent taps "Confirm received ✓", WhatsApp delivers an inbound event to the BSP's webhook endpoint.  
   The backend must:
   - Verify the webhook signature (HMAC-SHA256 with the BSP secret).
   - Parse the `interactive.button_reply.id` (`"confirm"`) from the event payload.
   - Match the sender's phone number to the registration (normalized, stripping spaces and leading `+`).
   - Set `waConnection.status = 'confirmed'` and `confirmedAt = now` on the matching CheckIn.

4. **Parent opt-in (WhatsApp policy requirement).**
   WhatsApp Business Policy requires that users have opted in to receive proactive messages from a business.  
   The online booking form must collect explicit opt-in consent before the confirmation template is sent.  
   Opt-in must be recorded (timestamp + method) and surfaced to Meta if audited.

5. **24-hour session window rule.**
   WhatsApp only allows approved templates outside an open 24-hour customer-service window.  
   Within 24 hours of a parent's last inbound message, free-text is allowed.  
   Outside the window, only approved templates can be sent (the connection-check template satisfies this).  
   The backend should track the last inbound message timestamp per phone to gate free-text vs template sends.

6. **Delivery status webhooks.**
   The BSP delivers delivery-status events (`sent → delivered → read → failed`) via webhook.  
   The backend should update `WaMessage.status` in real time so the in-app thread stays accurate.  
   A `failed` delivery status on the connection-check message should surface in the POS as a prompt to resend.

7. **Phone normalization.**
   Phones must be stored and compared in E.164 format (`+66818953926`) — strip spaces, dashes, and leading zeros, prepend country code.  
   The prototype normalizes with `phone.replace(/\D/g, '')` (digits only); the real backend should use a libphonenumber-compliant normalizer.

### mockApi seam functions to swap

| Mock function | Real replacement |
|---|---|
| `sendWhatsAppMessage` | BSP REST API call (POST template message) |
| `simulateWaConfirm` | Remove — replaced by the inbound-webhook handler |
| `resendWaConfirmation` | Re-send the same template via BSP API |
| `markWaConnectionFailed` | Staff action (no external call; sets local status) |
| `updateMessageStatus` | Called from the delivery-status webhook handler |

---

## Other mocked seams (pre-existing)

- All ticket / F&B / party / member data — swap `getCheckIns`, `recordSale`, etc. for REST/GraphQL calls.
- Nanny roster — sourced from HR scheduling; `getNannyRoster` is the seam.
- Member tier verification — `verifyMemberTier` / `getMemberByPhone` are the seams.

---

## Saved child profiles (phone-keyed pre-fill) — PRIVACY-SENSITIVE

### What the prototype mocks

To save returning families re-typing, the till and the online `/book` flow save a
member's children against their phone number on the first drop-off / nanny capture,
then OFFER those details to pre-fill the child form on the next visit (the parent
re-confirms or edits each one — nothing is applied silently).

- Data model: `SavedChild` on `Member.savedChildren` (`src/types.ts`) — child name,
  age, allergies/medical, dietary, food restrictions, notes, plus `savedAt` /
  `updatedAt` / `savedBy` audit stamps.
- Seams (`src/mockApi.ts`): `getSavedChildren`, `addSavedChild`, `updateSavedChild`,
  `removeSavedChild` — in-memory only, **reset on reload** (no browser storage).
- The **child photo is NEVER saved** — it is re-taken every visit. Consent and the
  supervision policy also run **every visit**; saved fields only pre-fill the form,
  they are never inherited as a prior decision.

### Privacy / in-memory flag

This stores **children's personal data keyed by a phone number**. In the prototype
it is a convenience held in React memory that disappears on reload — there is no
persistence, encryption, or access control. **A real backend MUST NOT persist any
of this without first adding:**

1. **Explicit, recorded consent** to store a child's profile for reuse — separate
   from the per-visit liability consent, revocable, with the consent version /
   timestamp stored alongside the record.
2. **Retention limits & deletion** — a defined retention window, automatic purge,
   and an honoured parent request to delete a child or the whole profile
   (`removeSavedChild` is the seam; it must hard-delete, not soft-flag).
3. **Access control & audit** — restrict who can read saved children, log reads as
   well as writes (`savedBy` is the write stamp seam), and scope by branch/market.
4. **Minimisation** — store only what genuinely speeds re-entry; never store the
   photo or biometric data against the profile.
5. **Phone normalization** — key on E.164 (see the phone-normalization note above)
   so the same family resolves consistently across visits and channels.

### mockApi seam functions to swap

| Mock function | Real replacement |
|---|---|
| `getSavedChildren` | Fetch the member's saved children (access-controlled) |
| `addSavedChild` | Persist a new child profile (after consent recorded) |
| `updateSavedChild` | Update an existing child profile (audit the edit) |
| `removeSavedChild` | Hard-delete a child profile (honour parent deletion requests) |
