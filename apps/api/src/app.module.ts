import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { PlayersController } from './players/players.controller.js';
import { PlayersService } from './players/players.service.js';
import { RateLimitModule } from './rate-limit.js';
import { NeedsService } from './recruitment/needs.service.js';
import { NeedsController, ShortlistController } from './recruitment/recruitment.controller.js';
import { ShortlistService } from './recruitment/shortlist.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

// AuthModule first: its global guard must run before the throttler so req.user is set.
@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [HealthController, UsersController, PlayersController, NeedsController, ShortlistController],
  providers: [UsersService, PlayersService, NeedsService, ShortlistService],
})
export class AppModule {}
