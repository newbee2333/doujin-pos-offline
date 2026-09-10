/**
 * 进入游客菜单前的确认。
 *
 * 为什么需要这一步：
 *   进入游客模式会立刻清掉后台会话（有意设计——防止顾客点「返回」落到后台页面）。
 *   但摊主在电脑上频繁切过去看效果时，每次回来都要重输 PIN，很烦。
 *   所以这里把代价讲清楚，并指向不锁后台的「菜单预览」。
 *
 * 放在独立模块里：App 与各页面都要用，放 App.tsx 会导致页面 ↔ App 循环引用。
 */
const CONFIRM_TEXT =
  '进入游客菜单后，后台会立即锁定，返回时需要重新输入 PIN。\n\n' +
  '只是想在电脑上看看游客菜单长什么样？请改用「菜单预览」，它不会锁定后台。\n\n' +
  '确定要进入游客菜单吗？';

export function confirmEnterKiosk(navigate: (path: string) => void): void {
  if (askBeforeKiosk()) navigate('/kiosk');
}

/** 供 NavLink 的 onClick 使用：返回 false 时调用方需 preventDefault。 */
export function askBeforeKiosk(): boolean {
  return window.confirm(CONFIRM_TEXT);
}
