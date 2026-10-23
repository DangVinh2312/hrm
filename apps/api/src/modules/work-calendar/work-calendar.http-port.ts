import type { AppConfig } from '../../config/app.config.js';
import type { WorkCalendarService } from './work-calendar.service.js';

export const WORK_CALENDAR_HTTP_PORT = Symbol('WORK_CALENDAR_HTTP_PORT');

/** Bound work calendar operations (T4). */
export interface WorkCalendarHttpPort extends Pick<
  WorkCalendarService,
  'year' | 'setDay' | 'setHolidays'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
