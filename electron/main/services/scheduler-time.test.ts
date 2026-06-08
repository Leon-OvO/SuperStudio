import { describe, it, expect } from 'vitest'
import { computeNextFireAt, validateScheduleValue } from './scheduler-time'

describe('computeNextFireAt — interval', () => {
  it('fires N minutes after `from`', () => {
    const from = new Date(2026, 5, 8, 10, 0, 0, 0)
    const next = computeNextFireAt('interval', { everyMinutes: 15 }, from)
    expect(next).toBe(from.getTime() + 15 * 60_000)
  })
  it('supports hour-scale intervals', () => {
    const from = new Date(2026, 5, 8, 10, 0, 0, 0)
    expect(computeNextFireAt('interval', { everyMinutes: 120 }, from)).toBe(from.getTime() + 120 * 60_000)
  })
  it('rejects sub-1-minute intervals', () => {
    expect(() => computeNextFireAt('interval', { everyMinutes: 0 }, new Date())).toThrow()
  })
})

describe('computeNextFireAt — once', () => {
  it('returns the fixed local-time instant', () => {
    const next = computeNextFireAt('once', { date: '2026-12-25', time: '15:30' }, new Date(2026, 0, 1))
    expect(next).toBe(new Date(2026, 11, 25, 15, 30, 0, 0).getTime())
  })
  it('returns a past instant as-is (caller rejects past on create)', () => {
    const next = computeNextFireAt('once', { date: '2020-01-01', time: '09:00' }, new Date(2026, 0, 1))
    expect(next).toBe(new Date(2020, 0, 1, 9, 0, 0, 0).getTime())
  })
  it('throws on a malformed date', () => {
    expect(() => computeNextFireAt('once', { date: '2026/12/25', time: '15:30' }, new Date())).toThrow()
  })
})

describe('validateScheduleValue — new kinds', () => {
  it('accepts a valid interval', () => {
    expect(validateScheduleValue('interval', { everyMinutes: 30 })).toBeNull()
  })
  it('rejects non-integer / out-of-range intervals', () => {
    expect(validateScheduleValue('interval', { everyMinutes: 0 })).toBeTruthy()
    expect(validateScheduleValue('interval', { everyMinutes: 1.5 })).toBeTruthy()
    expect(validateScheduleValue('interval', { everyMinutes: 8 * 24 * 60 })).toBeTruthy()
  })
  it('accepts a valid once', () => {
    expect(validateScheduleValue('once', { date: '2026-12-25', time: '15:30' })).toBeNull()
  })
  it('rejects a malformed once date, missing time', () => {
    expect(validateScheduleValue('once', { date: 'nope', time: '15:30' })).toBeTruthy()
    expect(validateScheduleValue('once', { date: '2026-12-25' })).toBeTruthy() // no time
  })
  it('out-of-range time is caught at compute time (parseHHMM), like the other kinds', () => {
    // validateScheduleValue's HH:MM regex is lenient (matches the original code);
    // the actual range guard lives in computeNextFireAt → parseHHMM.
    expect(() => computeNextFireAt('once', { date: '2026-12-25', time: '99:99' }, new Date())).toThrow()
  })
  it('still validates the original kinds', () => {
    expect(validateScheduleValue('daily', { time: '09:00' })).toBeNull()
    expect(validateScheduleValue('weekly', { days: [], time: '09:00' })).toBeTruthy()
    expect(validateScheduleValue('monthly', { day: 31, time: '09:00' })).toBeNull()
  })
})
