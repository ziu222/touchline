import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { RateLimitModule } from './rate-limit.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

// AuthModule first: its global guard must run before the throttler so req.user is set.
@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [HealthController, UsersController],
  providers: [UsersService],
})
export class AppModule {}
