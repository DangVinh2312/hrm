import type { AppConfig } from '../../config/app.config.js';
import type { WorkScheduleService } from './work-schedule.service.js';

export const WORK_SCHEDULE_HTTP_PORT = Symbol('WORK_SCHEDULE_HTTP_PORT');

/** Bound working-hours operations (ADR-19). */
export interface WorkScheduleHttpPort extends Pick<
  WorkScheduleService,
  | 'companySchedule'
  | 'putCompanySchedule'
  | 'deleteCompanySchedule'
  | 'employeeFrames'
  | 'addEmployeeFrame'
  | 'endEmployeeFrame'
  | 'employeeDays'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
