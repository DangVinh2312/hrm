import type { ProductAuthorization } from '../../authorization/services/product-authority.service.js';
import { ProductAccessDenied } from '../../authorization/services/product-authority.types.js';
import type { WorkScheduleCommandRepository } from './repositories/work-schedule-command.repository.js';
import type { WorkScheduleReadRepository } from './repositories/work-schedule-read.repository.js';
import type {
  CompanyScheduleInput,
  CompanyScheduleView,
  EmployeeFrameInput,
  EmployeeFrameKey,
  EmployeeFramesView,
  EmployeeScheduleQuery,
  EmployeeScheduleView,
} from './work-schedule.types.js';

export const workScheduleCommands = (commands: WorkScheduleCommandRepository) =>
  [
    commands.putCompanySchedule,
    commands.deleteCompanySchedule,
    commands.addEmployeeFrame,
    commands.endEmployeeFrame,
  ] as const;

export const workScheduleQueries = (reads: WorkScheduleReadRepository) =>
  [reads.companySchedule, reads.employeeFrames, reads.employeeDays] as const;

/**
 * Working hours (ADR-19) bound to the registered commands/queries. `undefined` is absent or not
 * visible (HTTP 404); the calendar anchor always exists, so not reaching it is a missing grant (403).
 */
export class WorkScheduleService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly commands: WorkScheduleCommandRepository,
    private readonly reads: WorkScheduleReadRepository,
  ) {}

  companySchedule(secret: string): Promise<CompanyScheduleView | undefined> {
    return this.authorization.query(secret, this.reads.companySchedule, undefined);
  }

  async putCompanySchedule(secret: string, input: CompanyScheduleInput) {
    const changed = await this.authorization.execute(
      secret,
      this.commands.putCompanySchedule,
      input,
    );
    if (!changed) throw new ProductAccessDenied();
    return changed;
  }

  async deleteCompanySchedule(secret: string, effectiveFrom: string) {
    const removed = await this.authorization.execute(secret, this.commands.deleteCompanySchedule, {
      effectiveFrom,
    });
    if (!removed) throw new ProductAccessDenied();
    return removed;
  }

  employeeFrames(secret: string, employeeId: string): Promise<EmployeeFramesView | undefined> {
    return this.authorization.query(secret, this.reads.employeeFrames, { employeeId });
  }

  addEmployeeFrame(secret: string, input: EmployeeFrameInput) {
    return this.authorization.execute(secret, this.commands.addEmployeeFrame, input);
  }

  endEmployeeFrame(secret: string, key: EmployeeFrameKey) {
    return this.authorization.execute(secret, this.commands.endEmployeeFrame, key);
  }

  employeeDays(
    secret: string,
    query: EmployeeScheduleQuery,
  ): Promise<EmployeeScheduleView | undefined> {
    return this.authorization.query(secret, this.reads.employeeDays, query);
  }
}
