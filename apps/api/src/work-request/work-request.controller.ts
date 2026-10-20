import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../infrastructure/http-security.helper.js';
import { hrUuid } from '../hr/hr-input.helper.js';
import { WORK_REQUEST_HTTP_PORT, type WorkRequestHttpPort } from './work-request.http-port.js';
import {
  parseIdempotencyKey,
  parseRequestList,
  parseSubmitRequest,
} from './work-request.validator.js';

const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new NotFoundException();
  return value;
};

/** Own work requests (T5): submit, list and detail. Absent and not visible are the same 404. */
@Controller('api/hr/requests')
export class WorkRequestController {
  constructor(@Inject(WORK_REQUEST_HTTP_PORT) private readonly requests: WorkRequestHttpPort) {}

  /** Exact Origin and CSRF token before any input is parsed; the key makes a retry safe. */
  @HttpCode(201)
  @Post()
  @ProductAuthorize('employee', 'submitRequest')
  async submit(@Req() req: HttpRequest, @Body() body: unknown) {
    enforceCsrf(req, this.requests.config);
    const secret = sessionSecret(req, this.requests.config);
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    return found(await this.requests.submit(secret, key, parseSubmitRequest(body)));
  }

  @Get()
  @ProductAuthorize('workRequest', 'read')
  list(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.requests.list(sessionSecret(req, this.requests.config), parseRequestList(query));
  }

  @Get(':id')
  @ProductAuthorize('workRequest', 'read')
  async detail(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.requests.detail(sessionSecret(req, this.requests.config), hrUuid(id)));
  }
}
