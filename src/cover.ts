import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { v2 as cloudinary } from "cloudinary";

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
export const COVER_FOLDER = "alex-blog/agentic-lab";

export type CoverMediaType = "image/jpeg" | "image/png" | "image/webp";

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

export type CoverUploadResult =
  | { status: "uploaded"; secureUrl: string }
  | { status: "failed"; message: string }
  | { status: "uncertain"; message: string };

export type CoverUploader = (filePath: string) => Promise<CoverUploadResult>;

type CloudinarySdk = {
  config(options: {
    cloud_name: string;
    api_key: string;
    api_secret: string;
    secure?: boolean;
  }): void;
  upload(file: string, options: Record<string, unknown>): Promise<{ secure_url?: string }>;
};

export function readCloudinaryConfig(env: NodeJS.ProcessEnv): CloudinaryConfig {
  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim() ?? "";
  const apiKey = env.CLOUDINARY_API_KEY?.trim() ?? "";
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim() ?? "";

  if (!cloudName || cloudName === "replace-me") {
    throw new Error("Set CLOUDINARY_CLOUD_NAME. A live cover image needs the Cloudinary cloud name.");
  }

  if (!apiKey || apiKey === "replace-me") {
    throw new Error("Set CLOUDINARY_API_KEY. A live cover image needs the Cloudinary API key.");
  }

  if (!apiSecret || apiSecret === "replace-me") {
    throw new Error("Set CLOUDINARY_API_SECRET. A live cover image needs the Cloudinary API secret.");
  }

  return { cloudName, apiKey, apiSecret };
}

/** Read only the file the user named. The model never supplies this path. */
export function inspectCoverFile(filePath: string, label = "Cover image"): { path: string; mediaType: CoverMediaType } {
  let size = 0;
  let header = Buffer.alloc(0);

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} must be a file.`);
    }
    size = stat.size;
    const fd = openSync(filePath, "r");
    try {
      header = Buffer.alloc(12);
      const read = readSync(fd, header, 0, 12, 0);
      header = header.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a file.`) {
      throw error;
    }
    throw new Error(`${label} could not be read.`);
  }

  return { path: filePath, mediaType: classifyCover(header, size, extname(filePath), label) };
}

export function classifyCover(header: Buffer, size: number, extension: string, label = "Cover image"): CoverMediaType {
  if (size <= 0) {
    throw new Error(`${label} is empty.`);
  }

  if (size > MAX_COVER_BYTES) {
    throw new Error(`${label} must be 5 MB or smaller.`);
  }

  const detected = detectImage(header);
  const suffix = extension.toLowerCase();
  if (detected === "image/jpeg" && (suffix === ".jpg" || suffix === ".jpeg")) {
    return detected;
  }
  if (detected === "image/png" && suffix === ".png") {
    return detected;
  }
  if (detected === "image/webp" && suffix === ".webp") {
    return detected;
  }

  throw new Error(`${label} must be a JPEG, PNG, or WebP file.`);
}

export function createCloudinaryUploader(config: CloudinaryConfig, sdk?: CloudinarySdk): CoverUploader {
  const client = sdk ?? defaultCloudinarySdk();
  let attempted = false;

  return async (filePath: string) => {
    if (attempted) {
      return { status: "failed", message: "Cover upload was not retried." };
    }
    attempted = true;
    return uploadAsset(client, config, filePath, "cover");
  };
}

/** One attempt per file. A later call for the same path does not upload again. */
export function createInlineImageUploader(config: CloudinaryConfig, sdk?: CloudinarySdk): CoverUploader {
  const client = sdk ?? defaultCloudinarySdk();
  const attempted = new Set<string>();

  return async (filePath: string) => {
    if (attempted.has(filePath)) {
      return { status: "failed", message: "Inline image upload was not retried." };
    }
    attempted.add(filePath);
    return uploadAsset(client, config, filePath, "inline");
  };
}

function defaultCloudinarySdk(): CloudinarySdk {
  return {
    config: (options) => {
      cloudinary.config(options);
    },
    upload: (file, options) => cloudinary.uploader.upload(file, options),
  };
}

async function uploadAsset(
  client: CloudinarySdk,
  config: CloudinaryConfig,
  filePath: string,
  kind: "cover" | "inline",
): Promise<CoverUploadResult> {
  client.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });

  try {
    const result = await client.upload(filePath, {
      folder: COVER_FOLDER,
      resource_type: "image",
      overwrite: false,
      unique_filename: true,
      timeout: 60_000,
    });
    if (typeof result.secure_url === "string" && result.secure_url.startsWith("https://")) {
      return { status: "uploaded", secureUrl: result.secure_url };
    }
    return {
      status: "uncertain",
      message:
        kind === "cover"
          ? "The cover upload did not return a secure URL. An asset may have been stored in alex-blog/agentic-lab and was not deleted. The upload was not retried."
          : "The inline image upload did not return a secure URL. An asset may have been stored in alex-blog/agentic-lab and was not deleted. The upload was not retried.",
    };
  } catch (error) {
    return classifyUploadError(error, kind);
  }
}

function detectImage(header: Buffer): CoverMediaType | undefined {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function classifyUploadError(error: unknown, kind: "cover" | "inline"): CoverUploadResult {
  const httpCode =
    error !== null && typeof error === "object" && "http_code" in error
      ? Number((error as { http_code: unknown }).http_code)
      : undefined;
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const rejected = httpCode !== undefined && !Number.isNaN(httpCode) && httpCode >= 400 && httpCode < 500 && httpCode !== 408;
  const label = kind === "cover" ? "Cover" : "Inline image";

  if (rejected && !timedOut) {
    return { status: "failed", message: `${label} upload failed (HTTP ${httpCode}). The upload was not retried.` };
  }

  return {
    status: "uncertain",
    message: `The ${kind === "cover" ? "cover" : "inline image"} upload did not finish. An asset may have been stored in alex-blog/agentic-lab and was not deleted. The upload was not retried.`,
  };
}
