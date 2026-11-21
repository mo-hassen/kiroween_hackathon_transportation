import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OwnerAdminController } from './owner-admin.controller.js';
import { OwnerReviewService } from './owner-review.service.js';
import { OwnerStatusService } from './owner-status.service.js';
import { OwnersController } from './owners.controller.js';
import { OwnersService } from './owners.service.js';

/** Owner profiles (individual/organization) and their verification (Phase 6). */
@Module({
  imports: [DocumentsModule, IdentityModule],
  controllers: [OwnersController, OwnerAdminController],
  providers: [OwnersService, OwnerReviewService, OwnerStatusService],
  exports: [OwnerStatusService],
})
export class OwnersModule {}
