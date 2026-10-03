import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import {
  PlayerQuery,
  SimilarQuery,
  type Page,
  type PlayerProfile,
  type PlayerSummary,
  type SimilarResponse,
} from '@touchline/shared';
import { parse } from '../errors.js';
import { Roles, type AuthedRequest } from '../auth/decorators.js';
import { PlayersService } from './players.service.js';

// spec mục 2: every recruitment role may look at players (scope differs per role); admin may not
const PLAYER_READERS = ['sporting_director', 'head_recruitment', 'scout', 'analyst', 'doctor', 'head_coach'] as const;

@Controller('players')
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  @Roles(...PLAYER_READERS)
  list(@Req() req: AuthedRequest, @Query() query: unknown): Promise<Page<PlayerSummary>> {
    return this.players.list(req.user!, parse(PlayerQuery, query));
  }

  @Get(':id')
  @Roles(...PLAYER_READERS)
  profile(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string): Promise<PlayerProfile> {
    return this.players.profile(req.user!, id);
  }

  @Get(':id/similar')
  @Roles('sporting_director', 'head_recruitment', 'analyst')
  similar(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
  ): Promise<SimilarResponse> {
    return this.players.similar(req.user!, id, parse(SimilarQuery, query));
  }
}
