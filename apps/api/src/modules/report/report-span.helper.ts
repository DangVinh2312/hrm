import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import type { ReportMonths } from './report.types.js';

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));

/** Number of months in the inclusive `YYYY-MM` range (negative or zero when `to` precedes `from`). */
export const monthSpan = ({ from, to }: ReportMonths): number =>
  monthIndex(to) - monthIndex(from) + 1;

/**
 * The monthly reports cover at most `report.maxMonths` months (ADR 0041 §5). The validator only
 * refuses what no setting could allow (more than the 12-month ceiling); this is the check against
 * the value in force, run where the setting is read, before the report query.
 */
export function assertReportSpan(range: ReportMonths, maxMonths: number): void {
  const span = monthSpan(range);
  if (span < 1 || span > maxMonths) throw new ProductInvalidRequest('Invalid range');
}
