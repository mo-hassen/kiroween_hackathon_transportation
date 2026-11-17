import { resolveRequestId } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('accepts a well-formed client request id', () => {
    expect(resolveRequestId('mobile-01J9ZK3Q')).toBe('mobile-01J9ZK3Q');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveRequestId(['abcdefgh-1', 'other-value'])).toBe('abcdefgh-1');
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['log injection', 'abcdefgh\n{"level":"fatal"}'],
    ['spaces', 'abcd efgh'],
  ])('generates a new id when the header is %s', (_label, header) => {
    expect(resolveRequestId(header)).toMatch(UUID);
  });
});
