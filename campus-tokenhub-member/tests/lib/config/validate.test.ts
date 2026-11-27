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

  it('财务权限必须包含 1、2 且不超过 10', () => {
    expect(validateField('tencentPermissionIds', [1, 3])?.message).toContain('2');
    expect(validateField('tencentPermissionIds', [1, 2, 11])).not.toBeNull();
    expect(validateField('tencentPermissionIds', ['2', '1', '1'])).toBeNull();
  });

  it('管理员身份格式', () => {
    expect(validateField('tencentSecretId', 123)?.message).toContain('文本');
  });

});

describe('validateSettings（跨字段）', () => {
  it('腾讯云凭据必须成对', () => {
    const errors = validateSettings({ 'tencentSecretId': 'AKIDx' });
    expect(errors.some((item) => item.key === 'tencentSecretKey')).toBe(true);
    expect(validateSettings({ 'tencentSecretId': 'AKIDx', 'tencentSecretKey': 'k' })).toEqual([]);
  });

});
