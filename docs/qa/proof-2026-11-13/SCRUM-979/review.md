# SCRUM-979 API recovery review

13 November 2026. The five preserved implementation commits were rebased intact onto the takeover checkpoint. A sixth commit guards the payment-status read when its recovery transaction fails. No box agent, database migration or till source changes in this unit.

The new HTTP regression creates two terminal attempts whose acknowledgement would collide on the unique terminal reference. Before the guard, GET returns 409 DUPLICATE and the regression fails (22 other tests pass). After the guard, the complete file passes 23 tests. Two reads return the held attempt unchanged and create no new terminal command. Authentication and permission checks remain outside the catch; only recovery is guarded. The transaction rolls back before the ordinary read, and the error is logged with its attempt ID.

The existing integration cases exercise real box acknowledgement shapes, approval once despite a later result post, refusal of a known partial approval as full payment, preservation of that refusal through inquiry, command expiry, a terminal moved to another box, History recovery, sweep isolation and the staff Health alert. The saved reviews' medium finding was fixed in the preserved lane; the remaining status-poll finding is fixed here.

## Findings retained explicitly

- Low: an acknowledgement arriving after an attempt was already handed to a person is not consumed by the acknowledgement recovery path. The normal result route can still settle a held SALE. Do not claim every late acknowledgement is recovered.
- Low: the bounded sweep takes the newest 25 eligible attempts. Repeatedly unsettled newer attempts can delay older ones. No guaranteed maximum recovery time is claimed.
- Low: staff-waiting rows share the bounded pending-alert query. A large backlog can crowd out other rows. The staging proof is bounded, not a load test.
- An approval known only from an acknowledgement lacks receipt and refund transaction fields. A real terminal may refuse a subsequent void using the available reference. Physical-terminal acceptance remains open.
- The result-post path's ambiguous void outcome and the acknowledgement path's conservative hold differ. The existing owner question governs; this unit does not invent a refund decision.
- Partial approvals that lack the amount and transaction cannot be confirmed as paid in full. The eventual staff resolution flow remains an owner question.

These are recorded against SCRUM-979 and the feedback plan's existing payment questions. Source tests cover deliberate lost posts, lock behavior and unique-reference collisions. The staging simulator does not reproduce all of those failures. Production and the protected older payment run are not used as test fixtures.

## Evidence status

The red and green regression logs are retained in the local takeover archive. The typecheck produced zero output. Broader integration gates, source landing, exact deployment identity, staging pictures and cleanup must be recorded in the release receipt before this unit is described as staging-proved. The till points remain with SCRUM-977/975.
