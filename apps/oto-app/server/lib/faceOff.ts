/**
 * Face clock-in "off", meaning off (S2-17b round 5, plan section 4 and H13).
 *
 * The app's switch is `USE_AWS_REKOGNITION`. With it set to "true" the
 * Rekognition matcher runs; with anything else the app fell back to a stand-in
 * matcher (`MockFaceRecognitionService` in server/face-recognition.ts) that
 * answers EVERY face with the first enrolled person it is handed. So "off" was
 * not off: once anybody was enrolled — and the production data, restored,
 * carries enrolments — a face at a tablet clocked in whoever came first.
 *
 * Face clock-in is off by the owner's standing decision (Q9; production's boot
 * guard refuses `USE_AWS_REKOGNITION=true` outright, `server/config/env.ts`).
 * While it is off the face road stands down at every door, before it reads or
 * writes anything about a person:
 *
 *  - `POST /api/kiosk/identify-face` answers the app's own "no match, use PIN"
 *    reply without calling any matcher (not the stand-in, not liveness), so
 *    the tablet falls to its existing PIN and phone fallback;
 *  - the doors that write a time event by the face road — `/api/kiosk/clock`,
 *    which takes an employee id and a confidence score from the tablet and
 *    matches nothing on the server, its three follow-ups
 *    (`/api/kiosk/missed-clock/auto-fix`, `/missed-clock/manual`,
 *    `/unscheduled-clock-in`, reached only from its answer) and the advisor's
 *    `/api/kiosk/advisor-clock` — are refused in words and write nothing;
 *  - enrolment is refused in words at each of its four doors: the two QR
 *    sessions a manager makes, the tablet's token check and the capture.
 *
 * The PIN and phone roads are untouched. So is the midnight auto clock-out,
 * which keeps recording its method as FACE (Q10, the app's label).
 *
 * The switch is read on every request, as the face service itself reads it at
 * start-up, so a deployment that turns face on (a decision Q9 leaves open)
 * gets the app's face road back unchanged.
 */

export function faceClockInOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USE_AWS_REKOGNITION === "true";
}

/**
 * What `identify-face` answers while face is off: the app's own reply for a
 * face it could not match (`server/routes.ts`, "No matching face found. Please
 * use PIN entry."), which the tablet already turns into its PIN fallback.
 */
export const FACE_OFF_NO_MATCH = {
  success: true,
  matched: false,
  confidence: 0,
  message: "No matching face found. Please use PIN entry.",
} as const;

/** What a face-road clock door answers while face is off. Nothing is read or written. */
export const FACE_CLOCK_OFF_REFUSAL = {
  success: false,
  reason: "face_off",
  message: "Face clock-in is switched off. Please use your PIN or phone number.",
} as const;

/** What an enrolment door answers while face is off. Nothing is read or written. */
export const FACE_ENROLMENT_OFF_REFUSAL = {
  success: false,
  reason: "face_off",
  message: "Face clock-in is switched off, so faces are not enrolled. Staff clock in with their PIN or phone number.",
} as const;
