/**
 * 部门路径的语法归一化与校验（纯函数，可在客户端组件中直接引用）。
 *
 * 字符集与长度对齐腾讯云 `AddOrganizationNode.Name`：中英文、数字与 `+@&._[]-`。
 * 这里**只做语法**，不碰任何腾讯云数据：根节点前缀的剔除在服务端 `departments.ts` 做，
 * 因为只有服务端才知道根节点叫什么。
 *
 * 该文件只允许 import 类型。任何服务端依赖（尤其签名模块的 `node:crypto`）被引进来，
 * 都会让 'use client' 组件的构建失败。
 */

/** 最多层级数（不含 root） */
export const DEPARTMENT_MAX_LEVELS = 3;
/** 单级最大字符数（按 Unicode 码点计） */
export const DEPARTMENT_SEGMENT_MAX = 40;
/** 腾讯云部门名允许的字符集合（注意：比 `rules.ts` 的成员名字符集更严，不含 `:` 与 `,`） */
export const DEPARTMENT_SEGMENT_PATTERN = /^[\p{Script=Han}A-Za-z0-9+@&._[\]-]+$/u;

export type DepartmentPathError = {
  /** 1 起的层级序号；0 表示整体错误 */
  index: number;
  message: string;
};

export type DepartmentPathResult = {
  ok: boolean;
  /**
   * 归一化后的路径。`ok=false` 时只用于展示，**不可回填输入框、不可落库**：
   * 它由非空分段拼成，可能与 `segments` 不一致（例如 `a//b`）。
   */
  path: string;
  segments: string[];
  errors: DepartmentPathError[];
};

const SEPARATOR = /\s*[/／＼\\]\s*/g;

function segmentLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 归一化部门路径。
 *
 * 容忍：全角斜杠、反斜杠、每段前后空白、首尾斜杠。
 * 拒绝：空层、超过 3 级、单级超 40 字符、非法字符、`.` 与 `..`。
 */
export function normalizeDepartmentPath(raw: string | null | undefined): DepartmentPathResult {
  const errors: DepartmentPathError[] = [];

  const compact = String(raw ?? '')
    .replace(SEPARATOR, '/')
    .trim();

  if (!compact) {
    return {
      ok: false,
      path: '',
      segments: [],
      errors: [{ index: 0, message: '请填写部门，例如：教务处/数学组' }],
    };
  }

  // 只有分隔符（`/`、`///`、` // `）属于「层级为空」，与真空白区分开，文案才能对上 spec
  const normalized = compact.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return {
      ok: false,
      path: '',
      segments: [],
      errors: [{ index: 0, message: '层与层之间不能为空，请用 / 分隔多级部门' }],
    };
  }

  const segments = normalized.split('/').map((segment) => segment.trim());

  segments.forEach((segment, index) => {
    const level = index + 1;

    if (!segment) {
      errors.push({ index: level, message: '层与层之间不能为空，请用 / 分隔多级部门' });
      return;
    }
    if (segment === '.' || segment === '..') {
      errors.push({ index: level, message: `第 ${level} 级不能是 "." 或 ".."` });
      return;
    }
    if (segmentLength(segment) > DEPARTMENT_SEGMENT_MAX) {
      errors.push({
        index: level,
        message: `第 ${level} 级最多 ${DEPARTMENT_SEGMENT_MAX} 个字符`,
      });
      return;
    }
    if (!DEPARTMENT_SEGMENT_PATTERN.test(segment)) {
      errors.push({
        index: level,
        message: `第 ${level} 级含有不支持的字符（仅支持中文、英文、数字和半角符号 +@&._[]- ，不支持冒号、逗号与空格）`,
      });
    }
  });

  // 层级数只算真实存在的层：`a//b/c` 是 3 级 + 1 个空层，不能报成 4 级
  const levels = segments.filter(Boolean).length;
  if (levels > DEPARTMENT_MAX_LEVELS) {
    errors.push({
      index: 0,
      message: `最多支持 ${DEPARTMENT_MAX_LEVELS} 级部门，当前填了 ${levels} 级`,
    });
  }

  const path = segments.filter(Boolean).join('/');
  return { ok: errors.length === 0, path, segments, errors };
}
