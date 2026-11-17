import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { HealthService, type Readiness } from './health.service.js';

class LivenessDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

class ReadinessChecksDto {
  @ApiProperty({ enum: ['up', 'down'] }) database!: string;
  @ApiProperty({ enum: ['up', 'down'] }) redis!: string;
  @ApiProperty({ enum: ['up', 'down'] }) storage!: string;
}

class ReadinessDto {
  @ApiProperty({ enum: ['ok', 'unavailable'] }) status!: string;
  @ApiProperty({ type: ReadinessChecksDto }) checks!: ReadinessChecksDto;
}

/** Probes for orchestrators. Not rate limited; reveals component state only, never errors. */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOkResponse({ type: LivenessDto, description: 'The process is running.' })
  live(): LivenessDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({
    type: ReadinessDto,
    description: 'Database, Redis and object storage are reachable.',
  })
  @ApiServiceUnavailableResponse({
    type: ReadinessDto,
    description: 'At least one dependency is down.',
  })
  async ready(@Res({ passthrough: true }) response: Response): Promise<Readiness> {
    const readiness = await this.health.readiness();
    if (readiness.status !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }
}
