import { Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler';
import { createClient } from 'redis';
import { requireEnv } from './env.js';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const perMinute = (name: string, fallback: number) => () => Number(process.env[name] ?? fallback);

// spec mục 8: 10/min per IP on login, 120/min per user elsewhere
export const LOGIN_THROTTLE = { default: { ttl: 60_000, limit: perMinute('RATE_LIMIT_LOGIN_PER_MIN', 10) } };

// Fixed window: INCR, set expiry on the first hit, return hits and remaining ms.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { hits, redis.call('PTTL', KEYS[1]) }`;

const OPEN: ThrottlerStorageRecord = { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  private readonly prefix = process.env.RATE_LIMIT_PREFIX ?? 'rl:';
  // offline queue off: when Redis is down commands fail fast instead of hanging requests
  private readonly client = createClient({ url: requireEnv('REDIS_URL'), disableOfflineQueue: true });

  constructor() {
    this.client.on('error', (err: Error) => this.logger.warn(`redis: ${err.message}`));
    this.client.connect().catch(() => undefined);
  }

  async increment(key: string, ttl: number, limit: number): Promise<ThrottlerStorageRecord> {
    // fail open: Redis down must not take login down (docs/system-design.md §6)
    if (!this.client.isReady) return OPEN;
    try {
      const [hits, pttl] = (await this.client.eval(INCREMENT, {
        keys: [this.prefix + key],
        arguments: [String(ttl)],
      })) as [number, number];
      const timeToExpire = Math.max(1, Math.ceil(pttl / 1000));
      const isBlocked = hits > limit;
      return { totalHits: hits, timeToExpire, isBlocked, timeToBlockExpire: isBlocked ? timeToExpire : 0 };
    } catch {
      return OPEN;
    }
  }

  async onModuleDestroy() {
    if (this.client.isOpen) this.client.destroy();
  }
}

// Runs after AuthGuard (registered later), so authenticated requests are counted per user, others per IP.
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ?? req.ip;
  }
}

@Module({ providers: [RedisThrottlerStorage], exports: [RedisThrottlerStorage] })
class RedisStorageModule {}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RedisStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: perMinute('RATE_LIMIT_USER_PER_MIN', 120) }],
        storage,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
export class RateLimitModule {}
