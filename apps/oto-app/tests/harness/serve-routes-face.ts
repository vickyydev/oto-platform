// seed: none — the caller arranges its own rows. Not a Playwright file.
//
// The app's real API on the harness (./serve-routes.ts), with face clock-in on
// and the face matcher stood in, so a check can drive `identify-face` to a
// match without a face service: liveness passes, and the face "found" is the
// profile whose id the request sends as its image (`faceImageBase64`), or no
// match when the image names nobody. Everything after the matcher — the
// tenant-scoped read of the matched profile and every rule the route applies
// to it — is the app's own. Run with USE_AWS_REKOGNITION=true, as face on is.
//
// Written for SCRUM-769's ended-employment check (tests/employee-left-access
// .check.ts); never imported by the app.
import "./fake-clock";
import { faceRecognitionService } from "../../server/face-recognition";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

faceRecognitionService.verifyMultiFrameLiveness = async (frames: string[]) => ({
  success: true,
  isLive: true,
  confidence: 99,
  movementScore: 1,
  varianceScore: 1,
  frameCount: frames.length,
});
faceRecognitionService.searchFace = async (imageBase64: string) =>
  UUID.test(imageBase64)
    ? { success: true, isMatch: true, confidence: 99, employeeId: imageBase64, faceId: `face_${imageBase64}` }
    : { success: true, isMatch: false, confidence: 0, errorCode: "FACE_NOT_FOUND" };

await import("./serve-routes");
