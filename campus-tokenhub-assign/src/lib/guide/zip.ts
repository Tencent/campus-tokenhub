/**
 * 极小的 ZIP 打包器（只用 store 模式，不压缩）。
 *
 * 为什么需要它：浏览器下载没法给文件设置可执行位，macOS 的 `.command` 拿不到 +x
 * 就双击不了（Terminal 会直接报「权限不够」）。而 zip 能把 Unix 权限位一起存下来，
 * 解压（Finder 双击 zip 或 `unzip`）后 755 会还原，双击才能真正跑起来。
 *
 * 因此这里只需要「单个/少量小文件、不压缩、带 0755」这一种场景：
 * 没有目录层级、没有 Zip64、不做 DEFLATE，产物在几十 KB 以内。
 */

/** 每个条目：写进压缩包的相对路径、内容、Unix 权限位 */
export type ZipEntry = {
  /** 包内文件名，不要带前导 `/` */
  path: string;
  content: string;
  /** Unix 权限位，例如 0o755；解压时由 unzip / Archive Utility 还原 */
  mode: number;
  /** 条目时间戳，默认当前时间 */
  mtime?: Date;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** 3 = Unix，低字节是 zip 规范版本 3.0；写错这里 unzip 就不会还原权限位 */
const VERSION_MADE_BY = 0x031e;
const VERSION_NEEDED = 20;
/** bit 11：文件名按 UTF-8 编码（中文文件名也不会乱码） */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

/** CRC-32 查表；表只算一次 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间/日期：zip 只支持 1980-2107 的本地时间，超出范围就夹到边界 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    const stamp = dosDateTime(entry.mtime ?? new Date());

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, VERSION_NEEDED, true);
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    chunks.push(local, data);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    headerView.setUint16(4, VERSION_MADE_BY, true);
    headerView.setUint16(6, VERSION_NEEDED, true);
    headerView.setUint16(8, FLAG_UTF8, true);
    headerView.setUint16(10, METHOD_STORE, true);
    headerView.setUint16(12, stamp.time, true);
    headerView.setUint16(14, stamp.date, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, data.length, true);
    headerView.setUint32(24, data.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true);
    headerView.setUint16(32, 0, true);
    headerView.setUint16(34, 0, true);
    headerView.setUint16(36, 0, true);
    // 高 16 位是 Unix mode，低 16 位 0x8000 表示普通文件
    headerView.setUint32(38, ((entry.mode & 0xfff) | 0x8000) * 0x10000, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_SIGNATURE, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
