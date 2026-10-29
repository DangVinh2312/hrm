import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session.provider';

/** UTC instant → `dd/MM/yyyy` in the business timezone, for history display only. */
export function formatInstant(value: string | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(date);
}

export function useTeamRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  // Team facts change employee scopes and primary teams too.
  return async () => {
    await queryClient.invalidateQueries({ queryKey: [namespace, 'teams'] });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'employees'] });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'auth', 'me'] });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'employee', 'me'] });
  };
}
