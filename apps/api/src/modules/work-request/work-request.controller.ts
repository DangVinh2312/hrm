import { EmployeeAction, EmployeeResource } from '../employee/employee-authorization.types.js';
import { WorkRequestAction, WorkRequestResource } from './work-request-authorization.types.js';
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
import {
  ProductAuthenticated,
  ProductAuthorize,
} from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { inputUuid } from '../../infrastructure/helpers/input-validation.helper.js';
import { WORK_REQUEST_HTTP_PORT, type WorkRequestHttpPort } from './work-request.http-port.js';
import {
  parseCancel,
  parseDecision,
  parseIdempotencyKey,
  parseRequestList,
  parseSubmitRequest,
} from './work-request.validator.js';

const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new NotFoundException();
  return value;
};

/**
 * Own work requests (T5: submit, list, detail) and decisions on others' (T6: decide, queues,
 * decided history).
 * Absent and not visible are the same 404.
 */
@Controller('api/hr')
export class WorkRequestController {
  constructor(@Inject(WORK_REQUEST_HTTP_PORT) private readonly requests: WorkRequestHttpPort) {}

  /** Exact Origin and CSRF token before any input is parsed; the key makes a retry safe. */
  @HttpCode(201)
  @Post('requests')
  @ProductAuthorize(EmployeeResource.Employee, EmployeeAction.SubmitRequest)
  async submit(@Req() req: HttpRequest, @Body() body: unknown) {
    enforceCsrf(req, this.requests.config);
    const secret = sessionSecret(req, this.requests.config);
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    return found(await this.requests.submit(secret, key, parseSubmitRequest(body)));
  }

  @Get('requests')
  @ProductAuthorize(WorkRequestResource.WorkRequest, WorkRequestAction.Read)
  list(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.requests.list(sessionSecret(req, this.requests.config), parseRequestList(query));
  }

  @Get('requests/:id')
  @ProductAuthorize(WorkRequestResource.WorkRequest, WorkRequestAction.Read)
  async detail(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(
      await this.requests.detail(sessionSecret(req, this.requests.config), inputUuid(id)),
    );
  }

  /**
   * Approve or reject the request at its current stage. The permission (workRequest.decideLead
   * or decideFinal) follows the stored state, never the caller, so the route is classified by
   * session only; the service authorizes the stage on the locked row.
   */
  @HttpCode(200)
  @Post('requests/:id/decision')
  @ProductAuthenticated()
  async decide(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    enforceCsrf(req, this.requests.config);
    const secret = sessionSecret(req, this.requests.config);
    const input = parseDecision(body, id, req.headers['idempotency-key']);
    return found(await this.requests.decide(secret, input));
  }

  /**
   * Cancel at the current state: the owner a pending request, HR (fresh) an approved one with a
   * reason. The permission follows the stored state, never the caller, so the route is classified
   * by session only and the service authorizes on the locked row (like `decision`).
   */
  @HttpCode(200)
  @Post('requests/:id/cancel')
  @ProductAuthenticated()
  async cancel(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    enforceCsrf(req, this.requests.config);
    const secret = sessionSecret(req, this.requests.config);
    const input = parseCancel(body, id, req.headers['idempotency-key']);
    return found(await this.requests.cancel(secret, input));
  }

  /** Requests waiting for the caller as their current Team Lead, oldest first. */
  @Get('approvals/lead')
  @ProductAuthorize(WorkRequestResource.WorkRequest, WorkRequestAction.DecideLead)
  leadQueue(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.requests.leadQueue(
      sessionSecret(req, this.requests.config),
      parseRequestList(query),
    );
  }

  /** Requests waiting for the final decision (COO), oldest first; never the caller's own. */
  @Get('approvals/final')
  @ProductAuthorize(WorkRequestResource.WorkRequest, WorkRequestAction.DecideFinal)
  finalQueue(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.requests.finalQueue(
      sessionSecret(req, this.requests.config),
      parseRequestList(query),
    );
  }

  /** Requests decided in the caller's approval scope, latest decision first; never their own. */
  @Get('approvals/decided')
  @ProductAuthorize(WorkRequestResource.WorkRequest, WorkRequestAction.ReadDecided)
  decided(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.requests.decided(sessionSecret(req, this.requests.config), parseRequestList(query));
  }
}
