import { randomToken } from '../../common/crypto/random.js';
import type { ProviderIdentity } from '../../providers/identity/identity-provider.js';
import { validateProviderIdentity } from './identity-callback.service.js';

const nonce = randomToken();
const good: ProviderIdentity = {
  subject: 'psut-1234',
  nonce,
  assuranceLevel: 'mosip:idp:acr:biometrics',
  fullName: '  Abebe   Bikila  ',
  dateOfBirth: '1990/08/07',
  claimNames: ['sub', 'name', 'birthdate', 'bad name!'],
};

describe('validateProviderIdentity (checks after the adapter)', () => {
  it('accepts a well-formed identity and normalizes it', () => {
    expect(validateProviderIdentity(good, nonce)).toEqual({
      subject: 'psut-1234',
      assuranceLevel: 'mosip:idp:acr:biometrics',
      claims: { fullName: 'Abebe Bikila', dateOfBirth: '1990-08-07' },
      claimNames: ['sub', 'name', 'birthdate'],
    });
  });

  it('keeps a missing date of birth as null', () => {
    expect(
      validateProviderIdentity({ ...good, dateOfBirth: undefined }, nonce)?.claims.dateOfBirth,
    ).toBeNull();
  });

  it.each<[string, Partial<ProviderIdentity>]>([
    ['a nonce from another session', { nonce: randomToken() }],
    ['no nonce', { nonce: undefined }],
    ['an empty subject', { subject: '' }],
    ['a subject with spaces', { subject: 'two words' }],
    ['an overlong subject', { subject: 'x'.repeat(256) }],
    ['no name', { fullName: undefined }],
    ['a blank name', { fullName: '   ' }],
    ['a name with control characters', { fullName: 'Abebe\u0000Bikila' }],
    ['an overlong name', { fullName: 'a'.repeat(201) }],
    ['an unparseable birth date', { dateOfBirth: '07.08.1990' }],
    ['a birth date in the future', { dateOfBirth: '2999-01-01' }],
    ['an overlong assurance level', { assuranceLevel: 'a'.repeat(201) }],
  ])('rejects %s', (_label, change) => {
    expect(validateProviderIdentity({ ...good, ...change }, nonce)).toBeNull();
  });
});
