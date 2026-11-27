'use client';

import { useState } from 'react';
import type { MemberApplication } from '@/lib/members/types';
import { ApplicationForm } from './ApplicationForm';
import { ApplicationStatus } from './ApplicationStatus';

type Props = {
  application: MemberApplication;
  applicantName: string;
  memberNamePreview: string;
  /** 服务端时间，透传给状态卡避免 hydration 时刻不一致 */
  now?: number;
};

/**
 * 待审核（或可被驳回/中断后可纠错）的申请单区块。
 *
 * 「修改」入口放在状态卡上，点击后才展开修改表单；保存成功或取消后收起表单，
 * 回到状态卡。这样不会一进页面就摆着一张只读卡 + 一张表单卡两张卡。
 */
export function MemberAccountPanel({ application, applicantName, memberNamePreview, now }: Props) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <ApplicationStatus
        application={application}
        now={now}
        onEdit={() => setEditing(true)}
        editing={editing}
      />
      {editing && (
        <ApplicationForm
          mode="edit"
          applicantName={applicantName}
          memberNamePreview={memberNamePreview}
          application={application}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
    </>
  );
}
