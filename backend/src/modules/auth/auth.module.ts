import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { LoginFailuresService } from './login/login-failures.service.js';
import { LoginService } from './login/login.service.js';
import { OtpChallengeService } from './otp/otp-challenge.service.js';
import { PasswordService } from './password/password.service.js';
import { OtpRequestService } from './registration/otp-request.service.js';
import { PasswordResetService } from './registration/password-reset.service.js';
import { RegistrationService } from './registration/registration.service.js';
import { DeviceService } from './sessions/device.service.js';
import { SessionService } from './sessions/session.service.js';
import { StaffAuthController } from './staff-auth.controller.js';
import { StaffAuthService } from './staff/staff-auth.service.js';

@Module({
  controllers: [AuthController, StaffAuthController],
  providers: [
    PasswordService,
    OtpChallengeService,
    DeviceService,
    SessionService,
    LoginFailuresService,
    LoginService,
    OtpRequestService,
    RegistrationService,
    PasswordResetService,
    StaffAuthService,
  ],
  exports: [
    PasswordService,
    OtpChallengeService,
    DeviceService,
    SessionService,
    LoginFailuresService,
  ],
})
export class AuthModule {}
