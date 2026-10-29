/**
 * Business date today: the DB statement clock in the fixed business timezone, never
 * the API host's clock or zone. SQL fragment without parameters.
 */
export const BUSINESS_TODAY = "(statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";

/** Current row of a validity window on the statement clock (same rule as the scope views). */
export const currentWindow = (alias: string) =>
  `${alias}.starts_at <= statement_timestamp() AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > statement_timestamp())`;
