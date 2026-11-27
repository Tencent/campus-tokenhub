'use client';

import { appPath } from '@/lib/paths';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DEPARTMENT_MAX_LEVELS,
  DEPARTMENT_SEGMENT_MAX,
  normalizeDepartmentPath,
} from '@/lib/members/department-path';
import type { MemberApplication } from '@/lib/members/types';

type Props = {
  mode: 'create' | 'edit' | 'reapply';
  applicantName: string;
  memberNamePreview: string;
  application?: MemberApplication | null;
  /** edit 模式由状态卡的「修改」入口展开，取消/保存成功后通知父组件收起表单 */
  onCancel?: () => void;
  onSaved?: () => void;
};

/** 初始快照，用来判断「是否真的改了内容」，没改就不让提交 */
type Snapshot = {
  email: string;
  countryCode: string;
  phone: string;
  departmentPath: string;
  remark: string;
};

function snapshotOf(application: MemberApplication | null | undefined): Snapshot {
  return {
    email: application?.email ?? '',
    countryCode: application?.countryCode ?? '86',
    phone: application?.phone ?? '',
    departmentPath: application?.departmentPath ?? '',
    remark: application?.remark ?? '',
  };
}

const inputClass =
  'mt-1 w-full rounded-control border border-line bg-white px-3 py-2 text-sm text-ink-900 outline-none transition hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15';

const HEADING: Record<Props['mode'], string> = {
  create: '申请腾讯云成员账号',
  edit: '修改资料',
  reapply: '重新提交申请',
};

const SUBMIT_LABEL: Record<Props['mode'], string> = {
  create: '提交申请',
  edit: '保存并重新提交',
  reapply: '重新提交申请',
};

const SUCCESS_NOTICE: Record<Props['mode'], string> = {
  create: '申请已提交，等待管理员审核',
  edit: '已保存并重新提交，等待管理员审核',
  reapply: '申请已重新提交，等待管理员审核',
};

/** 部门路径的最大字符数（3 级 × 40 + 2 个分隔符）；超出直接报错，不静默截断 */
const DEPARTMENT_INPUT_MAX = DEPARTMENT_MAX_LEVELS * DEPARTMENT_SEGMENT_MAX + (DEPARTMENT_MAX_LEVELS - 1);

/**
 * 成员账号申请表单。
 *
 * `create` / `reapply` 走 POST /api/portal/members（`reapply` 是开通失败后重新发起，
 * 可改部门与备注，状态回到 `pending` 重新审核）；`edit` 走
 * POST /api/portal/members/[id]/contact（待审核期间纠错、或被驳回后重新提交）。
 *
 * `edit` 表单由状态卡上的「修改」入口展开；与初始快照比对，没有任何改动时禁用提交，
 * 避免无意义地反复重新提交。取消或保存成功后由父组件收起表单。
 *
 * 部门是手填多级路径，前端只做语法校验与预览；节点是否存在、要不要新建由管理员审核时在服务端决定。
 */
export function ApplicationForm({
  mode,
  applicantName,
  memberNamePreview,
  application,
  onCancel,
  onSaved,
}: Props) {
  const router = useRouter();
  const [snapshot] = useState<Snapshot>(() => snapshotOf(application));
  const [email, setEmail] = useState(snapshot.email);
  const [countryCode, setCountryCode] = useState(snapshot.countryCode);
  const [phone, setPhone] = useState(snapshot.phone);
  const [departmentPath, setDepartmentPath] = useState(snapshot.departmentPath);
  const [remark, setRemark] = useState(snapshot.remark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const department = normalizeDepartmentPath(departmentPath);
  // 与校验器同口径：按 Unicode 码点计长，避免补充平面汉字被误判超长
  const departmentTooLong = Array.from(departmentPath).length > DEPARTMENT_INPUT_MAX;
  const departmentValid = department.ok && !departmentTooLong;
  const departmentErrors = departmentTooLong
    ? [`部门路径最长 ${DEPARTMENT_INPUT_MAX} 个字符，请删减后再提交`]
    : department.errors.map((item) => item.message);

  // 与提交时的归一化口径一致：空格、全角斜杠等写法差异不算「改了内容」
  const normalizedPath = department.ok ? department.path : departmentPath;
  const isDirty =
    email.trim() !== snapshot.email ||
    countryCode.trim() !== snapshot.countryCode ||
    phone.trim() !== snapshot.phone ||
    normalizedPath !== snapshot.departmentPath ||
    (mode !== 'edit' && remark !== snapshot.remark);

  function handleCancel(): void {
    setEmail(snapshot.email);
    setCountryCode(snapshot.countryCode);
    setPhone(snapshot.phone);
    setDepartmentPath(snapshot.departmentPath);
    setRemark(snapshot.remark);
    setError(null);
    setNotice(null);
    onCancel?.();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!departmentValid) {
      setError(departmentErrors[0] ?? '请检查部门填写');
      return;
    }
    if (mode === 'edit' && !isDirty) {
      setError('资料没有改动，无需重新提交');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    const url =
      mode === 'edit' && application
        ? appPath(`/api/portal/members/${application.id}/contact`)
        : appPath('/api/portal/members');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          countryCode: countryCode.trim(),
          phone: phone.trim(),
          departmentPath: department.path,
          ...(mode === 'edit' ? {} : { remark }),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? '提交失败，请稍后重试');
        return;
      }

      if (mode === 'edit') {
        // 收起表单，状态卡会随 router.refresh() 显示最新资料；成功提示交由父组件展示
        router.refresh();
        onSaved?.();
        return;
      }

      // create / reapply 留在表单里展示成功提示
      setNotice(SUCCESS_NOTICE[mode]);
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-card border border-line bg-white p-6"
      aria-label={mode === 'edit' ? '修改申请资料' : '成员账号申请'}
    >
      <h2 className="text-base font-semibold leading-6 text-ink-900">{HEADING[mode]}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-500">
        {mode === 'reapply'
          ? '上次开通没有成功，修改资料后重新提交会回到审核队列，管理员会再审核一次。'
          : mode === 'edit'
            ? '请确保邮箱可正常收信；保存后会重新提交给管理员审核，通过后腾讯云会向新邮箱发送激活邮件。'
            : '腾讯云会向填写的邮箱发送激活邮件，请确保邮箱可正常收信；成员名会按「姓名-工号」自动生成。'}
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-ink-500">申请人</dt>
          <dd className="mt-1 text-sm text-ink-900">{applicantName || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">成员名</dt>
          <dd className="mt-1 text-sm text-ink-900">{application?.memberName ?? memberNamePreview}</dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-ink-500">
          邮箱
          <input
            className={inputClass}
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@school.edu.cn"
            autoComplete="email"
          />
        </label>

        <label className="text-xs text-ink-500">
          手机号
          <div className="mt-1 flex gap-2">
            <input
              className="w-20 rounded-control border border-line bg-white px-2 py-2 text-sm text-ink-900 outline-none transition hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15"
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value)}
              aria-label="国际区号"
              inputMode="numeric"
            />
            <input
              className="w-full rounded-control border border-line bg-white px-3 py-2 text-sm text-ink-900 outline-none transition hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="numeric"
              autoComplete="tel"
            />
          </div>
        </label>

        <div className="sm:col-span-2">
          <label className="text-xs text-ink-500" htmlFor="department-path">
            所属部门
          </label>
          <input
            id="department-path"
            className={inputClass}
            required
            value={departmentPath}
            onChange={(event) => setDepartmentPath(event.target.value)}
            placeholder="例：教务处/数学组"
            aria-invalid={departmentPath.length > 0 && !departmentValid}
            aria-describedby="department-path-help department-path-errors"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="department-path-help" className="mt-1 text-xs leading-5 text-ink-500">
            用 / 分隔多级部门，最多 {DEPARTMENT_MAX_LEVELS} 级、每级最多 {DEPARTMENT_SEGMENT_MAX} 个字符；
            不用填写根节点。仅支持中英文、数字和 +@&amp;._[]- ，不支持冒号、逗号与空格。
          </p>
          {departmentValid && departmentPath.trim().length > 0 && (
            <p className="mt-1 text-xs leading-5 text-ink-700">
              将归属：{department.segments.join(' / ')}（若腾讯云中不存在，审核通过后自动创建）
            </p>
          )}
          {departmentErrors.length > 0 && departmentPath.trim().length > 0 && (
            <ul id="department-path-errors" role="alert" className="mt-1 flex flex-col gap-0.5">
              {departmentErrors.map((message) => (
                <li key={message} className="text-xs leading-5 text-danger">
                  {message}
                </li>
              ))}
            </ul>
          )}
          {departmentPath.trim().length === 0 && (
            <p className="mt-1 text-xs leading-5 text-ink-500">请填写所属部门后再提交。</p>
          )}
        </div>

        {mode !== 'edit' && (
          <label className="text-xs text-ink-500 sm:col-span-2">
            备注（选填）
            <input
              className={inputClass}
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              maxLength={100}
              placeholder="例如：开票主体、使用场景"
            />
          </label>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 rounded-control border border-[#BFE3CE] bg-[#E8F5EE] px-3 py-2 text-sm text-success">
          {notice}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !departmentValid || (mode === 'edit' && !isDirty)}
          className="flex h-9 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? '提交中…' : SUBMIT_LABEL[mode]}
        </button>
        {mode === 'edit' && onCancel && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="flex h-9 items-center rounded-control border border-line bg-white px-4 text-[13px] font-medium text-ink-700 transition hover:border-ink-300 hover:bg-cream-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            取消
          </button>
        )}
        <span className="text-xs text-ink-500">
          {mode === 'edit'
            ? '保存后会重新提交给管理员，通过后自动开通'
            : '提交后由管理员审核，通过即自动开通'}
        </span>
      </div>
    </form>
  );
}
