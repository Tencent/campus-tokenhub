'use client';

/**
 * 登录页实时预览。
 *
 * 「首页配置」这一组改的是「首页长什么样」，只看输入框看不出效果，因此按登录页的
 * 真实结构做一个等比缩小的预览：品牌头 + 登录卡 + 页脚。
 *
 * 侧栏只有 360px 宽，硬塞桌面端的左右两栏会把中文挤成一个个字，
 * 所以这里按窄屏（手机）排版纵向堆叠，并在标题旁注明桌面端是两栏。
 *
 * 预览只吃草稿值（未保存也会变），文案为空时回落与线上一致的默认值。
 */

import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_LOGIN_TITLE,
  DEFAULT_SCHOOL_NAME,
  HEX_COLOR,
} from '@/lib/config/branding-defaults';

export type LoginPreviewProps = {
  schoolName: string;
  loginTitle: string;
  loginSubtitle: string;
  footerContact: string;
  brandColor: string;
  logoUrl: string;
};

function text(value: string): string {
  return value.trim();
}

export function LoginPreview({
  schoolName,
  loginTitle,
  loginSubtitle,
  footerContact,
  brandColor,
  logoUrl,
}: LoginPreviewProps) {
  const name = text(schoolName) || DEFAULT_SCHOOL_NAME;
  const title = text(loginTitle) || DEFAULT_LOGIN_TITLE;
  const subtitle = text(loginSubtitle);
  const footer = text(footerContact);
  const color = HEX_COLOR.test(text(brandColor)) ? text(brandColor) : DEFAULT_BRAND_COLOR;

  return (
    <section
      aria-label="登录页预览"
      className="overflow-hidden rounded-card border border-line bg-white shadow-card"
    >
      <header className="border-b border-line px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold text-ink-900">登录页预览</h2>
          <span className="text-[11px] text-ink-400">未保存也会实时变化</span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-400">
          按窄屏排版；桌面端为左侧品牌、右侧登录卡
        </p>
      </header>

      <div className="bg-cream px-4 py-5">
        <div className="mx-auto w-full max-w-[320px] space-y-5">
          {/* 品牌头：对应登录页顶部的 Logo + 字标 + 门户标签 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg object-contain"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
                  style={{ backgroundColor: color }}
                >
                  <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                    <path
                      d="M9 2.4l6.2 3.4v6.4L9 15.6 2.8 12.2V5.8L9 2.4z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}
              <span className="text-[13px] font-semibold tracking-tight text-ink-900">
                MaaS工作台
              </span>
              <span className="rounded-full bg-brand-orange-soft px-1.5 py-0.5 text-[9px] font-medium tracking-[0.06em] text-brand-link">
                TOKENHUB
              </span>
            </div>
            <p
              className="text-[11px] font-medium tracking-[0.1em]"
              style={{ color }}
            >
              MaaS工作台 · {name}
            </p>
          </div>

          {/* 登录卡：对应登录页右栏 */}
          <div className="space-y-3 rounded-card border border-line bg-white p-4 shadow-sm">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium"
              style={{ borderColor: color, color }}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              学校统一身份认证 SSO
            </span>

            <p className="text-[20px] font-semibold leading-7 tracking-tight text-ink-900">
              {title}
            </p>
            <p className="text-[12px] leading-5 text-ink-700">
              {subtitle || '用校内账号直接登录，不用再注册一个新账号'}
            </p>

            <button
              type="button"
              disabled
              className="mt-1 flex h-9 w-full items-center justify-center rounded-control text-[12px] font-semibold text-white"
              style={{ backgroundColor: color }}
            >
              使用学校账号登录
            </button>
            <p className="text-center text-[10px] leading-4 text-ink-500">
              将跳转至学校统一身份认证页面
            </p>

            <hr className="h-px border-0 bg-cream-200" />
            <p className="text-[10px] leading-4 text-ink-700">
              首次登录自动开通个人密钥空间，可在「密钥」中查看
            </p>
          </div>

          {/* 页脚：对应登录卡下方的联系窗口 */}
          <p className="text-[11px] leading-4 text-ink-700">
            {footer || '账号无法登录？联系学校信息化办公室协助开通'}
          </p>
        </div>
      </div>
    </section>
  );
}
