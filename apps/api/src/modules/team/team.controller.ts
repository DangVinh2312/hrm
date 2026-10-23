import { CompanyAction, CompanyResource } from '../permission/permission-authorization.types.js';
import { TeamAction, TeamResource } from './team-authorization.types.js';
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
} from '../../infrastructure/helpers/http-security.helper.js';
import { hrUuid } from '../hr/helpers/hr-input.helper.js';
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
  @ProductAuthorize(TeamResource.Team, TeamAction.Read)
  list(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.teams.list(this.secret(req), parseTeamList(query));
  }

  @HttpCode(201)
  @Post()
  @ProductAuthorize(CompanyResource.Company, CompanyAction.CreateTeam)
  create(@Req() req: HttpRequest, @Body() body: unknown) {
    const secret = this.mutation(req);
    return this.teams.create(secret, parseTeamCreate(body));
  }

  @Get(':id')
  @ProductAuthorize(TeamResource.Team, TeamAction.Read)
  async detail(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.teams.detail(this.secret(req), hrUuid(id)));
  }

  @Patch(':id')
  @ProductAuthorize(TeamResource.Team, TeamAction.Update)
  async rename(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.rename(secret, parseTeamRename(id, body)));
  }

  @HttpCode(200)
  @Post(':id/members')
  @ProductAuthorize(TeamResource.Team, TeamAction.Assign)
  async addMember(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.addMember(secret, parseTeamMember(id, body)));
  }

  @HttpCode(200)
  @Post(':id/members/:employeeId/primary')
  @ProductAuthorize(TeamResource.Team, TeamAction.Assign)
  async setPrimary(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    const secret = this.mutation(req);
    return found(await this.teams.setPrimary(secret, parseMembership(id, employeeId)));
  }

  @Delete(':id/members/:employeeId')
  @ProductAuthorize(TeamResource.Team, TeamAction.Assign)
  async endMembership(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    const secret = this.mutation(req);
    return found(await this.teams.endMembership(secret, parseMembership(id, employeeId)));
  }

  @Put(':id/lead')
  @ProductAuthorize(TeamResource.Team, TeamAction.Assign)
  async assignLead(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.teams.assignLead(secret, parseTeamLead(id, body)));
  }
}
