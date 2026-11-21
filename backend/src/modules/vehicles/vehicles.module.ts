import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { VehicleAdminController } from './vehicle-admin.controller.js';
import { VehicleReviewService } from './vehicle-review.service.js';
import { VehicleStatusService } from './vehicle-status.service.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehiclesService } from './vehicles.service.js';

/** Vehicle registration and verification (Phase 7). Marketplace listings are a later phase. */
@Module({
  imports: [DocumentsModule, OwnersModule],
  controllers: [VehiclesController, VehicleAdminController],
  providers: [VehiclesService, VehicleReviewService, VehicleStatusService],
  exports: [VehicleStatusService],
})
export class VehiclesModule {}
