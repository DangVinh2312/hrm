export const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

export const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
