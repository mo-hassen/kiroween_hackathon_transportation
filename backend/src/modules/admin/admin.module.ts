import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAdminController } from './staff/staff-admin.controller.js';
import { StaffAdminService } from './staff/staff-admin.service.js';
import { StaffProvisioningService } from './staff/staff-provisioning.service.js';

@Module({
  imports: [AuthModule],
  controllers: [StaffAdminController],
  providers: [StaffAdminService, StaffProvisioningService],
  exports: [StaffProvisioningService],
})
export class AdminModule {}
