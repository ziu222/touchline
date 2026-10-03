import 'reflect-metadata';
import './env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ErrorFilter } from './errors.js';

export async function createApp(logger = true) {
  const app = await NestFactory.create(AppModule, logger ? {} : { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}
