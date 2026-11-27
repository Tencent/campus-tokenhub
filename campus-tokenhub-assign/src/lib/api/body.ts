/**
 * 请求体解析：只接受 JSON 对象，失败统一抛 400。
 *
 * 之前 4 个成员路由各写一份同样的 `readBody`，文案与错误码容易漂移。
 */

import { ApiError } from '@/lib/api/guard';

export const INVALID_BODY_MESSAGE = '请求体不是合法 JSON';
export const INVALID_BODY_CODE = 'invalid_body';

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a plain object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, INVALID_BODY_MESSAGE, INVALID_BODY_CODE);
  }
}
