// Shared by the export limit/disconnect/measurement specs (T9 part B, item 2): a bulk synthetic
// employee set written with the data login (the INSERT grants and object registry the employee command uses)
// and the REAL ReportController behind a real HTTP listener, with the report port injectable so a
// test can slow one step down. Synthetic people only.
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../dist/config/app.config.js';
import { cookieName } from '../dist/infrastructure/helpers/http-security.helper.js';
import { ProductErrorFilter } from '../dist/infrastructure/product-error.filter.js';
import { REPORT_HTTP_PORT, type ReportHttpPort } from '../dist/modules/report/report.http-port.js';
import { ReportController } from '../dist/modules/report/report.controller.js';
import type { HrStack } from './hrm-stack.helper.ts';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:3000',
  OIDC_PROVIDERS_JSON: JSON.stringify([
    {
      issuer: 'https://idp.example.test',
      clientId: 'fixture-client',
      redirectUri: 'http://localhost:3000/api/auth/oidc/callback',
      version: '1',
      assuranceMappings: [],
    },
  ]),
  MFA_ENCRYPTION_KEYS: 'fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  MFA_ENCRYPTION_KEY_ID: 'fixture',
  ...Object.fromEntries(
    ['data', 'identity', 'authority', 'sync'].map((p) => [
      `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
      `postgres://product_${p}:synthetic@localhost/product`,
    ]),
  ),
});

/**
 * Employees `from..to` (inclusive), all hired 2025-01-06 with identity, one status period and one
 * leave rate, so every one of the six reports lists each of them once per period. Ids are
 * deterministic so the statements can be separate.
 */
export async function insertEmployees(stack: HrStack, from: number, to: number): Promise<void> {
  const ids = `('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid`;
  const rates = `('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid`;
  const series = 'FROM generate_series(CAST($1 AS int), CAST($2 AS int)) g';
  const range = [from, to];
  await stack.pools.data.query(
    `INSERT INTO employee(id, object_id, code, full_name, hired_on)
     SELECT ${ids}, public.hr_register_object('employee', ${ids}), 'B' || lpad(g::text, 6, '0'),
            'Nhân viên tải ' || g, DATE '2025-01-06' ${series}`,
    range,
  );
  await stack.pools.data.query(
    `INSERT INTO employee_identity(employee_id, object_id, date_of_birth)
     SELECT ${ids}, public.hr_register_object('employeeIdentity', ${ids}),
            DATE '1980-01-01' + (g * 37 % 9000) ${series}`,
    range,
  );
  await stack.pools.data.query(
    `INSERT INTO employment_status_period(id, employee_id, status, starts_on)
     SELECT ${rates}, ${ids}, 'official', DATE '2025-01-06' ${series}`,
    range,
  );
  await stack.pools.data.query(
    `INSERT INTO leave_rate(id, object_id, employee_id, effective_from, annual_minutes)
     SELECT ${rates}, public.hr_register_object('leaveRate', ${rates}), ${ids}, DATE '2025-01-06', 5760 ${series}`,
    range,
  );
}

/**
 * Approved March 2026 history for employees `from..to`: one annual-leave day, one unpaid day, two
 * WFH days, one late arrival and one early departure each (six segments over five requests), so
 * the attendance/leave/late-early/wfh reports have real effects to fold. Written with the data
 * login like the commands do; `owner` is any account id, `team` a team id.
 */
export async function insertApprovedHistory(
  stack: HrStack,
  owner: string,
  team: string,
  from: number,
  to: number,
): Promise<void> {
  const requests = `
    SELECT g, k.slot, k.kind, ('00000000-0000-4000-a000-' || lpad((g * 10 + k.slot)::text, 12, '0'))::uuid AS id
      FROM generate_series(CAST($1 AS int), CAST($2 AS int)) g,
           (VALUES (1,'annual-leave'),(2,'unpaid-leave'),(3,'wfh'),(4,'late-arrival'),(5,'early-departure')) k(slot, kind)`;
  await stack.pools.data.query(
    `INSERT INTO work_request(id, object_id, employee_id, owner_account_id, team_id, kind, state, reason)
     SELECT r.id, public.hr_register_object('workRequest', r.id),
            ('00000000-0000-4000-8000-' || lpad(r.g::text, 12, '0'))::uuid, CAST($3 AS uuid), CAST($4 AS uuid), r.kind, 'approved', 'Đơn tải'
       FROM (${requests}) r`,
    [from, to, owner, team],
  );
  await stack.pools.data.query(
    `INSERT INTO work_request_segment(request_id, kind, work_date, start_minute, end_minute, minutes)
     SELECT r.id, r.kind, d.day, d.s, d.e, d.m
       FROM (${requests}) r
       JOIN (VALUES (1,'annual-leave',DATE '2026-03-04',540,1080,480),
                    (2,'unpaid-leave',DATE '2026-03-10',540,1080,480),
                    (3,'wfh',DATE '2026-03-11',540,1080,480),
                    (3,'wfh',DATE '2026-03-12',540,1080,480),
                    (4,'late-arrival',DATE '2026-03-17',540,600,60),
                    (5,'early-departure',DATE '2026-03-18',1020,1080,60)) d(slot, kind, day, s, e, m)
         ON d.slot = r.slot`,
    [from, to],
  );
}

export interface ReportHttp {
  readonly url: string;
  readonly app: INestApplication;
  readonly server: Server;
  /** Every response object the server handed to a handler, with its `close` listener count then. */
  readonly responses: { readonly res: NodeJS.EventEmitter; readonly listenersAtStart: number }[];

  /** Headers carrying `secret` as the session cookie. */
  headers(secret: string): Record<string, string>;

  stop(): Promise<void>;
}

/** The real controller over a real listener on a random loopback port. */
export async function startReportHttp(
  port: Omit<ReportHttpPort, 'config'>,
  options: { readonly logger?: false } = { logger: false },
): Promise<ReportHttp> {
  class ReportHttpTestModule {}
  Module({
    controllers: [ReportController],
    providers: [{ provide: REPORT_HTTP_PORT, useValue: { ...port, config } }],
  })(ReportHttpTestModule);
  const app = await NestFactory.create(ReportHttpTestModule, { logger: options.logger ?? false });
  app.useGlobalFilters(new ProductErrorFilter());
  const responses: ReportHttp['responses'] = [];
  app.use((_req: unknown, res: NodeJS.EventEmitter, next: () => void) => {
    responses.push({ res, listenersAtStart: res.listenerCount('close') });
    next();
  });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    app,
    server,
    responses,
    headers: (secret) => ({ cookie: `${cookieName(config, 'session')}=${secret}` }),
    stop: () => app.close(),
  };
}
