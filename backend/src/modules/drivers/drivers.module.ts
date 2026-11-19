import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { DriverAdminController } from './driver-admin.controller.js';
import { DriverEligibilityService } from './driver-eligibility.service.js';
import { DriverReviewService } from './driver-review.service.js';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

/** Driver profiles, licences and their verification (Phase 5). */
@Module({
  imports: [DocumentsModule],
  controllers: [DriversController, DriverAdminController],
  providers: [DriversService, DriverReviewService, DriverEligibilityService],
  exports: [DriverEligibilityService],
})
export class DriversModule {}
