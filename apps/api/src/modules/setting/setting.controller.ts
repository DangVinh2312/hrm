import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
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
import { SettingAction, SettingResource } from './setting-authorization.types.js';
import { SETTING_HTTP_PORT, type SettingHttpPort } from './setting.http-port.js';
import {
  parseSettingHistoryQuery,
  parseSettingKey,
  parseSettingUpdate,
} from './setting.validator.js';

/**
 * Setting routes (ADR 0041 §5). Reading is `setting.read` (rules, profile, history, security) or
 * `setting.readProfile` (company name and language only); writing is one route per group so the
 * permission checked is the one the key needs: `updateRule` or `updateProfile`. Static segments are
 * declared before `:key` so they cannot be captured by it.
 */
@Controller('api/administration/settings')
export class SettingController {
  constructor(@Inject(SETTING_HTTP_PORT) private readonly settings: SettingHttpPort) {}

  @Get()
  @ProductAuthorize(SettingResource.Setting, SettingAction.Read)
  async list(@Req() req: HttpRequest) {
    const view = await this.settings.list(sessionSecret(req, this.settings.config));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Get('profile')
  @ProductAuthorize(SettingResource.Setting, SettingAction.ReadProfile)
  async profile(@Req() req: HttpRequest) {
    const view = await this.settings.profile(sessionSecret(req, this.settings.config));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Get('security')
  @ProductAuthorize(SettingResource.Setting, SettingAction.Read)
  async security(@Req() req: HttpRequest) {
    const view = await this.settings.security(sessionSecret(req, this.settings.config));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Get(':key/history')
  @ProductAuthorize(SettingResource.Setting, SettingAction.Read)
  async history(@Req() req: HttpRequest, @Param('key') key: string, @Query() query: unknown) {
    const parsedKey = parseSettingKey(key);
    const page = parseSettingHistoryQuery(query);
    const view = await this.settings.history(
      sessionSecret(req, this.settings.config),
      parsedKey,
      page,
    );
    if (!view) throw new NotFoundException();
    return view;
  }

  /** Exact Origin and CSRF token before any input is parsed. */
  @Put('rule/:key')
  @ProductAuthorize(SettingResource.Setting, SettingAction.UpdateRule)
  updateRule(@Req() req: HttpRequest, @Param('key') key: string, @Body() body: unknown) {
    enforceCsrf(req, this.settings.config);
    const secret = sessionSecret(req, this.settings.config);
    return this.settings.update(secret, parseSettingUpdate('rule', key, body));
  }

  @Put('profile/:key')
  @ProductAuthorize(SettingResource.Setting, SettingAction.UpdateProfile)
  updateProfile(@Req() req: HttpRequest, @Param('key') key: string, @Body() body: unknown) {
    enforceCsrf(req, this.settings.config);
    const secret = sessionSecret(req, this.settings.config);
    return this.settings.update(secret, parseSettingUpdate('profile', key, body));
  }
}
