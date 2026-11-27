/**
 * 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名。
 *
 * 只依赖 `node:crypto`：官方 SDK 会带来整套 `tencentcloud-sdk-nodejs` 依赖树，
 * 门户只有 5 个接口要调，手写这 80 行更划算，也能用固定向量锁住行为。
 */

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'TC3-HMAC-SHA256';
const SERVICE = 'organization';
const CONTENT_TYPE = 'application/json; charset=utf-8';

export type SignInput = {
  secretId: string;
  secretKey: string;
  /** API 域名，例如 organization.tencentcloudapi.com */
  host: string;
  /** 仅用于注释与调试，签名本身不直接使用 */
  action: string;
  /** 请求体 JSON 字符串 */
  payload: string;
  /** Unix 秒；传参而不是读系统时钟，测试才能给出固定向量 */
  timestamp: number;
};

export type SignResult = {
  authorization: string;
  /** yyyy-mm-dd，签名凭证作用域里的日期 */
  date: string;
  contentType: string;
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

function toDateStamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function signRequest(input: SignInput): SignResult {
  const date = toDateStamp(input.timestamp);
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${input.host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedPayload = sha256Hex(input.payload);

  const canonicalRequest = [
    'POST',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    ALGORITHM,
    String(input.timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    authorization:
      `${ALGORITHM} Credential=${input.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    date,
    contentType: CONTENT_TYPE,
  };
}
