import { describe, expect, it } from 'vitest';
import { validateField, validateSettings } from '@/lib/config/validate';

describe('validateField', () => {
  it('主题色格式', () => {
    expect(validateField('brandColor', 'red')?.message).toContain('#rgb');
    expect(validateField('brandColor', '#12345')?.message).toContain('#rgb');
    expect(validateField('brandColor', '#1f6feb')).toBeNull();
    expect(validateField('brandColor', '#fff')).toBeNull();
  });

  it('额度必须是正数', () => {
    expect(validateField('defaultBudgetMax', -1)).not.toBeNull();
    expect(validateField('defaultBudgetMax', 0)).not.toBeNull();
    expect(validateField('defaultBudgetMax', 'abc')).not.toBeNull();
    expect(validateField('defaultBudgetMax', 200)).toBeNull();
  });

  it('额度周期只接受枚举值', () => {
    const error = validateField('defaultBudgetPeriod', 'yearly');
    expect(error?.message).toContain('daily');
    expect(validateField('defaultBudgetPeriod', 'monthly')).toBeNull();
  });
});

describe('validateSettings', () => {
  it('逐字段收集错误，不因一个字段非法而中断', () => {
    const errors = validateSettings({
      brandColor: 'red',
      defaultBudgetMax: -1,
      schoolName: '某某大学',
    });

    expect(errors.map((item) => item.key).sort()).toEqual(['brandColor', 'defaultBudgetMax']);
  });

  it('全部合法时返回空数组', () => {
    const errors = validateSettings({ brandColor: '#1f6feb', defaultBudgetMax: 100 });

    expect(errors).toEqual([]);
  });

  it('当前值参与合并后不影响单字段校验结果', () => {
    const errors = validateSettings({ defaultBudgetPeriod: 'daily' }, { schoolName: '某某大学' });

    expect(errors).toEqual([]);
  });
});
