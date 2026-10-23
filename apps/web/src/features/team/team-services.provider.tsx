import { createContext, useContext, type ReactNode } from 'react';
import type { TeamClient } from './team.client';

const TeamContext = createContext<TeamClient | undefined>(undefined);

/** Team API client, created once by the composition root (app.tsx) and faked in tests. */
export function TeamServicesProvider(props: {
  readonly client: TeamClient;
  readonly children: ReactNode;
}) {
  return <TeamContext.Provider value={props.client}>{props.children}</TeamContext.Provider>;
}

export function useTeamClient(): TeamClient {
  const value = useContext(TeamContext);
  if (!value) throw new Error('useTeamClient must be used inside TeamServicesProvider');
  return value;
}
