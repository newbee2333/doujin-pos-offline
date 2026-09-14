import { describe, expect, it } from 'vitest';
import { importFileAccept, importFileHint } from '../file-accept';

/**
 * 回归防线：导入用的 file input 属性在 iOS 与 Android 上要求相反。
 *
 * 安卓实机反馈（2026-09-14）：裸 file input 在选择文件时只弹出
 * 「拍照 / 录像 / 照片和视频」，没有「文件」入口，备份根本导不进来。
 * 而 iOS 一旦写了具体 accept 类型，.sqlite3 会在「文件」App 里被置灰。
 */
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_IOS =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('importFileAccept', () => {
  it('Android 用通配 accept，否则弹不出「文件」入口', () => {
    expect(importFileAccept(UA_ANDROID)).toBe('*/*');
  });

  it('iOS 不设 accept（设了 .sqlite3 会被置灰选不中）', () => {
    expect(importFileAccept(UA_IOS)).toBeUndefined();
  });

  it('桌面浏览器不设 accept', () => {
    expect(importFileAccept(UA_DESKTOP)).toBeUndefined();
  });
});

describe('importFileHint', () => {
  it('Android 指向「文件管理」', () => {
    expect(importFileHint(UA_ANDROID)).toContain('文件管理');
  });

  it('iOS 指向「文件」App', () => {
    expect(importFileHint(UA_IOS)).toContain('「文件」App');
  });
});
