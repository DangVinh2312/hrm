import { createContext, useContext, type ReactNode } from 'react';
import type { WorkCalendarClient } from './work-calendar.client';

const WorkCalendarContext = createContext<WorkCalendarClient | undefined>(undefined);

/** WorkCalendar API client, created once by the composition root (app.tsx) and faked in tests. */
export function WorkCalendarServicesProvider(props: {
  readonly client: WorkCalendarClient;
  readonly children: ReactNode;
}) {
  return (
    <WorkCalendarContext.Provider value={props.client}>
      {props.children}
    </WorkCalendarContext.Provider>
  );
}

export function useWorkCalendarClient(): WorkCalendarClient {
  const value = useContext(WorkCalendarContext);
  if (!value)
    throw new Error('useWorkCalendarClient must be used inside WorkCalendarServicesProvider');
  return value;
}
