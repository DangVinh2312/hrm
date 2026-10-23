import { createContext, useContext, type ReactNode } from 'react';
import type { ReportClient } from './report.client';

const ReportContext = createContext<ReportClient | undefined>(undefined);

/** Report API client, created once by the composition root (app.tsx) and faked in tests. */
export function ReportServicesProvider(props: {
  readonly client: ReportClient;
  readonly children: ReactNode;
}) {
  return <ReportContext.Provider value={props.client}>{props.children}</ReportContext.Provider>;
}

export function useReportClient(): ReportClient {
  const value = useContext(ReportContext);
  if (!value) throw new Error('useReportClient must be used inside ReportServicesProvider');
  return value;
}
