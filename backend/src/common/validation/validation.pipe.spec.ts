import type { ValidationError } from '@nestjs/common';
import { constraintToCode, toFieldErrors } from './validation.pipe.js';

describe('constraintToCode', () => {
  it.each([
    ['isNotEmpty', 'IS_NOT_EMPTY'],
    ['maxLength', 'MAX_LENGTH'],
    ['isUUID', 'IS_UUID'],
    ['whitelistValidation', 'UNKNOWN_FIELD'],
  ])('%s -> %s', (constraint, code) => {
    expect(constraintToCode(constraint)).toBe(code);
  });
});

describe('toFieldErrors', () => {
  it('flattens nested errors with dotted paths', () => {
    const errors: ValidationError[] = [
      { property: 'name', constraints: { isString: 'name must be a string' }, children: [] },
      {
        property: 'address',
        children: [
          { property: 'subCity', constraints: { isIn: 'bad', isNotEmpty: 'empty' }, children: [] },
        ],
      },
    ];
    expect(toFieldErrors(errors)).toEqual([
      { field: 'name', code: 'IS_STRING' },
      { field: 'address.subCity', code: 'IS_IN' },
      { field: 'address.subCity', code: 'IS_NOT_EMPTY' },
    ]);
  });
});
