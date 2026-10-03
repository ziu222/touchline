import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from '../prisma.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [PrismaService, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [PrismaService, AuthService],
})
export class AuthModule {}
