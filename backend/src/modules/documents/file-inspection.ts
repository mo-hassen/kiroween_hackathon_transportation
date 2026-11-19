import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const IMAGE_MIME_TYPES: readonly AllowedMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

/** Max input pixels for decoding (decompression-bomb guard): 50 megapixels. */
const MAX_INPUT_PIXELS = 50_000_000;
/** Longest side after re-encoding: keeps licence text readable, drops excess resolution. */
const MAX_DIMENSION = 4096;

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Type from the file signature (magic bytes), never from the name or the declared type. */
export function detectMimeType(bytes: Buffer): AllowedMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

export type InspectionFailure =
  'UNSUPPORTED_TYPE' | 'TYPE_MISMATCH' | 'MALFORMED_FILE' | 'ACTIVE_CONTENT' | 'IMAGE_TOO_LARGE';

export class InspectionError extends Error {
  constructor(readonly code: InspectionFailure) {
    super(code);
    this.name = 'InspectionError';
  }
}

/**
 * PDF policy [ASSUMPTION]: a structurally plausible PDF (header, %%EOF trailer) without
 * active or embedded content markers. PDFs are not re-encoded, so their metadata is not
 * removed; the scanner still runs. Compressed streams are not decompressed, so this is a
 * heuristic filter, not a PDF sanitizer.
 */
const PDF_ACTIVE_MARKERS = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/EmbeddedFile',
  '/OpenAction',
  '/AA',
  '/RichMedia',
  '/XFA',
  '/SubmitForm',
  '/ImportData',
];

export function inspectPdf(bytes: Buffer): void {
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  if (!tail.includes('%%EOF')) throw new InspectionError('MALFORMED_FILE');
  const text = bytes.toString('latin1');
  for (const marker of PDF_ACTIVE_MARKERS) {
    // A marker is a PDF name: followed by a delimiter, not by more name characters.
    if (new RegExp(`${marker.replace('/', '\\/')}(?![A-Za-z0-9])`).test(text)) {
      throw new InspectionError('ACTIVE_CONTENT');
    }
  }
}

export interface SanitizedFile {
  readonly bytes: Buffer;
  readonly mimeType: AllowedMimeType;
  readonly metadataRemoved: boolean;
}

/**
 * Re-encodes an image: decodes (rejecting malformed and oversized images), applies the EXIF
 * orientation, drops ALL metadata (EXIF incl. GPS, XMP, IPTC, ICC except sRGB conversion),
 * caps the longest side at 4096 px and writes a fresh file of the same type.
 */
export async function sanitizeImage(
  bytes: Buffer,
  mimeType: AllowedMimeType,
): Promise<SanitizedFile> {
  let pipeline;
  try {
    pipeline = sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
      animated: false,
    })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColorspace('srgb');
    switch (mimeType) {
      case 'image/jpeg':
        pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' });
        break;
      case 'image/png':
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
      case 'image/webp':
        pipeline = pipeline.webp({ quality: 92 });
        break;
      default:
        throw new InspectionError('UNSUPPORTED_TYPE');
    }
    const output = await pipeline.toBuffer();
    return { bytes: output, mimeType, metadataRemoved: true };
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new InspectionError(/pixel limit/i.test(message) ? 'IMAGE_TOO_LARGE' : 'MALFORMED_FILE');
  }
}

/** Validates the bytes against the declared type and returns the file to store. */
export async function inspectAndSanitize(
  bytes: Buffer,
  declaredMimeType: string,
): Promise<SanitizedFile> {
  const detected = detectMimeType(bytes);
  if (detected === null) throw new InspectionError('UNSUPPORTED_TYPE');
  if (detected !== declaredMimeType) throw new InspectionError('TYPE_MISMATCH');
  if (detected === 'application/pdf') {
    inspectPdf(bytes);
    return { bytes, mimeType: detected, metadataRemoved: false };
  }
  return sanitizeImage(bytes, detected);
}
