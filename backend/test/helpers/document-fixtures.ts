import sharp from 'sharp';

/** A small JPEG with camera and GPS EXIF (what a phone photo carries). */
export async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366aa' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Exif-Model-123', Copyright: 'Owner Name' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '9/1 1/1 30/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '38/1 45/1 0/1',
      },
    })
    .toBuffer();
}

/** A structurally minimal PDF; [body] is inserted before the trailer. */
export function minimalPdf(body = ''): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}
