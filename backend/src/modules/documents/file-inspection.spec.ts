import sharp from 'sharp';
import {
  detectMimeType,
  InspectionError,
  inspectAndSanitize,
  inspectPdf,
} from './file-inspection.js';
import { jpegWithGps, minimalPdf } from '../../../test/helpers/document-fixtures.js';

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InspectionError);
  return (error as InspectionError).code;
}

describe('file signatures (magic bytes)', () => {
  it('detects the four allowed types from their bytes', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer();
    expect(detectMimeType(await jpegWithGps())).toBe('image/jpeg');
    expect(detectMimeType(png)).toBe('image/png');
    expect(detectMimeType(webp)).toBe('image/webp');
    expect(detectMimeType(minimalPdf())).toBe('application/pdf');
  });

  it('does not recognise other content', () => {
    expect(detectMimeType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectMimeType(Buffer.from('GIF89a'))).toBeNull();
    expect(detectMimeType(Buffer.from('MZ\x90\x00'))).toBeNull();
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('inspectAndSanitize', () => {
  it('removes EXIF (including GPS) by re-encoding images', async () => {
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const result = await inspectAndSanitize(original, 'image/jpeg');
    const metadata = await sharp(result.bytes).metadata();
    expect(result.metadataRemoved).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(result.bytes.includes(Buffer.from('Exif-Model-123'))).toBe(false);
    expect(metadata.width).toBe(64);
  });

  it('rejects a declared type that differs from the real one', async () => {
    expect(await failure(inspectAndSanitize(await jpegWithGps(), 'image/png'))).toBe(
      'TYPE_MISMATCH',
    );
    expect(await failure(inspectAndSanitize(minimalPdf(), 'image/jpeg'))).toBe('TYPE_MISMATCH');
  });

  it('rejects unsupported and malformed files', async () => {
    expect(await failure(inspectAndSanitize(Buffer.from('MZ executable'), 'image/jpeg'))).toBe(
      'UNSUPPORTED_TYPE',
    );
    const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
    expect(await failure(inspectAndSanitize(truncated, 'image/jpeg'))).toBe('MALFORMED_FILE');
  });

  it('rejects images above the pixel limit (decompression bombs)', async () => {
    const huge = await sharp({
      create: { width: 10000, height: 6000, channels: 3, background: '#000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(await failure(inspectAndSanitize(huge, 'image/png'))).toBe('IMAGE_TOO_LARGE');
  });

  it('caps the longest side at 4096 px', async () => {
    const wide = await sharp({
      create: { width: 5000, height: 1000, channels: 3, background: '#eee' },
    })
      .jpeg()
      .toBuffer();
    const result = await inspectAndSanitize(wide, 'image/jpeg');
    expect((await sharp(result.bytes).metadata()).width).toBe(4096);
  });

  it('keeps a plain PDF unchanged and says its metadata was not removed', async () => {
    const pdf = minimalPdf();
    const result = await inspectAndSanitize(pdf, 'application/pdf');
    expect(result.bytes.equals(pdf)).toBe(true);
    expect(result.metadataRemoved).toBe(false);
  });

  it.each(['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/OpenAction', '/AA', '/XFA'])(
    'rejects a PDF with %s',
    (marker) => {
      expect(() => {
        inspectPdf(minimalPdf(`3 0 obj << ${marker} (x) >> endobj`));
      }).toThrow(InspectionError);
    },
  );

  it('does not mistake longer names for active content (e.g. /JSONData)', () => {
    expect(() => {
      inspectPdf(minimalPdf('3 0 obj << /JSONData (x) >> endobj'));
    }).not.toThrow();
  });

  it('rejects a PDF without an end-of-file marker', () => {
    expect(() => {
      inspectPdf(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n'));
    }).toThrow(InspectionError);
  });
});
