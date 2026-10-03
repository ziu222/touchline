import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  AddToShortlistRequest,
  ClearanceRequest,
  CreateNeedRequest,
  NeedQuery,
  ShortlistQuery,
  TransitionRequest,
  UpdateNeedRequest,
  type ClearanceDto,
  type NeedDto,
  type Page,
  type ShortlistEntryDto,
  type StageHistoryDto,
} from '@touchline/shared';
import { parse } from '../errors.js';
import { Roles, type AuthedRequest } from '../auth/decorators.js';
import { NeedsService } from './needs.service.js';
import { ShortlistService } from './shortlist.service.js';

const uuid = () => new ParseUUIDPipe();

// spec mục 8
@Controller('needs')
export class NeedsController {
  constructor(
    private readonly needs: NeedsService,
    private readonly shortlist: ShortlistService,
  ) {}

  @Get()
  @Roles('sporting_director', 'head_recruitment', 'analyst', 'head_coach')
  list(@Req() req: AuthedRequest, @Query() query: unknown): Promise<Page<NeedDto>> {
    return this.needs.list(req.user!, parse(NeedQuery, query));
  }

  @Post()
  @Roles('sporting_director', 'head_recruitment')
  create(@Req() req: AuthedRequest, @Body() body: unknown): Promise<NeedDto> {
    return this.needs.create(req.user!, parse(CreateNeedRequest, body));
  }

  @Get(':id')
  @Roles('sporting_director', 'head_recruitment', 'analyst', 'head_coach')
  get(@Req() req: AuthedRequest, @Param('id', uuid()) id: string): Promise<NeedDto> {
    return this.needs.get(req.user!, id);
  }

  @Patch(':id')
  @Roles('sporting_director', 'head_recruitment')
  update(@Req() req: AuthedRequest, @Param('id', uuid()) id: string, @Body() body: unknown): Promise<NeedDto> {
    return this.needs.update(req.user!, id, parse(UpdateNeedRequest, body));
  }

  @Get(':id/shortlist')
  @Roles('sporting_director', 'head_recruitment', 'analyst', 'head_coach')
  shortlistOf(@Req() req: AuthedRequest, @Param('id', uuid()) id: string, @Query() query: unknown): Promise<ShortlistEntryDto[]> {
    return this.shortlist.listForNeed(req.user!, id, parse(ShortlistQuery, query).stage);
  }

  @Post(':id/shortlist')
  @Roles('sporting_director', 'head_recruitment', 'analyst')
  addToShortlist(@Req() req: AuthedRequest, @Param('id', uuid()) id: string, @Body() body: unknown): Promise<ShortlistEntryDto> {
    return this.shortlist.add(req.user!, id, parse(AddToShortlistRequest, body).player_id);
  }
}

@Controller('shortlist')
export class ShortlistController {
  constructor(private readonly shortlist: ShortlistService) {}

  @Post(':entryId/accept')
  @HttpCode(200)
  @Roles('sporting_director', 'head_recruitment')
  accept(@Req() req: AuthedRequest, @Param('entryId', uuid()) entryId: string): Promise<ShortlistEntryDto> {
    return this.shortlist.accept(req.user!, entryId);
  }

  // Kanban drag-and-drop calls this same endpoint (US-08); there is no other way to move a card.
  @Post(':entryId/transitions')
  @HttpCode(200)
  @Roles('sporting_director', 'head_recruitment')
  transition(@Req() req: AuthedRequest, @Param('entryId', uuid()) entryId: string, @Body() body: unknown): Promise<ShortlistEntryDto> {
    return this.shortlist.transition(req.user!, entryId, parse(TransitionRequest, body));
  }

  @Get(':entryId/history')
  @Roles('sporting_director', 'head_recruitment')
  history(@Req() req: AuthedRequest, @Param('entryId', uuid()) entryId: string): Promise<StageHistoryDto[]> {
    return this.shortlist.history(req.user!, entryId);
  }

  @Post(':entryId/medical-clearance')
  @Roles('doctor')
  clearance(@Req() req: AuthedRequest, @Param('entryId', uuid()) entryId: string, @Body() body: unknown): Promise<ClearanceDto> {
    return this.shortlist.recordClearance(req.user!, entryId, parse(ClearanceRequest, body), req.ip);
  }
}
