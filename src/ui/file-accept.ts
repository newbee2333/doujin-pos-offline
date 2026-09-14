/**
 * 导入用的 file input 属性——iOS 与 Android 的正确解法是相反的。
 *
 * Android：裸的 `<input type="file">` 在部分浏览器里会退化成**媒体选择器**
 *   （只给「拍照 / 录像 / 照片和视频」，没有「文件」入口），
 *   导致用户根本无法选中 .sqlite3 备份文件。把 accept 设成通配值才会出现文件入口。
 *
 * iOS Safari：不能写具体的 accept 类型。iOS 按系统 UTI 过滤，
 *   `.sqlite3` / `.db` / `application/x-sqlite3` 都没有对应 UTI，
 *   一旦列出来，文件会在「文件」App 里**整个置灰**选不中。保持不设 accept 才正常。
 *
 * 文件是否合法由内容判定（文件头 + application_id），不靠扩展名，
 * 所以这里放宽 accept 不会造成误收。
 */

/** 返回应设置的 accept 值；`undefined` 表示不设该属性。 */
export function importFileAccept(userAgent: string): string | undefined {
  return /Android/i.test(userAgent) ? '*/*' : undefined;
}

/** 选不中文件时的排查提示，各平台指向各自的文件管理器。 */
export function importFileHint(userAgent: string): string {
  if (/Android/i.test(userAgent)) {
    return '如果列表里选不中，先用「文件管理」把备份文件下载到本机，再从这台设备里选。';
  }
  return '如果列表里选不中，检查「文件」App 里文件有没有下载到本机（iCloud 未下载的条目也会是灰色）。';
}
