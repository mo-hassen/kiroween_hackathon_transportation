import { Controller, Get, HttpStatus, Inject, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import { RawResponse } from '../../common/http/response-envelope.interceptor.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import {
  DEFAULT_DEV_PERSON,
  DEV_OUTCOMES,
  DEV_PERSONS,
  type DevAuthorization,
  DevIdentityProvider,
  type DevOutcome,
  type DevPerson,
} from './dev-identity.provider.js';
import { IdentityProvider } from './identity-provider.js';

const SUBJECT = /^[a-z0-9-]{1,64}$/;
const NAME = /^[\p{L} .'-]{1,100}$/u;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const OUTCOME_LABELS: Record<Exclude<DevOutcome, 'approve'>, string> = {
  decline: 'Decline consent',
  provider_error: 'Provider error',
  session_timeout: 'Provider session timed out',
  slow: 'Provider never answers (timeout)',
  bad_signature: 'Invalid token signature',
  wrong_nonce: 'Token for another session (nonce mismatch)',
};

/**
 * DEVELOPMENT/TEST ONLY: the dev identity provider's consent page. Mounted solely with
 * IDENTITY_PROVIDER=dev, which config validation rejects in staging and production; the
 * handlers re-check both conditions. It only ever redirects to the configured callback.
 */
@ApiExcludeController()
@Public()
@RawResponse()
@Controller({ path: 'dev/identity', version: '1' })
export class DevIdentityController {
  constructor(
    private readonly provider: IdentityProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('authorize')
  authorize(@Query() query: Record<string, unknown>, @Res() response: Response): void {
    const { authorization } = this.parse(query);
    const decisionUrl = (outcome: DevOutcome, person?: DevPerson): string => {
      const params = new URLSearchParams({
        redirect_uri: authorization.redirectUri,
        state: authorization.state,
        nonce: authorization.nonce,
        code_challenge: authorization.codeChallenge,
        client_id: 'dev-client',
        response_type: 'code',
        code_challenge_method: 'S256',
        outcome,
        ...(person === undefined ? {} : { subject: person.subject }),
      });
      return `decision?${params.toString()}`;
    };
    const people = DEV_PERSONS.map(
      (person) =>
        `<li><a href="${escapeHtml(decisionUrl('approve', person))}">Approve as ${escapeHtml(person.fullName)}</a> <small>(born ${escapeHtml(person.dateOfBirth)})</small></li>`,
    ).join('');
    const failures = (Object.keys(OUTCOME_LABELS) as Exclude<DevOutcome, 'approve'>[])
      .map(
        (outcome) =>
          `<li><a href="${escapeHtml(decisionUrl(outcome, DEFAULT_DEV_PERSON))}">${escapeHtml(OUTCOME_LABELS[outcome])}</a></li>`,
      )
      .join('');
    // Own policy: no scripts at all, and no upgrade-insecure-requests (the dev API is plain
    // http, e.g. http://10.0.2.2:3000 from the Android emulator).
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    response
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST identity provider</title><style>body{font-family:sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem}.banner{background:#b00020;color:#fff;padding:.75rem;border-radius:.5rem}li{margin:.75rem 0}</style></head><body><p class="banner"><strong>TEST IDENTITY PROVIDER.</strong> This is not Fayda. It returns synthetic people and only runs in development.</p><h1>Share your identity?</h1><p>The app asks for your name and date of birth.</p><ul>${people}</ul><h2>Simulate</h2><ul>${failures}</ul></body></html>`,
      );
  }

  @Get('authorize/decision')
  decision(@Query() query: Record<string, unknown>, @Res() response: Response): void {
    const { provider, authorization } = this.parse(query);
    const outcome = query['outcome'];
    if (typeof outcome !== 'string' || !(DEV_OUTCOMES as readonly string[]).includes(outcome)) {
      throw validationError('outcome', 'IS_IN');
    }
    response.redirect(
      HttpStatus.SEE_OTHER,
      provider.decide(authorization, outcome as DevOutcome, this.person(query)),
    );
  }

  /** A listed person, or a custom synthetic one (tests need distinct identities). */
  private person(query: Record<string, unknown>): DevPerson {
    const subject = query['subject'];
    if (subject === undefined) return DEFAULT_DEV_PERSON;
    if (typeof subject !== 'string' || !SUBJECT.test(subject)) {
      throw validationError('subject', 'MATCHES');
    }
    const listed = DEV_PERSONS.find((person) => person.subject === subject);
    if (listed !== undefined) return listed;
    const name = query['name'];
    const dob = query['dob'];
    return {
      subject,
      fullName: typeof name === 'string' && NAME.test(name) ? name : 'Test Person',
      dateOfBirth: typeof dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : '1990-01-01',
    };
  }

  private parse(query: Record<string, unknown>): {
    provider: DevIdentityProvider;
    authorization: DevAuthorization;
  } {
    if (!(this.provider instanceof DevIdentityProvider) || this.config.isDeployed) {
      throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    const authorization = this.provider.parseAuthorization(query);
    if (authorization === null) throw validationError('request', 'INVALID_AUTHORIZATION_REQUEST');
    return { provider: this.provider, authorization };
  }
}
