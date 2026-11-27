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
  const { RETIRED_ENV_KEYS } = await import('@/lib/config/fields');
  const {
    credentialFingerprint,
    localAdminFingerprint,
    passwordLoginRiskNotice,
    seedLocalAdminCredentialFromEnv,
  } = await import('@/lib/auth/local-admin');

  // 运行期配置已改为只存数据库：老部署的 .env 里残留这些变量时明确提示，
  // 避免「改了 .env 却没生效」被误判成故障。
  const retired = RETIRED_ENV_KEYS.filter((key) => (process.env[key] ?? '').trim() !== '');
  if (retired.length > 0) {
    console.warn(
      `[portal] 以下环境变量已不再生效（配置只在「设置」页面维护）：${retired.join('、')}。` +
        '请到设置页填写对应项；确认无误后可从 .env 删除。'
    );
  }

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
      const scene = overlayReady ? '运行期配置' : 'DB 不可达/超时，本次使用内置默认值';
      console.warn(`[portal] 登录配置校验未通过（${scene}）：${errors.join('；')}`);
    }

    console.log(
      `[portal] 配置校验通过：网关 ${cfg.octafuse.adminBase}，认证方式 ${cfg.auth.provider}`
    );

    // 客户端 IP 来源：漏配 TRUST_PROXY_HEADERS 时所有请求共用一个限流桶，必须在日志里可见
    const { trustProxyHeaders } = await import('@/lib/net/client-ip');
    console.log(
      `[portal] 客户端 IP 来源：${
        trustProxyHeaders()
          ? '反向代理头（TRUST_PROXY_HEADERS=true）'
          : '连接地址（未信任代理头，所有请求共用一个限流桶）'
      }`
    );

    if (!cfg.portal.publicBaseUrl) {
      console.warn(
        '[portal] 未配置 PUBLIC_BASE_URL：302 与同源校验会回退到请求 Host 头（可被伪造），线上必须配置'
      );
    }

    // 指南 / 调试台 / 模型详情展示的接口地址都来自 NEXT_PUBLIC_PROXY_BASE。
    // 留空不会报错，只会把 `/v1/chat/completions` 这种相对地址摆给用户，复制出去调不通。
    const proxyBaseRaw = (process.env.NEXT_PUBLIC_PROXY_BASE ?? '').trim();
    if (!proxyBaseRaw) {
      console.warn(
        '[portal] 未配置 NEXT_PUBLIC_PROXY_BASE：指南与调试台会展示相对接口地址（/v1/...），' +
          '复制出去无法调用；请填浏览器可达的网关地址（如 https://<域名>/tokenhub）'
      );
    } else if (!/^https?:\/\//i.test(proxyBaseRaw)) {
      console.warn(
        `[portal] NEXT_PUBLIC_PROXY_BASE 不是 http(s) 地址（${proxyBaseRaw}），请补全协议头`
      );
    }

    // 管理台入口只在配了公网地址时显示；缺省时侧边栏没有这一项，容易被当成 bug。
    if (!(process.env.ADMIN_PUBLIC_BASE_URL ?? '').trim()) {
      console.warn(
        '[portal] 未配置 ADMIN_PUBLIC_BASE_URL：侧边栏「网关管理后台」入口不会显示，' +
          '需填管理台的浏览器可达地址（如 https://<域名>/tokenhub/admin）'
      );
    }
    if (!cfg.auth.cookieSecure) {
      console.warn('[portal] COOKIE_SECURE=false：仅适用于 HTTP 直连部署，上 TLS 后必须改为 true');
    }

    // ---- 引导期账号密码登录的真实状态 ----
    //
    // 关键：`PORTAL_ADMIN_LOGIN` 只是初值，数据库 `login_config.local_admin_mode`
    // 会覆盖它（配置只存数据库）。所以必须在 overlay 之后、拿最终 cfg 才能下结论。
    // 这段存在的唯一目的：不让「我设了 on 怎么还是登不进去」变成悬案。
    const localAdmin = cfg.portal.localAdmin;
    const envMode = (process.env.PORTAL_ADMIN_LOGIN ?? 'auto').trim().toLowerCase();
    const hasLocalCreds = Boolean(localAdmin.username && localAdmin.password);
    // 口令已进共享库（设置页填过）时两站读的是同一行，不可能不一致，
    // 跨站比对只在「凭据来自各自 env」时才做，避免正常改口令被误报成故障
    const dbManagedCreds = Boolean(readOverlayStatus().stored?.login.localAdminPassword);

    if (localAdmin.mode === 'on') {
      console.warn(
        '[portal] 账号密码登录已开启（即使学校 SSO 已配齐也放行），仅应在救急时临时使用'
      );
    } else if (envMode === 'on') {
      // 走到这里说明最终 mode 一定是 auto/off（上一个分支已排除 on）
      console.warn(
        `[portal] PORTAL_ADMIN_LOGIN=on 未生效：数据库里是 "${localAdmin.mode}"，以数据库为准。` +
          '要开启救急登录请到「设置 → 登录认证」修改；改环境变量不会生效（配置只存数据库）。'
      );
    }
    if (localAdmin.mode !== 'off' && !hasLocalCreds) {
      console.warn(
        '[portal] 引导期账号密码登录缺少凭据（用户名或口令为空），当前不可用；' +
          '请在 PORTAL_ADMIN_USERNAME / PORTAL_ADMIN_PASSWORD 或设置页补齐'
      );
    }
    // 密码登录长期可用会绕过学校 MFA 与离校回收：启动时就把风险喊出来
    const passwordRisk = passwordLoginRiskNotice(cfg);
    if (passwordRisk) console.warn(`[portal] ${passwordRisk}`);

    // ---- 部署管理员凭据的来源（共享配置 > .env） ----
    //
    // 库里有值时以库为准；此时再改 .env 不会生效，靠一条告警把这件事说清楚，
    // 免得「我改了 .env 怎么登不上」变成悬案。
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

    // 这里**刻意不校验** `NEXT_PUBLIC_PROXY_BASE` 与 `OCTAFUSE_PROXY_BASE` 是否一致。
    //
    // 两者语义本就不同，双站默认部署下必然不同：
    //   NEXT_PUBLIC_PROXY_BASE = http://localhost:8790      ← 浏览器从宿主机直连
    //   OCTAFUSE_PROXY_BASE    = http://gateway-proxy:8787  ← 服务端走容器网络
    // 曾经加过一条「不一致就告警」，实测在正常部署里每次启动都误报，属于噪音，
    // 已移除。真要排「调试台连不上」，请看 CSP 的 connect-src 是否包含前者。
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
          `[portal] 以下配置无法解密/解析，已回落默认值，请到设置页重新填写：${status.brokenFields.join('、')}`
        );
      }
    } else {
      console.warn('[portal] 运行期配置未加载：本次使用内置默认值，请到设置页完成配置');
    }
  } catch (error) {
    console.warn(
      `[portal] 运行期配置状态读取异常，继续使用内置默认值：${error instanceof Error ? error.message : String(error)}`
    );
  }
}
