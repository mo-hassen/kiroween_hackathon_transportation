import { ClamAvScanner, EICAR_SIGNATURE } from '../../src/providers/scanner/file-scanner.js';
import { licenseJpeg } from '../helpers/document-helpers.js';

/**
 * Against a real clamd (compose profile "scanner"). Opt-in, because the daemon needs its
 * signature database and is not part of the default test stack:
 *
 *   CLAMAV_TEST_HOST=localhost CLAMAV_TEST_PORT=53310 npm run test:integration -- clamav
 */
const host = process.env.CLAMAV_TEST_HOST;
const port = Number(process.env.CLAMAV_TEST_PORT ?? 3310);

describe.skipIf(host === undefined)('ClamAvScanner against clamd', () => {
  const scanner = new ClamAvScanner(host ?? 'localhost', port, 30_000);

  it('reports the EICAR test file as infected', async () => {
    const result = await scanner.scan(Buffer.from(EICAR_SIGNATURE, 'latin1'));
    expect(result.verdict).toBe('INFECTED');
    expect(result.verdict === 'INFECTED' && result.signature).toMatch(/eicar/i);
  });

  it('reports an ordinary licence photo as clean', async () => {
    await expect(scanner.scan(await licenseJpeg())).resolves.toMatchObject({ verdict: 'CLEAN' });
  });
});
