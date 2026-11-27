'use client';

/**
 * PC 系统浏览器里的企业微信内嵌扫码登录。
 *
 * 面板参数由 `/api/auth/wecom/qr` 下发（其中 oidc_tx 已签名写入 Cookie）；
 * 扫码成功后把 code / state 拼到**接口返回的** redirectUri 顶层跳转，
 * 绝不自行拼域名，以免绕过企微要求的访问域名与回调域名一致性预检。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { appPath } from '@/lib/paths';

type QrParams = {
  corpId: string;
  agentId: string;
  state: string;
  redirectUri: string;
};

type Status = 'loading' | 'ready' | 'expired' | 'error';

export type WecomQrLoginProps = {
  /** 透传给初始化接口的登录目标，由接口做白名单净化 */
  next?: string;
  dest?: string;
  adminNext?: string;
};

const EXPIRED_TEXT = '二维码已过期，点击重新获取';

function loginQuery(next?: string, dest?: string, adminNext?: string): string {
  const query = new URLSearchParams();
  if (next) query.set('next', next);
  if (dest) query.set('dest', dest);
  if (adminNext) query.set('adminNext', adminNext);
  return query.toString();
}

export function WecomQrLogin({ next, dest, adminNext }: WecomQrLoginProps) {
  const [params, setParams] = useState<QrParams | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  /** 每次重新获取自增：同时驱动接口重取、Cookie 重签与面板重建 */
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * 终态闸门：面板一旦进入过期 / 错误态就锁住，忽略后续任何成功回调。
   *
   * 企微面板在 onLoginFail 后不会被 SDK 自行销毁，实测仍可能再发一次带
   * code 的 onLoginSuccess；若不拦住，window.location.assign 会把用户从
   * 报错页带走（跳到回调、换 code 失败后又回到登录页）。必须用 ref 而非
   * state：回调闭包捕获的是挂载时的 state，读不到后来写入的终态。
   */
  const terminalRef = useRef(false);

  const query = useMemo(() => loginQuery(next, dest, adminNext), [next, dest, adminNext]);
  const fallbackHref = useMemo(
    () => appPath(`/api/auth/login${query ? `?${query}` : ''}`),
    [query]
  );

  // 初始化 / 重新获取：失败时展示可读提示，并保留网页授权回退入口
  useEffect(() => {
    let cancelled = false;
    const urlError = new URLSearchParams(window.location.search).get('error');
    if (attempt === 0 && (urlError === 'tx_missing' || urlError === 'state_mismatch')) {
      // 回调已经报过事务失效：不自动复用旧 state，直接让人点重新获取
      terminalRef.current = true;
      setParams(null);
      setMessage(EXPIRED_TEXT);
      setStatus('expired');
      return;
    }

    // 新的获取周期：先解锁闸门，允许这一轮面板的成功回调
    terminalRef.current = false;
    setParams(null);
    setMessage('');
    setStatus('loading');

    const load = async () => {
      try {
        const response = await fetch(
          `${appPath('/api/auth/wecom/qr')}${query ? `?${query}` : ''}`,
          { cache: 'no-store', credentials: 'same-origin' }
        );
        const body = (await response.json().catch(() => ({}))) as {
          corpId?: string;
          agentId?: string;
          state?: string;
          redirectUri?: string;
          error?: string;
        };
        if (
          !response.ok ||
          !body.corpId ||
          !body.agentId ||
          !body.state ||
          !body.redirectUri
        ) {
          throw new Error(body.error ?? 'request_failed');
        }
        if (cancelled) return;
        setParams({
          corpId: body.corpId,
          agentId: body.agentId,
          state: body.state,
          redirectUri: body.redirectUri,
        });
      } catch (error) {
        if (cancelled) return;
        terminalRef.current = true;
        const code = error instanceof Error ? error.message : '';
        setMessage(
          code === 'wecom_qr_unavailable'
            ? '扫码暂不可用，请检查 PUBLIC_BASE_URL 与浏览器访问域名是否一致。'
            : code === 'wecom_config_missing'
              ? '企业微信登录尚未配置完成，请联系管理员。'
              : '二维码加载失败，请稍后重试或检查网络连接。'
        );
        setStatus('error');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [attempt, query]);

  // 面板只在客户端挂载：SDK 内部依赖 window / document，不能进 SSR 路径
  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    let panel: { el?: HTMLIFrameElement; unmount(): void } | null = null;

    const mount = async () => {
      try {
        const ww = await import('@wecom/jssdk');
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren();

        const current = params;
        panel = ww.createWWLoginPanel({
          el: container,
          params: {
            // 枚举值即官方约定的 'CorpApp' / 'callback' / 'small' / 'zh'
            login_type: ww.WWLoginType.corpApp,
            appid: current.corpId,
            agentid: current.agentId,
            // 接口返回的回调地址直接用，不 URLEncode
            redirect_uri: current.redirectUri,
            state: current.state,
            redirect_type: ww.WWLoginRedirectType.callback,
            panel_size: ww.WWLoginPanelSizeType.small,
            lang: ww.WWLoginLangType.zh,
          },
          onLoginSuccess({ code }) {
            // 已进入过期 / 错误终态：忽略 SDK 后续回调，保持停留在报错页
            if (terminalRef.current) return;
            if (!code) {
              // 无 code 时保持面板可见（企微原生页会给出提示），仅锁住闸门
              terminalRef.current = true;
              return;
            }
            // 先锁住，防止同一轮面板重复回调导致重复跳转
            terminalRef.current = true;
            const target = new URL(current.redirectUri);
            target.searchParams.set('code', code);
            target.searchParams.set('state', current.state);
            // 顶层跳转，避免 code 留在二维码 iframe 内
            window.location.assign(target.toString());
          },
          onLoginFail(err) {
            terminalRef.current = true;
            // 保留面板：企微 SDK 会直接在 iframe 内渲染出错页（如橙色感叹号的域名不一致提示），
            // 卸载面板或叠加自有文案都会让用户看不到这个原生错误页。闸门已能阻止后续跳转。
            // 31033 / 31039 为域名类错误，仅记录到 message 备查，不在面板上覆盖显示。
            if (err?.errCode === 31033 || err?.errCode === 31039) {
              setMessage('wecom_domain_mismatch');
            } else {
              setMessage(EXPIRED_TEXT);
            }
            // status 保持 ready：iframe 常驻可见，用户停留在企微原生报错页
          },
        });
        // 按官方类型，createWWLoginPanel 返回 iframe；部分版本不自动插入
        if (panel.el && !container.contains(panel.el)) container.appendChild(panel.el);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        terminalRef.current = true;
        setMessage('扫码组件加载失败，请检查浏览器网络或安全设置。');
        setStatus('error');
      }
    };

    void mount();
    return () => {
      cancelled = true;
      panel?.unmount();
    };
  }, [params]);

  const refresh = () => {
    terminalRef.current = false;
    setParams(null);
    setMessage('');
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  return (
    <div className="mt-6">
      <p className="mb-3 text-center text-[13px] font-medium text-ink-900">
        使用企业微信扫码登录
      </p>
      <div className="flex min-h-[320px] items-center justify-center rounded-control border border-line bg-white">
        {/* 容器常驻：面板挂载 effect 运行时查询 ref 不能是 null */}
        <div
          ref={containerRef}
          aria-label="企业微信登录二维码"
          className={status === 'ready' ? 'flex w-full justify-center py-2' : 'hidden'}
        />
        {status === 'loading' ? (
          <p role="status" className="px-5 py-6 text-center text-[13px] text-ink-500">
            正在获取企业微信登录二维码…
          </p>
        ) : null}
        {status === 'expired' || status === 'error' ? (
          <div className="px-5 py-6 text-center">
            <p role="alert" className="text-[13px] leading-[22px] text-ink-700">
              {message || EXPIRED_TEXT}
            </p>
            {status === 'expired' ? (
              <button
                type="button"
                onClick={refresh}
                className="mt-4 rounded-full border border-line px-4 py-2 text-[13px] font-medium text-ink-700 transition hover:border-ink-300"
              >
                {EXPIRED_TEXT}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {status === 'error' || status === 'expired' ? (
        <p className="mt-3 text-center text-[12px] text-ink-500">
          也可以用
          <a
            href={fallbackHref}
            className="mx-1 font-medium text-brand-link underline underline-offset-2"
          >
            企业微信网页授权
          </a>
          登录
        </p>
      ) : null}
    </div>
  );
}
