/** Keys of the work calendar fragment; values are stored strings (never rename). */
export const WorkCalendarResource = { WorkCalendar: 'workCalendar' } as const;

export type WorkCalendarResource = (typeof WorkCalendarResource)[keyof typeof WorkCalendarResource];

export const WorkCalendarAction = { Read: 'read', Manage: 'manage' } as const;

export type WorkCalendarAction = (typeof WorkCalendarAction)[keyof typeof WorkCalendarAction];

export const WorkCalendarTemplate = { Calendar: 'calendar' } as const;

export type WorkCalendarTemplate = (typeof WorkCalendarTemplate)[keyof typeof WorkCalendarTemplate];
