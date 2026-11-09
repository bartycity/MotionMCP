import { describe, it, expect } from 'vitest';
import {
  parseWorkspaceArgs,
  parseTaskArgs,
  parseAutoScheduledParam,
  parseObjectParam,
  parseArrayParam,
  validateRequiredParams,
  validateParameterTypes,
  normalizeDueDateForApi
} from '../src/utils/parameterUtils';

describe('parameterUtils', () => {
  it('parseWorkspaceArgs trims workspaceName', () => {
    const res = parseWorkspaceArgs({ workspaceName: '  Dev  ' });
    expect(res.workspaceName).toBe('Dev');
    expect(res.workspaceId).toBeUndefined();
  });

  it('parseTaskArgs maps fields and trims strings', () => {
    const res = parseTaskArgs({ name: '  Task  ', description: '  desc  ', projectId: 'p1', priority: 'HIGH' });
    expect(res.name).toBe('Task');
    expect(res.description).toBe('desc');
    expect(res.projectId).toBe('p1');
    expect(res.priority).toBe('HIGH');
  });

  it('validateRequiredParams throws for missing', () => {
    expect(() => validateRequiredParams({ a: 1 }, ['a', 'b'])).toThrow(/Missing required parameters/);
  });

  it('validateParameterTypes throws for wrong types', () => {
    expect(() => validateParameterTypes({ lim: '10' }, { lim: 'number' })).toThrow(/Type validation failed/);
  });

  it('normalizeDueDateForApi converts date-only strings to end-of-day UTC', () => {
    expect(normalizeDueDateForApi('2024-05-10')).toBe('2024-05-10T23:59:59.000Z');
  });

  it('normalizeDueDateForApi keeps timestamps with timezone offsets intact', () => {
    expect(normalizeDueDateForApi('2024-05-10T12:30:00-04:00')).toBe('2024-05-10T12:30:00-04:00');
  });

  it('normalizeDueDateForApi expands relative dates', () => {
    const result = normalizeDueDateForApi('today');
    expect(result).toMatch(/T23:59:59\.000Z$/);
  });

  describe('parseAutoScheduledParam JSON-stringified objects', () => {
    it('parses JSON-stringified object with schedule', () => {
      const result = parseAutoScheduledParam('{"schedule":"Work Hours"}');
      expect(result).toEqual({ schedule: 'Work Hours' });
    });

    it('parses JSON-stringified object with schedule and startDate', () => {
      const result = parseAutoScheduledParam('{"schedule":"Work Hours","startDate":"2025-03-05"}');
      expect(result).toEqual({ schedule: 'Work Hours', startDate: '2025-03-05' });
    });

    it('parses JSON-stringified object with schedule and deadlineType', () => {
      const result = parseAutoScheduledParam('{"schedule":"Work Hours","deadlineType":"SOFT"}');
      expect(result).toEqual({ schedule: 'Work Hours', deadlineType: 'SOFT' });
    });

    it('treats invalid JSON starting with { as schedule name', () => {
      const result = parseAutoScheduledParam('{not valid json}');
      expect(result).toEqual({ schedule: '{not valid json}' });
    });

    it('treats JSON array string as schedule name', () => {
      const result = parseAutoScheduledParam('["Work Hours"]');
      expect(result).toEqual({ schedule: '["Work Hours"]' });
    });
  });

  describe('parseObjectParam', () => {
    it('returns native object as-is', () => {
      const obj = { type: 'weekly' };
      expect(parseObjectParam(obj)).toBe(obj);
    });

    it('parses JSON-stringified object', () => {
      expect(parseObjectParam('{"type":"daily"}')).toEqual({ type: 'daily' });
    });

    it('parses JSON-stringified object with leading whitespace', () => {
      expect(parseObjectParam('  {"type":"monthly"}  ')).toEqual({ type: 'monthly' });
    });

    it('returns undefined for invalid JSON starting with {', () => {
      expect(parseObjectParam('{not json}')).toBeUndefined();
    });

    it('returns undefined for array', () => {
      expect(parseObjectParam([1, 2, 3])).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(parseObjectParam(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(parseObjectParam(undefined)).toBeUndefined();
    });

    it('returns undefined for number', () => {
      expect(parseObjectParam(42)).toBeUndefined();
    });

    it('returns undefined for plain string not starting with {', () => {
      expect(parseObjectParam('hello')).toBeUndefined();
    });
  });

  describe('parseArrayParam', () => {
    it('returns native array as-is', () => {
      const arr = ['Todo', 'Done'];
      expect(parseArrayParam(arr)).toBe(arr);
    });

    it('parses JSON-stringified array', () => {
      expect(parseArrayParam('["Todo","Done"]')).toEqual(['Todo', 'Done']);
    });

    it('parses JSON-stringified array with leading whitespace', () => {
      expect(parseArrayParam('  ["a","b"]  ')).toEqual(['a', 'b']);
    });

    it('returns undefined for invalid JSON starting with [', () => {
      expect(parseArrayParam('[not json')).toBeUndefined();
    });

    it('returns undefined for object', () => {
      expect(parseArrayParam({ a: 1 })).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(parseArrayParam(null)).toBeUndefined();
    });

    it('returns undefined for plain string', () => {
      expect(parseArrayParam('hello')).toBeUndefined();
    });

    it('returns undefined for number', () => {
      expect(parseArrayParam(42)).toBeUndefined();
    });
  });
});

describe('normalizeIdealTime', () => {
  it('converts 24-hour values to the 12-hour form Motion accepts', async () => {
    const { normalizeIdealTime } = await import('../src/utils/parameterUtils');
    expect(normalizeIdealTime('09:00')).toBe('9:00 am');
    expect(normalizeIdealTime('00:30')).toBe('12:30 am');
    expect(normalizeIdealTime('12:00')).toBe('12:00 pm');
    expect(normalizeIdealTime('21:30')).toBe('9:30 pm');
  });

  it('normalizes 12-hour values without changing their meaning', async () => {
    const { normalizeIdealTime } = await import('../src/utils/parameterUtils');
    expect(normalizeIdealTime('9:00 am')).toBe('9:00 am');
    expect(normalizeIdealTime('09:30 PM')).toBe('9:30 pm');
    expect(normalizeIdealTime(' 12:00am ')).toBe('12:00 am');
  });

  it('rejects values Motion cannot accept', async () => {
    const { normalizeIdealTime } = await import('../src/utils/parameterUtils');
    for (const bad of ['09:15', '24:00', '13:00 pm', '0:00 am', 'nine', '9am', '']) {
      expect(() => normalizeIdealTime(bad), bad).toThrow(/idealTime/);
    }
  });
});
