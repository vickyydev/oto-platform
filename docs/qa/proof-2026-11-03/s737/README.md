# SCRUM-737 first-sale printer configuration

## Reproduction before product changes

On 3 November 2026 at 23:22 Bangkok, product source `6fd968a3` failed
the real API/box-agent regression. The station create request included both
receipt and kitchen assignments. The transaction committed them before
returning, and `routeOnBox` resolved both. The first cash sale queued both
jobs with their assigned device IDs. The ordinary command poll then used
the box's older configuration and reported both as `NO_DEVICE_FOR_ROLE`.

The control pulled configuration before the same command path: both jobs
printed, each in one attempt. Each sale had exactly one approved cash
payment. [Original failing output](reproduction-before.log) records one
failed test, one passing control and exit 1. No product file was changed
before that reproduction. The seed and database are disposable local test
fixtures; this is not a physical printer or staging result.

## Cause and fix

Station creation is transactional; its assignments were not lost or delayed.
The command timer runs independently of the heartbeat that refreshes the
configuration. A print command can therefore name a newly assigned printer
before the box's cached configuration includes it.

Before rendering an assigned print command, the agent compares that route
with its cache and reads configuration if they differ. A matching route
needs no extra request. Current assignments still decide the route, including
deliberate removal. An unread configuration reports `CONFIG_UNAVAILABLE`
with zero print attempts, using the existing failed-job reporting path.
No sale or payment request is retried. The earlier offline-print duplicate
guard still runs before this refresh.

The seven-case review covers the original timing, a fresh-cache control,
a changed receipt printer, HTTP and connection failures, deliberate removal
after queuing, and a till intentionally created without printers. It reads
simulator output and approved cash attempts and polls commands again to
check that neither paper nor payment is duplicated. Full release gates and
staging proof remain pending.

## What staff see

`announceSalePrinting` reads the sale once. If that read already sees a skip,
the till shows **Some items not printed**. If it sees queued jobs, it says
they were sent and does not automatically warn when a later command skips
them. Opening the sale in History reads the final skipped status. This is
the code-observed behavior; a native staging capture is still required.
No new notification is part of this job.

The two historical rows named on SCRUM-737 remain unchanged. No setting,
Render service, plan, size or park device changes are planned. Source landing
and staging proof wait for a committed, uncontested release-slot claim;
SCRUM-730 currently holds the slot.
