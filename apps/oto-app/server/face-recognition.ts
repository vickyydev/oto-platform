import { 
  RekognitionClient, 
  IndexFacesCommand, 
  SearchFacesByImageCommand,
  DeleteFacesCommand,
  CreateCollectionCommand,
  ListCollectionsCommand
} from "@aws-sdk/client-rekognition";

export interface FaceEnrollmentResult {
  success: boolean;
  faceId?: string;
  confidence?: number;
  errorCode?: string;
  errorMessage?: string;
  duplicateMatch?: {
    matchedEmployeeId: string;
    matchedFaceId: string;
    similarity: number;
  };
}

export interface FaceMatchResult {
  success: boolean;
  isMatch: boolean;
  confidence?: number;
  faceId?: string;
  employeeId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface LivenessCheckResult {
  success: boolean;
  isLive: boolean;
  confidence?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface MultiFrameLivenessResult {
  success: boolean;
  isLive: boolean;
  confidence: number;
  movementScore: number;
  varianceScore: number;
  frameCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface FaceRecognitionService {
  enrollFace(employeeId: string, imageBase64: string): Promise<FaceEnrollmentResult>;
  searchFace(imageBase64: string, enrolledEmployeeIds?: string[]): Promise<FaceMatchResult>;
  verifyLiveness(imageBase64: string): Promise<LivenessCheckResult>;
  verifyMultiFrameLiveness(framesBase64: string[]): Promise<MultiFrameLivenessResult>;
  deleteFace(faceId: string): Promise<boolean>;
}

export type FaceReplacementResult = FaceEnrollmentResult & {
  previousFaceDeleted: boolean;
};

export async function replaceFaceEnrollment({
  service,
  identityId,
  imageBase64,
  previousFaceId,
  onPreviousFaceDeleted,
}: {
  service: FaceRecognitionService;
  identityId: string;
  imageBase64: string;
  previousFaceId?: string | null;
  onPreviousFaceDeleted?: () => Promise<void>;
}): Promise<FaceReplacementResult> {
  let previousFaceDeleted = false;

  if (previousFaceId) {
    let deleteSucceeded = false;
    try {
      deleteSucceeded = await service.deleteFace(previousFaceId);
    } catch {
      deleteSucceeded = false;
    }

    if (!deleteSucceeded) {
      return {
        success: false,
        previousFaceDeleted: false,
        errorCode: "PREVIOUS_FACE_DELETE_FAILED",
        errorMessage: "The existing face could not be removed. Please retry enrollment.",
      };
    }

    previousFaceDeleted = true;
    await onPreviousFaceDeleted?.();
  }

  const enrollment = await service.enrollFace(identityId, imageBase64);
  return { ...enrollment, previousFaceDeleted };
}

export class MockFaceRecognitionService implements FaceRecognitionService {
  private enrolledFaces: Map<string, string> = new Map(); // faceId -> employeeId

  async enrollFace(employeeId: string, _imageBase64: string): Promise<FaceEnrollmentResult> {
    console.log(`[MockFaceRecognition] Enrolling face for employee ${employeeId}`);

    // Check for existing enrollments with a different employeeId (simulate duplicate detection)
    for (const [existingFaceId, existingEmployeeId] of this.enrolledFaces.entries()) {
      if (existingEmployeeId !== employeeId) {
        // In mock mode we do not actually compare images, so no duplicate is flagged
        break;
      }
    }
    
    const faceId = `face_${employeeId}_${Date.now()}`;
    this.enrolledFaces.set(faceId, employeeId);
    
    return {
      success: true,
      faceId,
      confidence: 99.8,
    };
  }

  setEnrolledEmployee(employeeId: string, faceId: string) {
    this.enrolledFaces.set(faceId, employeeId);
  }

  async searchFace(_imageBase64: string, enrolledEmployeeIds?: string[]): Promise<FaceMatchResult> {
    // For demo/testing: if there are enrolled employees passed in, match the first one
    if (enrolledEmployeeIds && enrolledEmployeeIds.length > 0) {
      const matchedEmployeeId = enrolledEmployeeIds[0];
      console.log(`[MockFaceRecognition] Demo mode - matching to enrolled employee ${matchedEmployeeId}`);
      
      return {
        success: true,
        isMatch: true,
        confidence: 95.0 + Math.random() * 4.5,
        employeeId: matchedEmployeeId,
        faceId: `face_${matchedEmployeeId}`,
      };
    }

    console.log(`[MockFaceRecognition] Face search - no enrolled employees to match`);
    
    return {
      success: true,
      isMatch: false,
      confidence: 0,
      errorCode: "FACE_NOT_FOUND",
      errorMessage: "No matching face found in collection",
    };
  }

  async verifyLiveness(_imageBase64: string): Promise<LivenessCheckResult> {
    console.log(`[MockFaceRecognition] Liveness check - mock always passes`);
    
    return {
      success: true,
      isLive: true,
      confidence: 99.5,
    };
  }

  async verifyMultiFrameLiveness(framesBase64: string[]): Promise<MultiFrameLivenessResult> {
    console.log(`[MockFaceRecognition] Multi-frame liveness check with ${framesBase64.length} frames`);
    return analyzeMultiFrameLiveness(framesBase64);
  }

  async deleteFace(faceId: string): Promise<boolean> {
    console.log(`[MockFaceRecognition] Deleting face ${faceId}`);
    this.enrolledFaces.delete(faceId);
    return true;
  }
}

function analyzeMultiFrameLiveness(framesBase64: string[]): MultiFrameLivenessResult {
  const MIN_FRAMES = 3;
  const MIN_MOVEMENT_THRESHOLD = 0.008;
  const MIN_VARIANCE_THRESHOLD = 0.003;
  
  if (framesBase64.length < MIN_FRAMES) {
    console.log(`[Liveness] Insufficient frames: ${framesBase64.length} < ${MIN_FRAMES}`);
    return {
      success: false,
      isLive: false,
      confidence: 0,
      movementScore: 0,
      varianceScore: 0,
      frameCount: framesBase64.length,
      errorCode: "INSUFFICIENT_FRAMES",
      errorMessage: `Need at least ${MIN_FRAMES} frames for liveness check`,
    };
  }

  try {
    const frameBuffers = framesBase64.map(frame => {
      const base64Data = frame.replace(/^data:image\/\w+;base64,/, '');
      return Buffer.from(base64Data, 'base64');
    });

    const frameDifferences: number[] = [];
    const frameVariances: number[] = [];

    for (let i = 1; i < frameBuffers.length; i++) {
      const diff = calculateFrameDifference(frameBuffers[i - 1], frameBuffers[i]);
      frameDifferences.push(diff);
      
      const variance = calculateFrameVariance(frameBuffers[i]);
      frameVariances.push(variance);
    }

    const avgMovement = frameDifferences.reduce((a, b) => a + b, 0) / frameDifferences.length;
    const avgVariance = frameVariances.reduce((a, b) => a + b, 0) / frameVariances.length;

    const movementOK = avgMovement >= MIN_MOVEMENT_THRESHOLD;
    const varianceOK = avgVariance >= MIN_VARIANCE_THRESHOLD;
    
    const isLive = movementOK && varianceOK;

    const movementConfidence = Math.min(100, (avgMovement / MIN_MOVEMENT_THRESHOLD) * 50);
    const varianceConfidence = Math.min(100, (avgVariance / MIN_VARIANCE_THRESHOLD) * 50);
    const overallConfidence = (movementConfidence + varianceConfidence) / 2;

    console.log(`[Liveness] Analysis: movement=${avgMovement.toFixed(4)} (need ${MIN_MOVEMENT_THRESHOLD}), variance=${avgVariance.toFixed(4)} (need ${MIN_VARIANCE_THRESHOLD}), isLive=${isLive}`);

    if (!isLive) {
      return {
        success: true,
        isLive: false,
        confidence: overallConfidence,
        movementScore: avgMovement,
        varianceScore: avgVariance,
        frameCount: framesBase64.length,
        errorCode: "LIVENESS_FAILED",
        errorMessage: !movementOK 
          ? "No natural movement detected. Please face the camera directly." 
          : "Image appears static. Please ensure you are in front of the camera.",
      };
    }

    return {
      success: true,
      isLive: true,
      confidence: overallConfidence,
      movementScore: avgMovement,
      varianceScore: avgVariance,
      frameCount: framesBase64.length,
    };
  } catch (error) {
    console.error("[Liveness] Analysis error:", error);
    return {
      success: false,
      isLive: false,
      confidence: 0,
      movementScore: 0,
      varianceScore: 0,
      frameCount: framesBase64.length,
      errorCode: "ANALYSIS_ERROR",
      errorMessage: "Failed to analyze frames",
    };
  }
}

function calculateFrameDifference(buffer1: Buffer, buffer2: Buffer): number {
  const sampleSize = Math.min(buffer1.length, buffer2.length, 10000);
  const step = Math.max(1, Math.floor(buffer1.length / sampleSize));
  
  let totalDiff = 0;
  let samples = 0;
  
  for (let i = 0; i < sampleSize && i * step < buffer1.length && i * step < buffer2.length; i++) {
    const idx = i * step;
    totalDiff += Math.abs(buffer1[idx] - buffer2[idx]);
    samples++;
  }
  
  return samples > 0 ? totalDiff / (samples * 255) : 0;
}

function calculateFrameVariance(buffer: Buffer): number {
  const sampleSize = Math.min(buffer.length, 5000);
  const step = Math.max(1, Math.floor(buffer.length / sampleSize));
  
  let sum = 0;
  let sumSq = 0;
  let samples = 0;
  
  for (let i = 0; i < sampleSize && i * step < buffer.length; i++) {
    const val = buffer[i * step];
    sum += val;
    sumSq += val * val;
    samples++;
  }
  
  if (samples === 0) return 0;
  
  const mean = sum / samples;
  const variance = (sumSq / samples) - (mean * mean);
  
  return variance / (255 * 255);
}

export class AWSRekognitionService implements FaceRecognitionService {
  private client: RekognitionClient;
  private collectionId: string;
  private isConfigured: boolean;
  private collectionEnsured: boolean = false;

  constructor() {
    this.collectionId = process.env.AWS_REKOGNITION_COLLECTION_ID || "oto-hr-faces";
    this.isConfigured = process.env.USE_AWS_REKOGNITION === "true";

    this.client = new RekognitionClient({
      region: process.env.AWS_REGION || "us-east-1",
    });

    if (!this.isConfigured) {
      console.warn("[AWSRekognition] AWS credentials not configured. Using mock implementation.");
    } else {
      console.log(`[AWSRekognition] Initialized with collection: ${this.collectionId}`);
    }
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionEnsured) return;
    
    try {
      const listCommand = new ListCollectionsCommand({});
      const response = await this.client.send(listCommand);
      
      if (!response.CollectionIds?.includes(this.collectionId)) {
        console.log(`[AWSRekognition] Creating collection: ${this.collectionId}`);
        const createCommand = new CreateCollectionCommand({
          CollectionId: this.collectionId,
        });
        await this.client.send(createCommand);
        console.log(`[AWSRekognition] Collection created: ${this.collectionId}`);
      }
      
      this.collectionEnsured = true;
    } catch (error) {
      console.error("[AWSRekognition] Error ensuring collection:", error);
      throw error;
    }
  }

  async enrollFace(employeeId: string, imageBase64: string): Promise<FaceEnrollmentResult> {
    if (!this.isConfigured) {
      console.log(`[AWSRekognition] Not configured - using mock enrollment for ${employeeId}`);
      const faceId = `face_${employeeId}_${Date.now()}`;
      return { success: true, faceId, confidence: 99.8 };
    }

    try {
      await this.ensureCollection();
      
      console.log(`[AWSRekognition] Enrolling face for employee ${employeeId} to collection ${this.collectionId}`);
      
      const imageBytes = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');

      // --- Duplicate detection: search BEFORE indexing ---
      // Fetch up to 5 high-similarity matches so we can find any face already
      // enrolled under a *different* employee (the top match may belong to the
      // same employee if they re-enroll). We use a 95% threshold to avoid false
      // positives from similar-looking but distinct individuals.
      let duplicateMatch: FaceEnrollmentResult["duplicateMatch"] | undefined;
      try {
        const searchCommand = new SearchFacesByImageCommand({
          CollectionId: this.collectionId,
          Image: { Bytes: imageBytes },
          MaxFaces: 5,
          FaceMatchThreshold: 95,
        });
        const searchResponse = await this.client.send(searchCommand);

        if (searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
          // Iterate all returned matches looking for the highest-similarity one
          // that belongs to a different employee.
          for (const match of searchResponse.FaceMatches) {
            const matchedEmployeeId = match.Face?.ExternalImageId;
            const matchedFaceId = match.Face?.FaceId;
            const similarity = match.Similarity || 0;

            if (matchedEmployeeId && matchedEmployeeId !== employeeId && matchedFaceId) {
              // Keep the highest-similarity cross-employee match
              if (!duplicateMatch || similarity > duplicateMatch.similarity) {
                duplicateMatch = { matchedEmployeeId, matchedFaceId, similarity };
              }
            }
          }

          if (duplicateMatch) {
            console.warn(
              `[AWSRekognition] Near-duplicate face detected during enrollment of ${employeeId}: ` +
              `matches ${duplicateMatch.matchedEmployeeId} with ${duplicateMatch.similarity.toFixed(1)}% similarity`
            );
          }
        }
      } catch (searchError: any) {
        // InvalidParameterException means no face was detected in the pre-check image;
        // treat as no duplicate rather than failing the whole enrollment.
        if (searchError.name !== "InvalidParameterException") {
          console.warn("[AWSRekognition] Pre-enrollment duplicate search failed (non-fatal):", searchError.message);
        }
      }
      // --- End duplicate detection ---

      const command = new IndexFacesCommand({
        CollectionId: this.collectionId,
        Image: { Bytes: imageBytes },
        ExternalImageId: employeeId,
        DetectionAttributes: ["ALL"],
        MaxFaces: 1,
        QualityFilter: "AUTO",
      });
      
      const response = await this.client.send(command);
      
      if (!response.FaceRecords || response.FaceRecords.length === 0) {
        return {
          success: false,
          errorCode: "NO_FACE_DETECTED",
          errorMessage: "No face detected in the image",
        };
      }

      // --- UnindexedFaces check ---
      // AWS may return faces it detected but declined to index (e.g. quality
      // issues or duplicate-suppression). Log these for audit purposes; if
      // Rekognition itself flagged the submitted image as a near-duplicate
      // of an existing face, surface that as a mis-enrollment signal too.
      if (response.UnindexedFaces && response.UnindexedFaces.length > 0) {
        for (const unindexed of response.UnindexedFaces) {
          const reasons = unindexed.Reasons?.join(", ") || "unknown";
          console.warn(
            `[AWSRekognition] UnindexedFace during enrollment of ${employeeId}: reasons=[${reasons}]`
          );
          // If Rekognition rejected this face because it matches an existing
          // entry in the collection, treat it as a duplicate signal even if
          // the pre-search didn't catch one (e.g. threshold differences).
          if (
            !duplicateMatch &&
            unindexed.Reasons?.includes("DUPLICATE_FACE" as any)
          ) {
            console.warn(
              `[AWSRekognition] Rekognition flagged DUPLICATE_FACE in UnindexedFaces for employee ${employeeId}`
            );
            // We don't have the matched face details here, so set a sentinel
            // value that the caller can recognise as a duplicate signal.
            duplicateMatch = {
              matchedEmployeeId: "UNKNOWN",
              matchedFaceId: "UNKNOWN",
              similarity: 100,
            };
          }
        }
      }
      // --- End UnindexedFaces check ---
      
      const faceRecord = response.FaceRecords[0];
      const faceId = faceRecord.Face?.FaceId || `face_${employeeId}_${Date.now()}`;
      const confidence = faceRecord.Face?.Confidence || 99.0;
      
      console.log(`[AWSRekognition] Face enrolled successfully: ${faceId} (confidence: ${confidence}%)`);
      
      return {
        success: true,
        faceId,
        confidence,
        duplicateMatch,
      };
    } catch (error) {
      console.error("[AWSRekognition] Enrollment error:", error);
      return {
        success: false,
        errorCode: "ENROLLMENT_FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown error during face enrollment",
      };
    }
  }

  async searchFace(imageBase64: string, _enrolledEmployeeIds?: string[]): Promise<FaceMatchResult> {
    if (!this.isConfigured) {
      console.log("[AWSRekognition] Not configured - mock search returns no match");
      return { 
        success: true, 
        isMatch: false, 
        errorCode: "FACE_NOT_FOUND",
        errorMessage: "AWS Rekognition not configured" 
      };
    }

    try {
      await this.ensureCollection();
      
      console.log(`[AWSRekognition] Searching face in collection ${this.collectionId}`);
      
      const imageBytes = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      
      const command = new SearchFacesByImageCommand({
        CollectionId: this.collectionId,
        Image: { Bytes: imageBytes },
        MaxFaces: 1,
        FaceMatchThreshold: 80, // 80% similarity threshold
      });
      
      const response = await this.client.send(command);
      
      if (!response.FaceMatches || response.FaceMatches.length === 0) {
        console.log("[AWSRekognition] No matching face found");
        return {
          success: true,
          isMatch: false,
          confidence: 0,
          errorCode: "FACE_NOT_FOUND",
          errorMessage: "No matching face found in collection",
        };
      }
      
      const match = response.FaceMatches[0];
      const employeeId = match.Face?.ExternalImageId;
      const faceId = match.Face?.FaceId;
      const confidence = match.Similarity || 0;
      
      console.log(`[AWSRekognition] Face matched: employeeId=${employeeId}, confidence=${confidence}%`);
      
      return {
        success: true,
        isMatch: true,
        confidence,
        faceId,
        employeeId,
      };
    } catch (error: any) {
      // Handle case where no face is detected in the image
      if (error.name === "InvalidParameterException" && error.message?.includes("no faces")) {
        return {
          success: true,
          isMatch: false,
          errorCode: "NO_FACE_DETECTED",
          errorMessage: "No face detected in the image",
        };
      }
      
      console.error("[AWSRekognition] Search error:", error);
      return {
        success: false,
        isMatch: false,
        errorCode: "SEARCH_FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown error during face search",
      };
    }
  }

  async verifyLiveness(_imageBase64: string): Promise<LivenessCheckResult> {
    // Note: AWS Rekognition liveness detection requires a different API flow
    // For now, we'll return a pass - full liveness would require the Rekognition Face Liveness session API
    console.log("[AWSRekognition] Liveness check - basic validation only (full liveness requires session API)");
    
    return {
      success: true,
      isLive: true,
      confidence: 95.0,
    };
  }

  async verifyMultiFrameLiveness(framesBase64: string[]): Promise<MultiFrameLivenessResult> {
    console.log(`[AWSRekognition] Multi-frame liveness check with ${framesBase64.length} frames`);
    return analyzeMultiFrameLiveness(framesBase64);
  }

  async deleteFace(faceId: string): Promise<boolean> {
    if (!this.isConfigured) {
      console.log(`[AWSRekognition] Not configured - mock delete for ${faceId}`);
      return true;
    }

    try {
      console.log(`[AWSRekognition] Deleting face ${faceId} from collection ${this.collectionId}`);
      
      const command = new DeleteFacesCommand({
        CollectionId: this.collectionId,
        FaceIds: [faceId],
      });
      
      await this.client.send(command);
      console.log(`[AWSRekognition] Face deleted: ${faceId}`);
      
      return true;
    } catch (error) {
      console.error("[AWSRekognition] Delete error:", error);
      return false;
    }
  }
}

export function createFaceRecognitionService(): FaceRecognitionService {
  const useAWS = process.env.USE_AWS_REKOGNITION === "true";
  
  if (useAWS) {
    return new AWSRekognitionService();
  }
  
  return new MockFaceRecognitionService();
}

export const faceRecognitionService = createFaceRecognitionService();
