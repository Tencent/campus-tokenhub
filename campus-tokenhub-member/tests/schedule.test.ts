import { describe, expect, it } from 'vitest';
import {
  describeFactor,
  matchScheduleWindow,
  resolveCurrentPrice,
  scheduleHint,
  shanghaiParts,
  type PricingProfile,
} from '@/lib/pricing/schedule';

/** DeepSeek 的峰谷：基准价是高峰价，空闲窗口给 0.5 */
const dsProfile: PricingProfile = {
  tiers: [{ upto: null, input_price: 2, output_price: 8, cache_read_price: 0.04 }],
  schedule: [
    { start: '00:00', end: '09:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
    { start: '12:00', end: '14:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
    { start: '18:00', end: '24:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
    { start: '00:00', end: '24:00', factor: 0.5, days: [6, 7] },
  ],
};

/** 2026-11-05 是周四（ISO 4） */
const thursdayAt = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00+08:00`);
const saturdayAt = (hhmm: string) => new Date(`2026-11-07T${hhmm}:00+08:00`);

describe('shanghaiParts', () => {
  it('按东八区解出分钟数与 ISO 星期', () => {
    const { minutes, isoWeekday } = shanghaiParts(thursdayAt('19:39'));
    expect(minutes).toBe(19 * 60 + 39);
    expect(isoWeekday).toBe(4);
  });

  it('不跟随进程时区：UTC 时间戳同样按东八区解释', () => {
    // 2026-11-05T11:39Z = 北京 19:39
    const { minutes } = shanghaiParts(new Date('2026-11-05T11:39:00Z'));
    expect(minutes).toBe(19 * 60 + 39);
  });
});

describe('matchScheduleWindow', () => {
  it('工作日 19:39 命中 18:00-24:00 空闲窗口', () => {
    const win = matchScheduleWindow(dsProfile.schedule, thursdayAt('19:39'));
    expect(win).toEqual({ start: '18:00', end: '24:00', factor: 0.5, days: [1, 2, 3, 4, 5] });
  });

  it('工作日 10:00 不命中任何空闲窗口（高峰）', () => {
    expect(matchScheduleWindow(dsProfile.schedule, thursdayAt('10:00'))).toBeNull();
  });

  it('边界是半开区间：09:00 已属高峰，08:59 仍空闲', () => {
    expect(matchScheduleWindow(dsProfile.schedule, thursdayAt('09:00'))).toBeNull();
    expect(matchScheduleWindow(dsProfile.schedule, thursdayAt('08:59'))?.factor).toBe(0.5);
  });

  it('周六全天命中空闲窗口', () => {
    expect(matchScheduleWindow(dsProfile.schedule, saturdayAt('10:00'))?.factor).toBe(0.5);
    expect(matchScheduleWindow(dsProfile.schedule, saturdayAt('23:30'))?.factor).toBe(0.5);
  });

  it('day 缺省视为每天', () => {
    const win = matchScheduleWindow([{ start: '00:00', end: '24:00', factor: 0.8 }], saturdayAt('12:00'));
    expect(win?.factor).toBe(0.8);
  });

  it('跨午夜窗口按开始日判定：周五 23:00 命中，周六 01:00 也算周五的窗口', () => {
    const schedule = [{ start: '22:00', end: '06:00', factor: 0.7, days: [5] }];
    const friday = new Date('2026-11-06T23:00:00+08:00');
    const saturdayEarly = new Date('2026-11-07T01:00:00+08:00');
    const sundayEarly = new Date('2026-11-08T01:00:00+08:00');
    expect(matchScheduleWindow(schedule, friday)?.factor).toBe(0.7);
    expect(matchScheduleWindow(schedule, saturdayEarly)?.factor).toBe(0.7);
    expect(matchScheduleWindow(schedule, sundayEarly)).toBeNull();
  });
});

describe('resolveCurrentPrice', () => {
  it('空闲时段把 factor 乘进单价', () => {
    const price = resolveCurrentPrice(dsProfile, thursdayAt('19:39'));
    expect(price.factor).toBe(0.5);
    expect(price.inputPrice).toBe(1);
    expect(price.outputPrice).toBe(4);
    expect(price.cacheReadPrice).toBe(0.02);
    expect(price.label).toBe('空闲时段');
  });

  it('高峰时段返回目录原价', () => {
    const price = resolveCurrentPrice(dsProfile, thursdayAt('10:00'));
    expect(price.factor).toBe(1);
    expect(price.inputPrice).toBe(2);
    expect(price.label).toBeNull();
  });

  it('无 schedule 的模型不显示时段标签', () => {
    const price = resolveCurrentPrice({ tiers: [{ input_price: 6, output_price: 18 }] }, thursdayAt('10:00'));
    expect(price.factor).toBe(1);
    expect(price.label).toBeNull();
    expect(price.inputPrice).toBe(6);
  });

  it('按张计价的图片模型也吃时段倍率', () => {
    const price = resolveCurrentPrice(
      { image: { default: 0.2 }, schedule: [{ start: '00:00', end: '24:00', factor: 0.5 }] },
      thursdayAt('10:00')
    );
    expect(price.imagePrice).toBe(0.1);
  });

  it('空 profile 不抛错', () => {
    const price = resolveCurrentPrice(null, thursdayAt('10:00'));
    expect(price.inputPrice).toBeNull();
    expect(price.factor).toBe(1);
  });
});

describe('文案', () => {
  it('describeFactor 给出中文标签', () => {
    expect(describeFactor(0.5)).toBe('空闲时段');
    expect(describeFactor(1)).toBe('标准时段');
    expect(describeFactor(1.5)).toBe('高峰时段');
  });

  it('scheduleHint 带倍率与高峰说明', () => {
    expect(scheduleHint(dsProfile, thursdayAt('19:39'))).toContain('×0.5');
    expect(scheduleHint(dsProfile, thursdayAt('19:39'))).toContain('9:00–12:00');
    expect(scheduleHint({ tiers: [] }, thursdayAt('19:39'))).toBeNull();
  });
});
