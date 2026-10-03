import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { LoginRequest, RefreshRequest, type AuthTokens } from '@touchline/shared';
import { Throttle } from '@nestjs/throttler';
import { parse } from '../errors.js';
import { LOGIN_THROTTLE } from '../rate-limit.js';
import { AuthService } from './auth.service.js';
import { AnyRole, Public, type AuthedRequest } from './decorators.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown): Promise<AuthTokens> {
    const { email, password } = parse(LoginRequest, body);
    return this.auth.login(email, password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<AuthTokens> {
    return this.auth.refresh(parse(RefreshRequest, body).refresh_token);
  }

  @AnyRole()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Body() body: unknown): Promise<void> {
    await this.auth.logout(req.user!.id, parse(RefreshRequest, body).refresh_token);
  }
}
