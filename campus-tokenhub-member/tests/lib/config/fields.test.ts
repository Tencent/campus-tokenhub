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
  it('覆盖设计文档列出的全部配置字段', () => {
    const required: ConfigField[] = [
      'schoolName',
      'loginTitle',
      'loginSubtitle',
      'footerContact',
      'brandColor',
      'logo',
      'defaultBudgetMax',
      'defaultBudgetPeriod',
      'defaultRateLimitRpm',
      'defaultRateLimitTpm',
      'activityEnabled',
      'tencentSecretId',
      'tencentSecretKey',
      'tencentPermissionIds',
      'provider',
      'oauth2ClientSecret',
      'wecomCorpId',
      'wecomAgentId',
      'wecomClientSecret',
      'wecomScope',
      'restrictConditions',
    ];
    for (const field of required) expect(FIELDS[field], field).toBeTruthy();
    expect(CONFIG_FIELD_NAMES).toHaveLength(41);
  });

  it('声明了 env 的字段，其变量名必须真实出现在 config.ts 的解析逻辑里', () => {
    for (const field of CONFIG_FIELD_NAMES) {
      const env = FIELDS[field].env;
      if (!env) continue;
      expect(CONFIG_TS_SOURCE, `${field} 的 env ${env} 未在 config.ts 中出现`).toContain(
        `'${env}'`
      );
    }
  });

  it('敏感字段被正确标记，审计名沿用旧 key 保证审计连续', () => {
    expect(FIELDS.tencentSecretId.secret).toBe(true);
    expect(FIELDS.tencentSecretKey.secret).toBe(true);
    expect(FIELDS.oauth2ClientSecret.secret).toBe(true);
    expect(FIELDS.wecomClientSecret.secret).toBe(true);
    expect(FIELDS.wecomClientSecret.cryptoKey).toBe('auth.wecom.clientSecret');
    expect(FIELDS.schoolName.secret).toBeFalsy();
    expect(FIELDS.tencentSecretId.auditName).toBe('tencent.secret_id');
    expect(FIELDS.oauth2ClientSecret.cryptoKey).toBe('auth.oauth2.clientSecret');
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

  it('boolean 接受常见写法，其余抛错', () => {
    expect(toConfigValue('restrictEnabled', true)).toBe(true);
    expect(toConfigValue('restrictEnabled', 'true')).toBe(true);
    expect(toConfigValue('restrictEnabled', '1')).toBe(true);
    expect(toConfigValue('restrictEnabled', '0')).toBe(false);
    expect(() => toConfigValue('restrictEnabled', 'yes-please')).toThrow(ConfigValueError);
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

  it('number[] 财务权限缺少 1 或 2 时抛错', () => {
    expect(() => toConfigValue('tencentPermissionIds', [1, 3])).toThrow(/缺少 2/);
    expect(() => toConfigValue('tencentPermissionIds', [2, 3])).toThrow(/缺少 1/);
    expect(toConfigValue('tencentPermissionIds', ['2', '1', '1'])).toEqual([1, 2]);
    expect(() => toConfigValue('tencentPermissionIds', [11])).toThrow(ConfigValueError);
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

  it('fromEnv 在变量缺失时返回 undefined，有值时类型化', () => {
    expect(fromEnv('defaultBudgetMax', {})).toBeUndefined();
    expect(fromEnv('defaultBudgetMax', { DEFAULT_BUDGET_MAX: '150' })).toBe(150);
  });
});

describe('toConfigValue：Logo 写入校验', () => {
  function dataUrl(source: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  }

  it('含脚本/事件属性的 SVG 被拒绝（与上传接口同口径）', () => {
    expect(() => toConfigValue('logo', dataUrl('<svg/onload=alert(1)>'))).toThrow(ConfigValueError);
    expect(() =>
      toConfigValue('logo', dataUrl('<svg><a href="&#106;avascript:alert(1)"/></svg>'))
    ).toThrow(ConfigValueError);
  });

  it('正常 SVG 与普通字符串照旧保存', () => {
    const safe = dataUrl('<svg><path d="M0 0h10v10z"/></svg>');
    expect(toConfigValue('logo', safe)).toBe(safe);
    expect(toConfigValue('logo', '')).toBe('');
  });
});
