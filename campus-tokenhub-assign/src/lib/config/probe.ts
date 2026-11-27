/**
 * 配置探测：需要外部系统才能确认的事实，统一走这里。
 *
 * 探测只用「草稿值 + 当前已存值」，不写库、不写日志；失败一律映射成可读中文与稳定 code。
 *
 * 与成员站（member）的差异：统一采买站没有腾讯云 CAM 凭据，因此不存在账户凭据探测，
 * 只剩「计费币种」与「管理员身份是否存在」两项。
 */

export type ProbeGroup = 'currency' | 'admin';

/** 探测入参只列真正需要的字段 */
export type ProbeDraft = {
  sub?: string;
};

export type ProbeOutcome = {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
};

const defaultCurrencyProvider = async (): Promise<string | null> => {
  const [{ readSystemConfig }, { getGatewayClient }] = await Promise.all([
    import('@/lib/onboarding/gateway-state'),
    import('@/lib/gateway/client'),
  ]);
  const config = await readSystemConfig(getGatewayClient());
  return config.get('BILLING_CURRENCY') ?? null;
};

/** 网关计费币种；读不到返回 null */
let currencyProvider: () => Promise<string | null> = defaultCurrencyProvider;

/** 管理员身份是否存在；读不到返回 null（未知） */
let adminLookup: (sub: string) => Promise<boolean | null> = async () => null;

export function setProbeDeps(deps: {
  currencyProvider?: () => Promise<string | null>;
  adminLookup?: (sub: string) => Promise<boolean | null>;
}): void {
  if (deps.currencyProvider) currencyProvider = deps.currencyProvider;
  if (deps.adminLookup) adminLookup = deps.adminLookup;
}

/** 仅测试用：恢复默认探测依赖 */
export function resetProbeDeps(): void {
  currencyProvider = defaultCurrencyProvider;
  adminLookup = async () => null;
}

function readString(draft: ProbeDraft, key: keyof ProbeDraft): string {
  const raw = draft[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 计费币种探测：只做提示，不阻止保存 */
export async function probeCurrency(): Promise<ProbeOutcome> {
  try {
    const currency = await currencyProvider();
    const effective = (currency ?? 'CNY').toUpperCase();
    const warning =
      effective === 'CNY'
        ? null
        : `网关计费币种是 ${effective}，默认额度请按该币种填写（不是人民币元）`;
    return {
      ok: true,
      message: warning ?? undefined,
      detail: { currency: effective, warning },
    };
  } catch {
    return { ok: false, code: 'probe_failed', message: '读取网关计费配置失败，请稍后重试' };
  }
}

/** 管理员身份探测：查不到只提示「未知身份」，不阻止保存 */
export async function probeAdminIdentity(draft: ProbeDraft = {}): Promise<ProbeOutcome> {
  const sub = readString(draft, 'sub');
  if (!sub) {
    return { ok: false, code: 'invalid_sub', message: '缺少要检测的身份' };
  }

  try {
    const exists = await adminLookup(sub);
    if (exists === null) {
      return {
        ok: true,
        message: '暂时无法确认该身份是否登录过门户（网关不可用）',
        detail: { status: 'unknown' },
      };
    }
    return {
      ok: true,
      message: exists ? undefined : '该身份尚未登录过门户，第一次登录后才会生效',
      detail: { status: exists ? 'found' : 'unknown' },
    };
  } catch {
    return {
      ok: true,
      message: '暂时无法确认该身份是否登录过门户',
      detail: { status: 'unknown' },
    };
  }
}
