import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { registerDecorator } from 'class-validator';
import { normalizeEthiopianMobile } from './ethiopian-phone.js';

const E164_MOBILE = /^\+251[79]\d{8}$/;

/**
 * Accepts the local formats users type (09…, 07…, +251…, 00251…) and normalizes them to
 * E.164 before validation. Invalid input fails with field code IS_ETHIOPIAN_MOBILE.
 */
export function IsEthiopianMobile(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({
      example: '+251911234567',
      description: 'Ethiopian mobile number; local formats accepted',
    }),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? (normalizeEthiopianMobile(value) ?? value) : value,
    ),
    (target: object, propertyKey: string | symbol) => {
      registerDecorator({
        name: 'isEthiopianMobile',
        target: target.constructor,
        propertyName: String(propertyKey),
        validator: {
          validate: (value: unknown) => typeof value === 'string' && E164_MOBILE.test(value),
        },
      });
    },
  );
}
