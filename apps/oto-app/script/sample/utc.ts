/**
 * Pin this process to UTC. Import it FIRST, before anything that opens a
 * database connection or touches a `Date`.
 *
 * Every timestamp in this app is `timestamp without time zone` — a wall clock
 * with no offset attached. node-postgres reads one into a `Date` by treating it
 * as the *process's* local time, and writes a `Date` back by rendering the
 * process's local time. On one machine those two cancel out and nothing looks
 * wrong. Across two machines they do not, and this is a sample that is cut on a
 * laptop in Bangkok and loaded onto a deployment running in UTC: every clock-in
 * the park's staff made would land seven hours out, a 09:30 start showing as
 * 16:30, and the Time & Attendance screens would be quietly wrong rather than
 * visibly broken.
 *
 * It also silently lost rows. The seed asks the database which clock-ins it
 * already has from the sample's earliest time onwards, and that lower bound was
 * being shifted the same seven hours — so the first seven hours of the sample
 * were never seen, and a second run inserted them again. That is how this was
 * found: a run that was supposed to write nothing wrote two clock-ins.
 *
 * Node re-reads `process.env.TZ` when it is assigned (v16 and later), so this
 * takes effect for the whole process as long as it runs before the first
 * conversion.
 */

process.env.TZ = 'UTC';
