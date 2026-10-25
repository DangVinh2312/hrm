import {
  IconBeach,
  IconCalendarEvent,
  IconChecklist,
  IconClockHour4,
  IconFileText,
  IconLayoutDashboard,
  IconReportAnalytics,
  IconSettings,
  IconShieldCheck,
  IconUserShield,
  IconUsers,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import type { NavigationMenu } from '../features/auth/me.client';
import type { MessageKey } from '../i18n/i18n.helper';

export interface NavigationItem {
  readonly path: string;
  readonly label: MessageKey;
  readonly icon: Icon;
  /** `undefined`: always shown to a signed-in user. */
  readonly menu?: NavigationMenu;
}

/** Order is the sidebar order: self-service first, then approvals, then HR administration. */
export const navigationItems: readonly NavigationItem[] = [
  { path: '/', label: 'navigation.overview', icon: IconLayoutDashboard },
  { path: '/requests', label: 'navigation.requests', icon: IconFileText, menu: 'requests' },
  { path: '/approvals', label: 'navigation.approvals', icon: IconChecklist, menu: 'approvals' },
  { path: '/leave', label: 'navigation.leave', icon: IconBeach, menu: 'leave' },
  { path: '/attendance', label: 'navigation.attendance', icon: IconClockHour4, menu: 'attendance' },
  { path: '/employees', label: 'navigation.employees', icon: IconUsers, menu: 'employees' },
  { path: '/teams', label: 'navigation.teams', icon: IconUsersGroup, menu: 'teams' },
  { path: '/calendar', label: 'navigation.calendar', icon: IconCalendarEvent, menu: 'calendar' },
  { path: '/reports', label: 'navigation.reports', icon: IconReportAnalytics, menu: 'reports' },
  { path: '/accounts', label: 'navigation.accounts', icon: IconUserShield, menu: 'accounts' },
  { path: '/roles', label: 'navigation.roles', icon: IconShieldCheck, menu: 'roles' },
  { path: '/settings', label: 'navigation.settings', icon: IconSettings, menu: 'settings' },
];

export function visibleNavigation(menus: readonly NavigationMenu[]): readonly NavigationItem[] {
  return navigationItems.filter((item) => item.menu === undefined || menus.includes(item.menu));
}
