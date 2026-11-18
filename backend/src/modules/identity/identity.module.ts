import { Module } from '@nestjs/common';
import { IdentityAdminController } from './identity-admin.controller.js';
import { IdentityAdminService } from './identity-admin.service.js';
import { IdentityCallbackService } from './identity-callback.service.js';
import { IdentityExpiryService } from './identity-expiry.service.js';
import { IdentityTransitions } from './identity-transitions.js';
import { IdentityVerificationService } from './identity-verification.service.js';
import { IdentityCallbackController, IdentityController } from './identity.controller.js';

/** Identity verification (Phase 4). Separate from authentication (08 §2). */
@Module({
  controllers: [IdentityController, IdentityCallbackController, IdentityAdminController],
  providers: [
    IdentityTransitions,
    IdentityExpiryService,
    IdentityVerificationService,
    IdentityCallbackService,
    IdentityAdminService,
  ],
  exports: [IdentityExpiryService],
})
export class IdentityModule {}
