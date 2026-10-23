import { createContext, useContext, type ReactNode } from 'react';
import type { AttendanceClient } from './attendance.client';

const AttendanceContext = createContext<AttendanceClient | undefined>(undefined);

/** Attendance API client, created once by the composition root (app.tsx) and faked in tests. */
export function AttendanceServicesProvider(props: {
  readonly client: AttendanceClient;
  readonly children: ReactNode;
}) {
  return (
    <AttendanceContext.Provider value={props.client}>{props.children}</AttendanceContext.Provider>
  );
}

export function useAttendanceClient(): AttendanceClient {
  const value = useContext(AttendanceContext);
  if (!value) throw new Error('useAttendanceClient must be used inside AttendanceServicesProvider');
  return value;
}
