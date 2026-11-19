import { Socket } from 'node:net';

/**
 * Malware-scan boundary (docs/architecture/07-security-architecture.md §4).
 *
 * - `ClamAvScanner` [IMPL]: streams the bytes to a clamd daemon (INSTREAM). Detection quality
 *   is that of ClamAV and its signature database; it is not a guarantee.
 * - `DevFileScanner` [IMPL, development/test only]: detects ONLY the EICAR test file. It is
 *   NOT malware protection; config validation rejects it in staging/production.
 * - `DisabledFileScanner`: no scanner configured; every scan fails, so nothing becomes
 *   AVAILABLE (fail closed).
 */
export type ScanResult =
  | { readonly verdict: 'CLEAN'; readonly engine: string }
  | { readonly verdict: 'INFECTED'; readonly engine: string; readonly signature: string };

/** The scan could not be performed (transient). The document stays retryable. */
export class ScannerUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`Scanner unavailable: ${detail}`);
    this.name = 'ScannerUnavailableError';
  }
}

export abstract class FileScanner {
  abstract readonly id: string;
  abstract scan(bytes: Buffer): Promise<ScanResult>;
}

/** The standard anti-malware test string (eicar.org). Harmless by design. */
export const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export class DevFileScanner extends FileScanner {
  readonly id = 'dev-eicar-only';

  scan(bytes: Buffer): Promise<ScanResult> {
    return Promise.resolve(
      bytes.includes(Buffer.from(EICAR_SIGNATURE, 'latin1'))
        ? { verdict: 'INFECTED', engine: this.id, signature: 'Eicar-Test-Signature' }
        : { verdict: 'CLEAN', engine: this.id },
    );
  }
}

export class DisabledFileScanner extends FileScanner {
  readonly id = 'disabled';

  scan(): Promise<ScanResult> {
    return Promise.reject(new ScannerUnavailableError('no scanner configured'));
  }
}

const CHUNK = 64 * 1024;

/**
 * clamd INSTREAM client: "zINSTREAM\0", then <uint32 big-endian length><data> chunks, then a
 * zero-length chunk. Reply: "stream: OK", "stream: <name> FOUND" or "... ERROR".
 */
export class ClamAvScanner extends FileScanner {
  readonly id = 'clamav';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = new Socket();
      const replies: Buffer[] = [];
      let settled = false;
      const fail = (detail: string): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailableError(detail));
      };
      socket.setTimeout(this.timeoutMs, () => {
        fail('timeout');
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        fail(error.code ?? 'socket error');
      });
      socket.on('data', (chunk: Buffer) => replies.push(chunk));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
        socket.destroy();
        const found = /^stream: (.+) FOUND$/.exec(reply);
        if (reply === 'stream: OK') resolve({ verdict: 'CLEAN', engine: this.id });
        else if (found !== null)
          resolve({ verdict: 'INFECTED', engine: this.id, signature: found[1] ?? 'unknown' });
        else reject(new ScannerUnavailableError('unexpected clamd reply'));
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const part = bytes.subarray(offset, offset + CHUNK);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(part.length);
          socket.write(length);
          socket.write(part);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
