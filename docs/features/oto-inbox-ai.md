# Inbox AI — the park's assistant, specified

**Status:** specification, confirmed by the owner 2026-10-20. Phase 1 (the
Inbox rails, Cut B) is building under SCRUM-220; Phase 2 is SCRUM-590;
Phase 3 is SCRUM-591. The build plan for the rails is
`docs/progress/plans/inbox-build/PLAN.md`; the Inbox's own rules are
`docs/features/inbox.md`. This document holds what the AI layers must be.

## 1. What the owner asked for, in their own terms

The Inbox is the front door for the whole organization — customer queries
from WhatsApp, Instagram, Facebook and the booking sites all land in it.
An AI answers customers first, and **the customer must never sense it is
AI**: the answers read exactly as a real Thai customer-support agent would
write them. Later, the same assistant serves the park's own people —
admins, managers, staff — fetching information and shortcuts on request,
**revealing only what the asker's role permits**, and it gets smarter over
time as the park's data grows. The Anthropic and Twilio keys already live
in the environment.

## 2. Phase 2 — the customer assistant (SCRUM-590)

**Voice.** One persona per language: a warm, natural Thai support agent
(Thai first; English and Russian equally human). Concretely: short
conversational sentences, the park's own phrasing and politeness particles
in Thai, occasional natural imperfection over corporate polish, no
robotic structure, no "as an AI", no instant-wall-of-text replies —
pacing and tone like a person at the reception desk. Customer-side there
is no AI label of any kind; **staff-side every AI message stays labelled**
(the prototype's indigo "AI Assistant" chip), so the team always knows
who wrote what.

**Scope — answers end to end** (from the park's brief): greetings,
opening hours, address, directions and parking, standard ticket prices,
age rules, the socks policy, "what is OTO Play Park", the approved FAQ,
sending the birthday brochure. **Hands over with a holding line** (sent
as a normal human-sounding message): birthdays and party sales, events
and groups, discounts and negotiation, custom requests, complaints,
unclear or emotional messages, influencer and marketing requests, nanny
booking, lost items, special tickets — exactly the brief's list. It never
quotes custom prices, never confirms or holds a date, never promises
refunds or compensation, never argues a complaint.

**Mechanics.** Anthropic API (the key already in env): language
detection, intent classification and the reply in one pass where
possible; the park knowledge base (hours, prices, policies, brochures —
maintained by marketing per the brief) retrieved into context; the
conversation's own history as memory. Every AI reply and every handover
is audited (action and message id, never bodies into logs). **Failure is
silence, not nonsense:** if the API is down, slow, or the model is
uncertain, the thread simply waits for a person — the human rails built
in Phase 1 ARE the fallback. Out-of-hours behaviour follows the brief
(the hours reply, then the conversation waits).

**Compliance record** (raised 2026-10-20, the owner directed the
human-voice posture): Meta's business messaging policies require
disclosing automated experiences where not obvious, and several markets'
consumer rules trend the same way. The decision on any channel-level
disclosure line rests with the park when the live channels connect;
nothing in the build blocks either choice. This paragraph exists so the
decision is made with eyes open, once, at cutover.

## 3. Phase 3 — the internal assistant (SCRUM-591)

Staff ask in plain words; the assistant answers with data or a shortcut.
"Anan's attendance this month" → the quick figures for someone allowed to
see them, or a deep link straight to the right tab; complicated asks get
the link rather than a guess; every question and answer is recorded.

**The non-negotiable design rule:** the assistant calls the platform's
own APIs **as the signed-in person — never with a credential of its
own.** Authorization is therefore the server's existing role fencing,
the same fences every screen already obeys: the assistant *physically
cannot* fetch or reveal what the asker could not open themselves. A
manager asking for salaries gets the same refusal the salary screens
give; a staff member asking about another person's records gets the
same 403 the API gives. Tool calls are audited like any other API call.

Tooling shape: a registry of safe read tools over existing endpoints
(attendance, schedules, leave balances, payroll where permitted, members,
checklists), a deep-link map of the suite's screens, and a recorded
ask-log per person.

## 4. The learning loop (continuous, both phases)

The model's weights never learn from the park's traffic; what makes the
assistant visibly smarter is **curated data**: every answer a staff
member corrects becomes a stored example; approved answers grow the
knowledge base; past conversations become searchable context; the
handover boundary tightens as real cases accumulate. This is an
operating loop the marketing/owner side feeds — the same role the brief
already gives them for the FAQ — not a one-off build.

## 5. Order and dependencies

Phase 1 (rails, building now) carries everything: threads, routing,
humans, channels, audit, PDPA. Phase 2 rides on locked rails and the
knowledge base. Phase 3 rides on Phase 2's plumbing plus the tool
registry. The live WhatsApp/Instagram connections remain configuration
gated on the park's business accounts, independent of all three phases.
