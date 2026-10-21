import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/http-security.helper.js';
import { hrUuid } from '../hr/hr-input.helper.js';
import { TEAM_HTTP_PORT, type TeamHttpPort } from './team.http-port.js';
import {
  parseMembership,
  parseTeamCreate,
  parseTeamLead,
  parseTeamList,
  parseTeamMember,
  parseTeamRename,
} from './team.validator.js';

const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new NotFoundException();
  return value;
};

/** Team, membership and lead routes (T3). Assignments are facts: exclusive fence, fresh auth. */
@Controller('api/hr/teams')
export class TeamController {
  constructor(@Inject(TEAM_HTTP_PORT) private readonly teams: TeamHttpPort) {}

  private secret(req: HttpRequest): string {
    return sessionSecret(req, this.teams.config);
  }

  /** Mutations: exact Origin and CSRF token before any input is parsed. */
  private mutation(req: HttpRequest): string {
    enforceCsrf(req, this.teams.config);
    return this.secret(req);
  }

  @Get()
  @ProductAuthorize('team', 'read')
  list(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.teams.list(this.secret(req), parseTeamList(query));
  }

  @HttpCode(201)
  @Post()
  @ProductAuthorize('hrCompany', 'createTeam')
  create(@Req() req: HttpRequest, @Body() body: unknown) {
    const secret = this.mutation(req);
    return this.teams.create(secret, parseTeamCreate(body));
  }

  @Get(':id')
  @ProductAuthorize('team', 'read')
  async detail(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.teams.detail(this.secret(req), hrUuid(id)));
  }

  @Patch(':id')
  @ProductAuthorize('team', 'update')
  async rename(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.rename(secret, parseTeamRename(id, body)));
  }

  @HttpCode(200)
  @Post(':id/members')
  @ProductAuthorize('team', 'assign')
  async addMember(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.addMember(secret, parseTeamMember(id, body)));
  }

  @HttpCode(200)
  @Post(':id/members/:employeeId/primary')
  @ProductAuthorize('team', 'assign')
  async setPrimary(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    const secret = this.mutation(req);
    return found(await this.teams.setPrimary(secret, parseMembership(id, employeeId)));
  }

  @Delete(':id/members/:employeeId')
  @ProductAuthorize('team', 'assign')
  async endMembership(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    const secret = this.mutation(req);
    return found(await this.teams.endMembership(secret, parseMembership(id, employeeId)));
  }

  @Put(':id/lead')
  @ProductAuthorize('team', 'assign')
  async assignLead(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.assignLead(secret, parseTeamLead(id, body)));
  }
}
