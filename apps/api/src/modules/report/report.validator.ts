import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import { parseAttendanceMonth } from '../attendance/attendance.validator.js';
import { hrDate, hrPageQuery } from '../hr/helpers/hr-input.helper.js';
import type { ReportExportQuery, ReportKind, ReportQuery } from './report.types.js';

/** Longest `from..to` of a monthly report: 12 months stay within the 366-day budget (§11) [P]. */
export const REPORT_MAX_MONTHS = 12;

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));

const kinds: readonly ReportKind[] = [
  'attendance',
  'late-early',
  'wfh',
  'birthday',
  'leave',
  'seniority',
];

/**
 * `GET /api/hr/reports/:kind/export` query: the report's own keys and no `limit`/`offset` (a file
 * is the whole scoped set or a refusal, never a page); same ranges as the JSON report.
 */
export function parseReportExportQuery(kind: ReportKind, query: unknown): ReportExportQuery {
  if (typeof query === 'object' && query !== null && ('limit' in query || 'offset' in query))
    throw new ProductInvalidRequest('Invalid query');
  const { limit: _limit, offset: _offset, ...whole } = parseReportQuery(kind, query);
  void _limit;
  void _offset;
  return whole;
}

/**
 * `GET /api/hr/reports/:kind` query: input starts as `unknown`; every key is checked and a
 * missing or unknown one is refused (400). Monthly reports (birthday included) take `from` and `to` (inclusive
 * `YYYY-MM`, at most 12 months), the others an explicit cutoff `asOn` (`YYYY-MM-DD`); all take
 * `limit`/`offset` under the shared page budget. The kind comes from the route, never the query.
 */
export function parseReportQuery(kind: ReportKind, query: unknown): ReportQuery {
  if (!kinds.includes(kind)) throw new ProductInvalidRequest('Invalid report');
  if (kind === 'leave' || kind === 'seniority') {
    const { limit, offset, extra } = hrPageQuery(query, ['asOn']);
    return { kind, asOn: hrDate(extra.asOn), limit, offset };
  }
  const { limit, offset, extra } = hrPageQuery(query, ['from', 'to']);
  const from = parseAttendanceMonth(extra.from);
  const to = parseAttendanceMonth(extra.to);
  const span = monthIndex(to) - monthIndex(from) + 1;
  if (span < 1 || span > REPORT_MAX_MONTHS) throw new ProductInvalidRequest('Invalid range');
  return { kind, from, to, limit, offset };
}
