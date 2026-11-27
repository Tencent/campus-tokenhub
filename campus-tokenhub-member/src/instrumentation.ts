import { ownSchema } from '@/lib/config/tables';
/**
 * 启动即校验配置：缺关键变量直接退出，而不是等第一个请求才报错。
 *
 * Next 会在服务端启动时执行 `register()`；edge 运行时不做这件事（那里没有 process.env 全量）。
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { getConfig } = await import('@/lib/config');
  const { ensureConfigOverlayLoaded, readOverlayStatus } = await import('@/lib/config/overlay');
  const { decideStartupAuth, validateAuthSection } = await import('@/lib/config/auth-validate');
  const { credentialFingerprint, localAdminFingerprint, seedLocalAdminCredentialFromEnv } =
    await import('@/lib/auth/local-admin');

  // 启动层：先等 overlay 再校验最终值。DB 不可达/超时返回 false，不阻塞启动
  //（fail-closed 红线由认证决策守卫承载，启动层只尽早发现，避免 DB 抖动误杀启动）。
  let overlayLoaded = false;
  try {
    overlayLoaded = await ensureConfigOverlayLoaded();
  } catch {
    overlayLoaded = false;
  }

  // ---- 部署管理员凭据：共享配置是唯一权威 ----
  //
  // 库内还没有口令时，把本侧 .env 这套凭据加密写进 portal_shared.login_config
  // （条件 UPDATE，先启动的一侧写成功）；写成功后刷新 overlay，本进程也改用库里的值。
  // 之后两站同库读的是同一行，给某一站单独配一套 PORTAL_ADMIN_* 不会再造成
  // 「一个站能登、另一个站登不上」，改 .env 也不再影响已生效的口令。
  // 失败（库不可达等）只降级告警：本次启动仍按 .env 生效。
  const seedState = await seedLocalAdminCredentialFromEnv().catch(() => 'failed' as const);

  try {
    const cfg = getConfig();
    const nodeEnv = process.env.NODE_ENV ?? '';
    // getConfig 之后再读一次状态：避免 ensure 超时返回 false、但后台刷新已在 getConfig 前完成的竞态
    const overlayReady = overlayLoaded || readOverlayStatus().loaded;
    const errors = validateAuthSection(cfg.auth, nodeEnv);

    if (errors.length > 0) {
      const decision = decideStartupAuth({
        overlayLoaded: overlayReady,
        provider: cfg.auth.provider,
        nodeEnv,
      });
      // 仅「overlay 已加载（true）且最终协议非法」拒绝启动；
      // DB 不可达/超时（false）只 warn（R8 可用性权衡）。
      if (decision === 'fail') {
        throw new Error(errors.join('；'));
      }
      const scene = overlayReady ? '运行期配置' : 'DB 不可达/超时，本次仅用环境变量';
      console.warn(`[portal] 登录配置校验未通过（${scene}）：${errors.join('；')}`);
    }

    console.log(
      `[portal] 配置校验通过：数据库 ${ownSchema()}，认证方式 ${cfg.auth.provider}`
    );

    if (!cfg.portal.publicBaseUrl) {
      console.warn(
        '[portal] 未配置 PUBLIC_BASE_URL：302 与同源校验会回退到请求 Host 头（可被伪造），线上必须配置'
      );
    }
    if (!cfg.auth.cookieSecure) {
      console.warn('[portal] COOKIE_SECURE=false：仅适用于 HTTP 直连部署，上 TLS 后必须改为 true');
    }

    // ---- 部署管理员凭据的来源（共享配置 > .env） ----
    //
    // 库里有值时以库为准；此时再改 .env 不会生效，靠一条告警把这件事说清楚，
    // 免得「我改了 .env 怎么登不上」变成悬案。
    const { username, password } = cfg.portal.localAdmin;
    const dbManagedCreds = Boolean(readOverlayStatus().stored?.login.localAdminPassword);
    if (seedState === 'seeded') {
      console.log(
        '[portal] 部署管理员凭据已写入共享配置（本侧 .env 首次种子）：两站此后都以共享配置为准，改 .env 不再生效'
      );
    }
    if (dbManagedCreds) {
      const envFingerprint = credentialFingerprint(
        process.env.PORTAL_ADMIN_USERNAME ?? '',
        process.env.PORTAL_ADMIN_PASSWORD ?? ''
      );
      const effectiveFingerprint = localAdminFingerprint(cfg);
      if (envFingerprint && effectiveFingerprint && envFingerprint !== effectiveFingerprint) {
        console.warn(
          '[portal] .env 里的部署管理员凭据与共享配置不一致，已按共享配置生效；' +
            '请从 .env 删掉 PORTAL_ADMIN_USERNAME / PORTAL_ADMIN_PASSWORD（改这里不再生效）'
        );
      }
    }
    if (!username || !password) {
      console.warn(
        '[portal] 部署管理员账号密码登录缺少凭据（用户名或口令为空），当前不可用；' +
          '请在 PORTAL_ADMIN_USERNAME / PORTAL_ADMIN_PASSWORD 或设置页补齐'
      );
    }
  } catch (error) {
    console.error(`[portal] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    console.error('[portal] 请检查环境变量，参考 .env.example');
    process.exit(1);
  }

  // 运行期配置加载情况：ensureConfigOverlayLoaded 已在上面触发，这里只读状态。
  try {
    const status = readOverlayStatus();
    if (status.loaded && status.stored) {
      const { CONFIG_FIELD_NAMES, FIELDS } = await import('@/lib/config/fields');
      const configured = CONFIG_FIELD_NAMES.filter((field) => {
        const section = FIELDS[field].section;
        const values = section === 'app' ? status.stored!.app : status.stored!.login;
        return (values as Record<string, unknown>)[field] !== null;
      });
      console.log(`[portal] 运行期配置已加载：${configured.length} 项`);
      if (status.brokenFields.length > 0) {
        console.warn(
          `[portal] 以下配置无法解密/解析，已回落环境变量：${status.brokenFields.join('、')}`
        );
      }
    } else {
      console.warn('[portal] 运行期配置未加载：本次仅使用环境变量');
    }
  } catch (error) {
    console.warn(
      `[portal] 运行期配置状态读取异常，继续使用环境变量：${error instanceof Error ? error.message : String(error)}`
    );
  }
}
