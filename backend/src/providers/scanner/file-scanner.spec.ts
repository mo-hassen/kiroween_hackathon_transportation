import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../config/app-config.js';
import {
  ClamAvScanner,
  DevFileScanner,
  DisabledFileScanner,
  EICAR_SIGNATURE,
  ScannerUnavailableError,
} from './file-scanner.js';
import { createFileScanner } from './scanner.module.js';

/** A fake clamd that speaks INSTREAM and answers according to the content it receives. */
async function fakeClamd(
  behaviour: 'normal' | 'garbage' | 'silent',
): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      const all = Buffer.concat(chunks);
      if (!all.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      // Parse <len><data> frames until the zero-length terminator.
      let offset = 10;
      const parts: Buffer[] = [];
      while (offset + 4 <= all.length) {
        const length = all.readUInt32BE(offset);
        if (length === 0) {
          const content = Buffer.concat(parts);
          received.push(content);
          if (behaviour === 'silent') return;
          if (behaviour === 'garbage') socket.end('what?\0');
          else if (content.includes(Buffer.from(EICAR_SIGNATURE, 'latin1')))
            socket.end('stream: Win.Test.EICAR_HDB-1 FOUND\0');
          else socket.end('stream: OK\0');
          return;
        }
        if (offset + 4 + length > all.length) return;
        parts.push(all.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

describe('ClamAvScanner (clamd INSTREAM protocol, against a fake clamd)', () => {
  it('streams the file in chunks and reports a clean result', async () => {
    const clamd = await fakeClamd('normal');
    try {
      const content = Buffer.alloc(200_000, 0x41);
      const result = await new ClamAvScanner('127.0.0.1', clamd.port, 2000).scan(content);
      expect(result).toEqual({ verdict: 'CLEAN', engine: 'clamav' });
      expect(clamd.received[0]?.equals(content)).toBe(true);
    } finally {
      clamd.server.close();
    }
  });

  it('reports a detection with its signature name', async () => {
    const clamd = await fakeClamd('normal');
    try {
      const result = await new ClamAvScanner('127.0.0.1', clamd.port, 2000).scan(
        Buffer.from(EICAR_SIGNATURE, 'latin1'),
      );
      expect(result).toEqual({
        verdict: 'INFECTED',
        engine: 'clamav',
        signature: 'Win.Test.EICAR_HDB-1',
      });
    } finally {
      clamd.server.close();
    }
  });

  it.each(['garbage', 'silent'] as const)(
    'treats a %s reply as unavailable, never as clean',
    async (behaviour) => {
      const clamd = await fakeClamd(behaviour);
      try {
        await expect(
          new ClamAvScanner('127.0.0.1', clamd.port, 500).scan(Buffer.from('x')),
        ).rejects.toBeInstanceOf(ScannerUnavailableError);
      } finally {
        clamd.server.close();
      }
    },
  );

  it('treats a refused connection as unavailable', async () => {
    await expect(
      new ClamAvScanner('127.0.0.1', 9, 500).scan(Buffer.from('x')),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe('development and disabled scanners', () => {
  it('the dev scanner only knows the EICAR test file', async () => {
    const scanner = new DevFileScanner();
    expect(
      await scanner.scan(Buffer.from(`prefix ${EICAR_SIGNATURE} suffix`, 'latin1')),
    ).toMatchObject({
      verdict: 'INFECTED',
    });
    expect(await scanner.scan(Buffer.from('anything else'))).toEqual({
      verdict: 'CLEAN',
      engine: 'dev-eicar-only',
    });
  });

  it('the disabled scanner fails every scan', async () => {
    await expect(new DisabledFileScanner().scan()).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('selects the scanner from config and never builds the dev scanner when deployed', () => {
    const base = {
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379/0',
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: 'platform-documents',
      STORAGE_ACCESS_KEY_ID: 'key',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    };
    expect(createFileScanner(loadConfig(base))).toBeInstanceOf(DevFileScanner);
    expect(
      createFileScanner(loadConfig({ ...base, FILE_SCANNER: 'clamav', CLAMAV_HOST: 'clamav' })),
    ).toBeInstanceOf(ClamAvScanner);
    expect(createFileScanner(loadConfig({ ...base, FILE_SCANNER: 'disabled' }))).toBeInstanceOf(
      DisabledFileScanner,
    );
    const deployed = { ...loadConfig(base), isDeployed: true };
    expect(createFileScanner(deployed)).toBeInstanceOf(DisabledFileScanner);
  });
});
