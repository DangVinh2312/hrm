import { createContext, useContext, type ReactNode } from 'react';
import type { WorkRequestClient } from './work-request.client';

const WorkRequestContext = createContext<WorkRequestClient | undefined>(undefined);

/** WorkRequest API client, created once by the composition root (app.tsx) and faked in tests. */
export function WorkRequestServicesProvider(props: {
  readonly client: WorkRequestClient;
  readonly children: ReactNode;
}) {
  return (
    <WorkRequestContext.Provider value={props.client}>{props.children}</WorkRequestContext.Provider>
  );
}

export function useWorkRequestClient(): WorkRequestClient {
  const value = useContext(WorkRequestContext);
  if (!value)
    throw new Error('useWorkRequestClient must be used inside WorkRequestServicesProvider');
  return value;
}
