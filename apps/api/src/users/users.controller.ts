import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { CreateUserRequest, Pagination, UpdateUserRequest, type Page, type UserDto } from '@touchline/shared';
import { parse } from '../errors.js';
import { Roles, type AuthedRequest } from '../auth/decorators.js';
import { UsersService } from './users.service.js';

@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: unknown): Promise<Page<UserDto>> {
    return this.users.list(req.user!, parse(Pagination, query));
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() body: unknown): Promise<UserDto> {
    return this.users.create(req.user!, parse(CreateUserRequest, body), req.ip);
  }

  @Patch(':id')
  update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<UserDto> {
    return this.users.update(req.user!, id, parse(UpdateUserRequest, body), req.ip);
  }
}
