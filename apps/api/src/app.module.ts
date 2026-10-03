import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';

@Module({ imports: [AuthModule], controllers: [HealthController] })
export class AppModule {}
