import { createContext, useContext, type ReactNode } from 'react';
import type { LeaveClient } from './leave.client';

const LeaveContext = createContext<LeaveClient | undefined>(undefined);

/** Leave API client, created once by the composition root (app.tsx) and faked in tests. */
export function LeaveServicesProvider(props: {
  readonly client: LeaveClient;
  readonly children: ReactNode;
}) {
  return <LeaveContext.Provider value={props.client}>{props.children}</LeaveContext.Provider>;
}

export function useLeaveClient(): LeaveClient {
  const value = useContext(LeaveContext);
  if (!value) throw new Error('useLeaveClient must be used inside LeaveServicesProvider');
  return value;
}
