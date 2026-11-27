'use client';

/**
 * 设置页的表单控件。
 *
 * 统一在这里出样式，避免每个 tab 各写一套；校验错误统一走 `error` 属性，
 * 由调用方决定是字段级（即时）还是提交后返回的。
 */

import { createContext, useContext, useId, type ReactNode } from 'react';

/**
 * 字段级 id 传递：`FieldRow` 生成 id，下面的 Input 自动取用。
 * 这样 `<label htmlFor>` 与控件、错误提示与 `aria-describedby` 才能对上，
 * 屏幕阅读器才读得出「这是哪个字段」「哪一项错了」。
 */
const FieldContext = createContext<{ id: string; errorId?: string } | null>(null);

function useFieldIds(explicitId?: string): { id?: string; describedBy?: string } {
  const ctx = useContext(FieldContext);
  return { id: explicitId ?? ctx?.id, describedBy: ctx?.errorId };
}

export function FieldRow({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const reactId = useId();
  const id = `field-${reactId}`;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">
        {label}
      </label>
      <FieldContext.Provider value={{ id, errorId }}>{children}</FieldContext.Provider>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}

const INPUT_CLASS =
  'w-full rounded-control border border-line bg-white px-3 py-2 text-sm text-ink-900 outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:bg-cream disabled:text-ink-500';

/**
 * 数字输入的外壳：边框画在外层，输入框本身无边框，单位作为独立子项占位。
 * 这样右侧单位不会和输入内容、原生微调按钮叠在一起。
 */
const NUMBER_WRAPPER_CLASS =
  'flex w-full items-center gap-2 rounded-control border px-3 py-2 transition focus-within:border-brand-orange focus-within:ring-2 focus-within:ring-brand-orange/20';

/** 供自定义组合控件复用（例如条件编辑器里的行内 select / input） */
export const FIELD_INPUT_CLASS = INPUT_CLASS;

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  error,
  maxLength,
  id,
  onBlur,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  maxLength?: number;
  id?: string;
  onBlur?: () => void;
}) {
  const field = useFieldIds(id);
  return (
    <input
      id={field.id}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      aria-invalid={error ? true : undefined}
      aria-describedby={field.describedBy}
      className={`${INPUT_CLASS} ${error ? 'border-danger' : ''}`}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  step,
  disabled,
  error,
  suffix,
}: {
  value: string;
  onChange: (next: string) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
  error?: boolean;
  /** 单位：贴在输入框右侧，避免用户猜「100 是元还是算力值」 */
  suffix?: string;
}) {
  const field = useFieldIds();
  return (
    <div
      className={`${NUMBER_WRAPPER_CLASS} ${error ? 'border-danger' : 'border-line'} ${disabled ? 'bg-cream' : 'bg-white'}`}
    >
      <input
        id={field.id}
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        min={min}
        step={step}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={field.describedBy}
        // 原生微调按钮会压在右侧单位文字上，这里统一隐藏（仍可用键盘上下键调整）
        className="min-w-0 flex-1 appearance-none bg-transparent text-sm text-ink-900 outline-none disabled:text-ink-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix ? (
        <span aria-hidden className="shrink-0 whitespace-nowrap text-xs text-ink-400">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

export function SelectInput({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const field = useFieldIds();
  return (
    <select
      id={field.id}
      aria-describedby={field.describedBy}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={INPUT_CLASS}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const field = useFieldIds();
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-900">
      <input
        id={field.id}
        aria-describedby={field.describedBy}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="h-4 w-4 rounded border-line text-brand-orange focus:ring-brand-orange"
      />
      <span>{label}</span>
    </label>
  );
}

/** 密钥输入：已配置时只显示尾号，留空表示不修改 */
export function SecretInput({
  value,
  onChange,
  configured,
  hint,
  disabled,
  onClear,
}: {
  value: string;
  onChange: (next: string) => void;
  configured: boolean;
  hint: string;
  disabled?: boolean;
  onClear?: () => void;
}) {
  const field = useFieldIds();
  return (
    <div className="space-y-1.5">
      <input
        id={field.id}
        aria-describedby={field.describedBy}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={configured ? `已配置 ${hint}，留空表示不修改` : '未配置'}
        className={INPUT_CLASS}
      />
      {configured && onClear && !disabled ? (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-danger underline-offset-2 hover:underline"
        >
          清除已保存的密钥
        </button>
      ) : null}
    </div>
  );
}

export function ColorInput({
  value,
  onChange,
  disabled,
  error,
  onBlur,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  error?: boolean;
  onBlur?: () => void;
}) {
  const field = useFieldIds();
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#2557d6'}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="选择主题色"
        className="h-9 w-12 shrink-0 cursor-pointer rounded-control border border-line bg-white"
      />
      <input
        id={field.id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-describedby={field.describedBy}
        disabled={disabled}
        placeholder="#2557D6"
        maxLength={7}
        className={`${INPUT_CLASS} min-w-0 flex-1 ${error ? 'border-danger' : ''}`}
      />
    </div>
  );
}

/** 逗号分隔的多值输入（模型 ID 清单用；后续可替换为可搜索选择器） */
export function ListInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const field = useFieldIds();
  return (
    <textarea
      id={field.id}
      aria-describedby={field.describedBy}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={3}
      className={`${INPUT_CLASS} font-mono text-xs`}
    />
  );
}

/** Logo 上传：直接 POST 二进制，成功后再让服务端重新渲染 */
export function ImageUpload({
  logoUrl,
  disabled,
  onUpload,
}: {
  logoUrl: string;
  disabled?: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-line bg-cream">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="当前 Logo" className="h-full w-full object-contain" />
        ) : (
          <span className="text-[11px] text-ink-400">无</span>
        )}
      </span>
      <label
        className={`cursor-pointer rounded-full border border-line px-3.5 py-1.5 text-xs text-ink-700 transition hover:border-ink-300 ${
          disabled ? 'pointer-events-none opacity-50' : ''
        }`}
      >
        上传新 Logo
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = '';
          }}
        />
      </label>
      <span className="text-xs text-ink-400">PNG / JPEG / SVG，≤200KB</span>
    </div>
  );
}
