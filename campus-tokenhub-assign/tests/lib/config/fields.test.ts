import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_FIELD_NAMES,
  ConfigValueError,
  FIELDS,
  READONLY_ENV_KEYS,
  fromEnv,
  isConfigField,
  toConfigValue,
  type ConfigField,
} from '@/lib/config/fields';

const CONFIG_TS_SOURCE = readFileSync(join(process.cwd(), 'src/lib/config.ts'), 'utf8');

describe('config fields', () => {
  it('声明了 env 的字段，其变量名必须真实出现在 config.ts 的解析逻辑里', () => {
    for (const field of CONFIG_FIELD_NAMES) {
      const env = FIELDS[field].env;
      if (!env) continue;
      expect(CONFIG_TS_SOURCE, `${field} 的 env ${env} 未在 config.ts 中出现`).toContain(
        `'${env}'`
      );
    }
  });

  it('number 类型拒绝负数与非数字', () => {
    expect(() => toConfigValue('defaultBudgetMax', -1)).toThrow(ConfigValueError);
    expect(() => toConfigValue('defaultBudgetMax', 'abc')).toThrow(ConfigValueError);
    expect(toConfigValue('defaultBudgetMax', '200')).toBe(200);
  });

  it('enum 类型拒绝未列出的值并列出合法值', () => {
    let message = '';
    try {
      toConfigValue('defaultBudgetPeriod', 'yearly');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('daily');
    expect(message).toContain('monthly');
    expect(toConfigValue('defaultBudgetPeriod', 'monthly')).toBe('monthly');
  });

  it('conditions 只接受合法的「字段 + 取值」，并按字段路径取值去重', () => {
    expect(toConfigValue('restrictConditions', '')).toEqual([]);
    expect(
      toConfigValue('restrictConditions', [
        { field: 'schoolCode', path: '', value: ' 100051 ' },
        { field: 'schoolCode', value: '100051' },
        { field: 'roles', value: '老师' },
      ])
    ).toEqual([
      { field: 'schoolCode', path: '', value: '100051' },
      { field: 'roles', path: '', value: '老师' },
    ]);
    expect(
      toConfigValue('restrictConditions', '[{"field":"roles","value":"老师"}]')
    ).toEqual([{ field: 'roles', path: '', value: '老师' }]);
    expect(() => toConfigValue('restrictConditions', [{ field: 'unknown', value: 'x' }])).toThrow(
      /不支持的字段/
    );
    // 半填的行（取值空 / 自定义缺路径）按草稿跳过：关闭登录限制时页面可能留着这类行，
    // 不能因为它们在而拦住整份保存；启用状态下的「条件不足」由 validateAuthSectionErrors 统一报错。
    expect(
      toConfigValue('restrictConditions', [{ field: 'custom', path: '  ', value: 'x' }])
    ).toEqual([]);
    expect(toConfigValue('restrictConditions', [{ field: 'roles', value: '  ' }])).toEqual([]);
  });

  it('只读的 L1 环境变量不是配置字段', () => {
    for (const item of READONLY_ENV_KEYS) {
      expect(isConfigField(item.env)).toBe(false);
    }
    expect(isConfigField('schoolName')).toBe(true);
    expect(isConfigField('portal.unknown')).toBe(false);
  });

  it('未注册的字段被拒绝', () => {
    expect(() => toConfigValue('portal.unknown' as ConfigField, 'x')).toThrow(ConfigValueError);
  });

  it('fromEnv 只对保留 env 的字段生效（引导账号）', () => {
    expect(fromEnv('localAdminUsername', {})).toBeUndefined();
    expect(fromEnv('localAdminUsername', { PORTAL_ADMIN_USERNAME: 'ops' })).toBe('ops');
    // 运行期配置字段已改为只存数据库，不再有 env 兜底
    expect(fromEnv('defaultBudgetMax', { DEFAULT_BUDGET_MAX: '150' })).toBeUndefined();
  });
});
