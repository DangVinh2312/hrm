import { createContext, useContext, type ReactNode } from 'react';
import type { AdministrationClient } from './administration.client';

const AdministrationContext = createContext<AdministrationClient | undefined>(undefined);

/** Administration API client, created once by the composition root (app.tsx) and faked in tests. */
export function AdministrationServicesProvider(props: {
  readonly client: AdministrationClient;
  readonly children: ReactNode;
}) {
  return (
    <AdministrationContext.Provider value={props.client}>
      {props.children}
    </AdministrationContext.Provider>
  );
}

export function useAdministrationClient(): AdministrationClient {
  const value = useContext(AdministrationContext);
  if (!value)
    throw new Error('useAdministrationClient must be used inside AdministrationServicesProvider');
  return value;
}
