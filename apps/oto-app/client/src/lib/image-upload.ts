export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_PREPARE_TARGET_BYTES = 4 * 1024 * 1024;
export const IMAGE_PREPARE_MAX_DIMENSION = 1920;

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const OUTPUT_TYPE = "image/jpeg";
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.48];

export class ImagePreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePreparationError";
  }
}

export function getPreparedImageDimensions(
  width: number,
  height: number,
  maxDimension = IMAGE_PREPARE_MAX_DIMENSION,
): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) return { width, height };
  const ratio = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function extensionForType(type: string): string {
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  return ".jpg";
}

function outputFilename(filename: string, type: string): string {
  const stem = filename.replace(/\.[^/.]+$/, "") || "photo";
  return `${stem}${extensionForType(type)}`;
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve({ image, objectUrl });
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      image.src = "";
      URL.revokeObjectURL(objectUrl);
      reject(new ImagePreparationError(
        `${file.name} could not be read as an image. Try choosing a JPEG, PNG, or WebP photo.`,
      ));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ImagePreparationError("The browser could not compress this photo. Try a different image."));
    }, type, quality);
  });
}

export async function prepareImageForUpload(file: File): Promise<File> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new ImagePreparationError(
      `${file.name} is not a supported image. Choose a JPEG, PNG, WebP, HEIC, or HEIF photo.`,
    );
  }

  if (file.size <= IMAGE_PREPARE_TARGET_BYTES && file.type !== "image/heic" && file.type !== "image/heif") {
    return file;
  }

  const { image, objectUrl } = await loadImage(file);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const dimensions = getPreparedImageDimensions(image.naturalWidth || image.width, image.naturalHeight || image.height);
    canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new ImagePreparationError("This browser could not prepare the photo. Try another image or browser.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    // The full-resolution decoded source is no longer needed while JPEG encoding runs.
    image.src = "";
    URL.revokeObjectURL(objectUrl);

    let smallestBlob: Blob | null = null;
    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, OUTPUT_TYPE, quality);
      if (!smallestBlob || blob.size < smallestBlob.size) smallestBlob = blob;
      if (blob.size <= IMAGE_PREPARE_TARGET_BYTES) {
        return new File([blob], outputFilename(file.name, OUTPUT_TYPE), {
          type: OUTPUT_TYPE,
          lastModified: file.lastModified,
        });
      }
    }

    if (!smallestBlob || smallestBlob.size > IMAGE_UPLOAD_MAX_BYTES) {
      throw new ImagePreparationError(
        `${file.name} could not be reduced below the 5 MB upload limit. Try cropping it or choosing a smaller photo.`,
      );
    }

    return new File([smallestBlob], outputFilename(file.name, OUTPUT_TYPE), {
      type: OUTPUT_TYPE,
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
    image.src = "";
    // Release the canvas backing store, not just the object URL.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function prepareImagesForUpload(files: File[]): Promise<File[]> {
  const prepared: File[] = [];
  for (const file of files) prepared.push(await prepareImageForUpload(file));
  return prepared;
}
