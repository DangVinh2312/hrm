import { createContext, useContext, type ReactNode } from 'react';
import type { SettingClient } from './setting.client';

const SettingContext = createContext<SettingClient | undefined>(undefined);

/** Setting API client, created once by the composition root (app.tsx) and faked in tests. */
export function SettingServicesProvider(props: {
  readonly client: SettingClient;
  readonly children: ReactNode;
}) {
  return <SettingContext.Provider value={props.client}>{props.children}</SettingContext.Provider>;
}

export function useSettingClient(): SettingClient {
  const value = useContext(SettingContext);
  if (!value) throw new Error('useSettingClient must be used inside SettingServicesProvider');
  return value;
}
