import { describe, expect, it } from 'vitest';
import { businessToday } from '../src/i18n/format.helper';

describe('businessToday', () => {
  it('is the Asia/Ho_Chi_Minh day, not the UTC day', () => {
    // 18:00 UTC is already 01:00 the next day in UTC+7.
    expect(businessToday(new Date('2026-10-23T18:00:00Z'))).toBe('2026-10-24');
    // 16:59 UTC is still 23:59 the same day.
    expect(businessToday(new Date('2026-10-23T16:59:00Z'))).toBe('2026-10-23');
  });
});
