import { Body, Controller, Get, HttpStatus, Module, Post } from '@nestjs/common';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../../src/common/auth/public.decorator.js';
import { DomainError } from '../../src/common/http/problem-details.js';

class EchoDto {
  @IsString()
  @MaxLength(20)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;
}

/**
 * Test-only routes that exercise the global pipeline (validation, errors, auth guard,
 * rate limiting). Never imported by application code.
 */
@Controller({ path: 'probe', version: '1' })
export class ProbeController {
  @Public()
  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  @Public()
  @Get('ping')
  ping(): { pong: true } {
    return { pong: true };
  }

  @Public()
  @Get('crash')
  crash(): never {
    throw new Error('db password is hunter2 at postgres://internal-host');
  }

  @Public()
  @Get('conflict')
  conflict(): never {
    throw new DomainError('LISTING_NOT_AVAILABLE', HttpStatus.CONFLICT);
  }

  // Deliberately not @Public(): must be rejected by the global authentication guard.
  @Get('protected')
  protectedRoute(): { secret: string } {
    return { secret: 'should never be returned' };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
