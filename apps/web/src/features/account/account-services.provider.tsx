import { createContext, useContext, type ReactNode } from 'react';
import type { AccountClient } from './account.client';

const AccountContext = createContext<AccountClient | undefined>(undefined);

/** Account API client, created once by the composition root (app.tsx) and faked in tests. */
export function AccountServicesProvider(props: {
  readonly client: AccountClient;
  readonly children: ReactNode;
}) {
  return <AccountContext.Provider value={props.client}>{props.children}</AccountContext.Provider>;
}

export function useAccountClient(): AccountClient {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccountClient must be used inside AccountServicesProvider');
  return value;
}
