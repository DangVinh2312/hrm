import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ProductAuthenticationError } from '../auth/services/product-identity.service.js';
import { ProductMfaConflict, ProductStepUpRequired } from '../auth/services/product-mfa.service.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../authorization/services/product-authority.service.js';
import { ProductInvalidRequest } from '../authorization/product-data.gateway.js';
import { TransactionConflictError } from '../database/helpers/transaction-errors.helper.js';
import { type ApiErrorBody, ApiRejection, apiErrorCode } from './helpers/api-error.helper.js';

const logger = new Logger('ProductErrorFilter');

@Catch()
export class ProductErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const status =
      error instanceof ApiRejection
        ? error.status
        : error instanceof HttpException
          ? error.getStatus()
          : error instanceof ProductAuthenticationError
            ? 401
            : error instanceof ProductAccessDenied || error instanceof ProductStepUpRequired
              ? 403
              : error instanceof ProductInvalidRequest
                ? 400
                : error instanceof TransactionConflictError ||
                    error instanceof ProductCommandRejected ||
                    error instanceof ProductMfaConflict
                  ? 409
                  : 503;
    // Unexpected faults stay diagnosable without leaking input: messages and driver details
    // (query, parameters, detail) may carry secrets or PII, so only type, SQLSTATE and frames.
    // Deliberate HTTP responses (e.g. 503 for an unconfigured capability) are not faults.
    if (status >= 500 && !(error instanceof HttpException)) {
      const e = error instanceof Error ? error : undefined;
      const code = (error as { code?: unknown } | null)?.code;
      logger.error(
        `${e?.constructor.name ?? typeof error}${typeof code === 'string' ? ` ${code}` : ''}`,
        // Frames follow the header, which repeats name and message (possibly multi-line).
        e?.stack
          ?.split('\n')
          .slice(String(e).split('\n').length)
          .filter((line) => /^\s+at /.test(line))
          .join('\n'),
      );
    }
    const response = host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(value: unknown): void } }>();
    const body: ApiErrorBody = {
      statusCode: status,
      code: error instanceof ApiRejection ? error.code : apiErrorCode(status),
    };
    response.status(status).json(body);
  }
}
