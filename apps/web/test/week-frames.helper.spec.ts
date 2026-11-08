import { describe, expect, it } from 'vitest';
import { frameIssue, timeMinute, weekIssue, weekOf } from '../src/components/week-frames.helper';
import { wholeMonth } from '../src/features/employee/components/employee-schedule.component';
import { leaveSlots, slotOf } from '../src/features/work-request/work-request.helper';

const standard = [
  [540, 780],
  [840, 1080],
] as const;
const off = [] as const;

describe('week frames', () => {
  it('reads HH:MM and nothing else', () => {
    expect(timeMinute('09:05')).toBe(545);
    expect(timeMinute('23:59')).toBe(1439);
    for (const value of ['', '9:00', '24:00', '09:60', '09:00:00'])
      expect(timeMinute(value)).toBe(undefined);
  });

  it('mirrors the API frame rules: 5-minute steps, ordered, not touching, within the day limit', () => {
    expect(frameIssue(standard, 480)).toBe(undefined);
    expect(frameIssue([], 480)).toBe(undefined);
    expect(frameIssue([[541, 780]], 480)).toBe('schedule.form.step');
    expect(frameIssue([[780, 540]], 480)).toBe('schedule.form.order');
    expect(frameIssue([[540, 540]], 480)).toBe('schedule.form.order');
    expect(
      frameIssue(
        [
          [540, 780],
          [780, 840],
        ],
        480,
      ),
    ).toBe('schedule.form.order');
    expect(
      frameIssue(
        [
          [840, 900],
          [540, 600],
        ],
        480,
      ),
    ).toBe('schedule.form.order');
    expect(frameIssue([[480, 965]], 480)).toBe('schedule.form.tooLong');
    expect(frameIssue([[480, 960]], 480)).toBe(undefined);
  });

  it('turns a draft into frames only when every time is typed', () => {
    const draft = [[{ start: '09:00', end: '13:00' }], [], [], [], [], [], []];
    expect(weekOf(draft)).toEqual([[[540, 780]], [], [], [], [], [], []]);
    expect(weekOf([[{ start: '09:00', end: '' }], [], [], [], [], [], []])).toBe(undefined);
  });

  it('names what blocks a week', () => {
    expect(weekIssue(undefined, 480)).toBe('schedule.form.incomplete');
    expect(weekIssue([standard, off, off, off, off, off, off], 480)).toBe(undefined);
    expect(weekIssue([[[541, 600]], off, off, off, off, off, off], 480)).toBe(
      'schedule.form.invalid',
    );
    expect(weekIssue([off, off, off, off, off, off, off], 480)).toBe('schedule.form.noWorkday');
  });

  it('fills a whole month: the typed one, or the month after today', () => {
    expect(wholeMonth('2027-02-14', '2026-11-04')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
    expect(wholeMonth('2026-02-14', '2026-11-04')).toEqual({
      from: '2026-11-05',
      to: '2026-11-30',
    });
    expect(wholeMonth('', '2026-11-04')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(wholeMonth('', '2026-12-31')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    // Never before tomorrow: a frame starts after today.
    expect(wholeMonth('2026-11-20', '2026-11-04')).toEqual({
      from: '2026-11-05',
      to: '2026-11-30',
    });
    expect(wholeMonth('2026-11-20', '2026-11-30')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('leave slots', () => {
  const values = (shifts: Parameters<typeof leaveSlots>[0]) =>
    leaveSlots(shifts).map((slot) => slot.value);

  it('gives the seven slots of the seeded week', () => {
    expect(values(standard)).toEqual([
      '540-660',
      '660-780',
      '840-960',
      '960-1080',
      '540-780',
      '840-1080',
      '540-1080',
    ]);
  });

  it('follows the day: one shift, a shift too short to split, a day off', () => {
    expect(values([[480, 720]])).toEqual(['480-600', '600-720', '480-720']);
    expect(values([[600, 630]])).toEqual(['600-630']);
    expect(values([])).toEqual([]);
  });

  it('parses only a start-end value', () => {
    expect(slotOf('540-660')).toEqual({ start: 540, end: 660 });
    for (const value of ['', 'morning', '540-', '-1-60', '540-660-700'])
      expect(slotOf(value)).toBe(undefined);
  });
});
