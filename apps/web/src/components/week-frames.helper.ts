import { z } from 'zod';
import type { Locale, MessageKey } from '../i18n/i18n.helper';

/** `[start, end)` in minutes of the day; a frame is the 0–3 shifts of one day (ADR-19). */
export type Shift = readonly [number, number];

export type Frame = readonly Shift[];

export const MAX_SHIFTS = 3;

const minute = z.number().int().min(0).max(1440);
export const frameSchema = z.array(z.tuple([minute, minute])).max(MAX_SHIFTS);

/** Seven frames, Monday first. */
export const weekSchema = z.array(frameSchema).length(7);

/** Minute of the day → `HH:MM`. */
export function minuteLabel(minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** `HH:MM` → minute of the day; `undefined` when it is not a time. */
export function timeMinute(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

export const frameLabel = (frame: Frame) =>
  frame.map(([start, end]) => `${minuteLabel(start)}–${minuteLabel(end)}`).join(', ');

export const frameMinutes = (frame: Frame) =>
  frame.reduce((total, [start, end]) => total + end - start, 0);

/** ISO weekday 1 (Monday) .. 7 (Sunday) by name; 2024-01-01 was a Monday. */
export const isoWeekdayName = (weekday: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2024, 0, weekday)));

/** What a form edits: `HH:MM` text per shift, so a half-typed time stays on screen. */
export type ShiftDraft = { readonly start: string; readonly end: string };

export type WeekDraft = readonly (readonly ShiftDraft[])[];

export const draftOf = (week: readonly Frame[]): WeekDraft =>
  week.map((frame) =>
    frame.map(([start, end]) => ({ start: minuteLabel(start), end: minuteLabel(end) })),
  );

export const emptyWeek: WeekDraft = Array.from({ length: 7 }, () => []);

/**
 * Mirrors the API check of a frame so the form can say what is wrong; the API still decides.
 * `undefined` when valid, otherwise a locale key.
 */
export function frameIssue(frame: Frame, maxMinutes: number) {
  let previous = -1;
  for (const [start, end] of frame) {
    if (start % 5 !== 0 || end % 5 !== 0) return 'schedule.form.step' as const;
    if (start >= end || start <= previous) return 'schedule.form.order' as const;
    previous = end;
  }
  return frameMinutes(frame) > maxMinutes ? ('schedule.form.tooLong' as const) : undefined;
}

/** The frames of a draft, or `undefined` while a time is missing. */
export function weekOf(draft: WeekDraft): Frame[] | undefined {
  const week: Frame[] = [];
  for (const day of draft) {
    const frame: Shift[] = [];
    for (const shift of day) {
      const start = timeMinute(shift.start);
      const end = timeMinute(shift.end);
      if (start === undefined || end === undefined) return undefined;
      frame.push([start, end]);
    }
    week.push(frame);
  }
  return week;
}

/** A client hint for a week the API would refuse (a locale key); the API still decides. */
export function weekIssue(
  week: readonly Frame[] | undefined,
  maxMinutes: number,
): MessageKey | undefined {
  if (!week) return 'schedule.form.incomplete';
  if (week.some((frame) => frameIssue(frame, maxMinutes))) return 'schedule.form.invalid';
  return week.every((frame) => frame.length === 0) ? 'schedule.form.noWorkday' : undefined;
}
