# Doujin POS V1（按需求规格 V1.1 实现）

面向 Comiket / Comicup（CP）等同人展摊位的**本地优先、完全离线**电子菜单 + 购物车 + 游客自助下单 + 摊主 POS + 库存管理 + 销售记账系统。

本文说明**已实现的内容、如何运行、以及明确尚未完成的验收项**。需求依据为 `Doujin-POS-V1.1-development-spec.md`（V1.0 的冲突条款不叠加执行）。

---

## 一、快速开始

```bash
npm install
npm run dev          # http://localhost:5173
```

其他命令：

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 类型检查 + 生产构建（含 PWA / Service Worker） |
| `npm run test` | 真实 SQLite（sql.js）集成测试，38 项（事务 25 + 恢复 12 + 性能基线 1） |
| `npm run typecheck` | TypeScript 检查 |
| `npm run smoke` | Playwright 端到端冒烟（需 dev server 已启动，用系统 Edge） |
| `npm run serve:static` | 带 COOP/COEP 的本地静态服务器（零依赖） |

### 运行环境硬要求

应用在启动时做能力自检，任一项不满足会明确阻止营业：

- **安全上下文**：HTTPS 或 `localhost`
- **跨源隔离**：服务端必须返回 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`
  （`opfs-sahpool` VFS 依赖 `SharedArrayBuffer`。`vite.config.ts` 已为 dev / preview 配好；**自托管静态站需要同样配置响应头**）
- **OPFS / WebAssembly / Worker** 可用

不要用「直接双击打开本地 HTML」的方式在平板上安装——规格明确禁止这种安装方案。

---

## 二、本次实现范围（M1–M6）

### M1 离线数据库与可行性

- SQLite 官方 WASM（`3.51.2-build9`）跑在 Dedicated Web Worker 内，存储走 `opfs-sahpool`
- 启动自检：安全上下文、跨源隔离、WASM、OPFS、SharedArrayBuffer、Service Worker
- `navigator.storage.persisted() / persist() / estimate()`；持久化未获批时由摊主显式选择**受限营业**并持续提醒备份
- Web Locks 单写所有权；未拿到锁提示「已在另一个窗口运行」
- 整库导出：用官方 `sqlite3_js_db_export` 生成一致快照；导出时暂停新写入并等待当前事务
- 整库替换：A/B 槽位切换 —— 新库写进**非活动槽位**并校验，通过后才切换指针，失败自动退回原槽位
- schema 与迁移：`metadata` 表保存 `application_id / dataset_id / schema_version / revision / created_at / updated_at`

### M2 商品与资源

Product / Variant / Category / Asset / BundleComponent；默认分类与支付模板；归档；封面图自动压缩（最大边 1600px，优先 WebP）；**收款码走无损通道**（不压缩不缩放）；未使用资源回收。

### M3 展会与交易数据层

Event / EventVariantConfig / Inventory / InventoryTransaction / PaymentMethod 及本场启用；
Order / OrderItem / OrderInventoryComponent / Payment / Refund / RefundReturn / OrderCorrection / CorrectionReturn / CashMovement / Settlement / Idempotency / Audit。

关键规则已落库并用测试锁住：

- 金额全用最小单位整数（CNY 分 / JPY 日元），禁止浮点
- 购物车不占库；`pending_payment` 预留；`completed` 扣实际库存并释放原预留；`voided` 只释放预留
- **套装与普通商品共用库存，按整单合并成分后校验**，而不是逐行检查
- 确认、取消、退款、纠错只读订单快照，不重读现行配方或价格
- 所有写操作带 `operation_id`；同标识同参数返回既有结果，同标识不同参数拒绝
- 事务内用 SQL 断言复核不变量（乐观读给提示，原子断言保正确）

### M4 摊主 POS

快速收银、现金实收/找零、零元发放、待付款确认/取消、订单详情、整单退款（可部分实物返库）、撤销误记、库存调整（调整前后对比 + 原因 + 低于预留时拒绝）。
订单列表支持按**展会、状态、时间范围、订单号、来源、实际支付方式**筛选（实际收款优先，无收款记录时回退到计划方式）。

### M5 游客菜单与同机交接

中文菜单、分类筛选、搜索、购物车、结算、零元跳过支付、订单页二维码与付款说明、「请摊主处理」PIN 入口、挂起接待下一位、**5 分钟无操作倒计时 30 秒清空购物车**、后台路由受 PIN 保护（非仅隐藏按钮）。

### M6 报表、收摊与备份

销售额 / 退款额 / 净销售额 / 纠错额分列、各状态订单数、销量与赠品发放、支付方式收款-退款-净流入、商品排行、库存成分售出/返库/净消耗；现金备用金与存入取出、理论钱箱、收摊结算与差额；6 类 CSV 导出（UTF-8 BOM + 公式注入防护）。

备份提醒分三层，「已生成导出」与「用户确认已保存」严格区分：
- 开场前 24 小时未确认保存 → 首页提示
- 营业中每 2 小时 → **非打断横幅**（可「稍后」，且在 `/kiosk` 游客付款流程中完全不出现）
- 收摊后 → 首页显著提示「数据只存在这台设备，请立即导出」

---

## 三、自动化验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（precache 14 项，含 sqlite3.wasm） |
| `npm run test` | **38 / 38 通过**（真实 SQLite，非 mock） |
| `npm run smoke` | **11 / 11 通过**，控制台无错误 |

测试覆盖（第 27 节对应项）：金额精度、直接销售与零元单、预留→确认→取消、库存不足整单拒绝、套装共用最后一件、盘点低于预留拒绝、合并限购、配方变化后按旧快照扣库、改名换码不改历史快照、整单退款全/部分/零返库、重复退款拦截、撤销误记与真实退款分开、幂等重复提交、同标识冲突拒绝、报表与现金口径、全部业务不变量、整库往返一致。

端到端冒烟（系统 Edge）：建库 → 建展会 → 建商品 → 配价格 25.00 与初始库存 10 → 开场条件检查 → 开场 → 收银实收 30 → 订单 #1 成交找零 ¥5.00 → 库存 10→9 预留 0 可用 9 → 收摊 → 首页出现「立即导出」提示 → 刷新后数据仍在。

### 数据体积与性能基线（120 商品 / 1000 订单，含图）

> 跑的是**内存 sql.js**，只用于建立「数据体积」与「语句复杂度」的可比基线，**不能**当作设备 p95。

| 指标 | 实测 |
| --- | --- |
| 数据库体积 | 2.79 MB（含 60 张 4 KB 测试封面） |
| 建商品 | 1.3 ms/个 |
| 下单 p50 / p95 / max | 0.53 / 0.86 / 3.14 ms |
| 菜单查询（120 项） | 1.2 ms |
| 仪表盘 / 商品排行 | 1.5 / 1.2 ms |

体积外推：真实 1600px WebP 封面约 100–300 KB/张，120 个商品全配真实封面预计 **18–42 MB**。
导入导出在真机 OPFS（闪存）上的耗时会显著高于内存值，需实测。

---

## 四、部署：HTTPS + COOP/COEP

自托管静态站**必须**返回跨源隔离响应头，否则 `opfs-sahpool` 起不来，应用会直接显示「当前环境不能营业」并列出缺失项。

| 方式 | 配置文件 |
| --- | --- |
| Netlify / Cloudflare Pages | `deploy/_headers.netlify`（发布时改名为 `_headers` 放到发布目录根） |
| Vercel | `deploy/vercel.json` |
| nginx | `deploy/nginx.snippet.conf` |
| 本机 / 局域网自测 | `npm run serve:static`（零依赖，已带正确响应头） |

```bash
npm run build
npm run serve:static                 # http://localhost:4173
# iPad 需要 HTTPS 且证书被信任（自签名在 iOS Safari 上不能用于 Service Worker）：
npm run serve:static -- --cert ./certs/cert.pem --key ./certs/key.pem
```

在 iPad 上装 PWA 的可行路径：mkcert 签发局域网证书 + iPad 装根证书，或直接部署到上述静态托管。

## 五、明确未完成（按规格第 28 节要求如实标注）

以下内容**没有完成**，不应视为 V1 已通过验收：

1. **M7 真机验收未执行**。iPadOS Safari / Android Chrome 的飞行模式冷启动、锁屏恢复、从「文件」导入、8 小时持续营业模拟都需要真实设备。Playwright + 桌面 Edge **不能替代** iPadOS 真机。
   已备好可勾选清单：**`docs/M7-acceptance-checklist.md`**，在设备上照着跑并把实测数值填回即可。
2. **设备端性能 p95 未测**。内存基线已采集（见下），但闪存上的导入导出耗时、真机下单响应时间仍待实测。
3. **故障恢复的极端场景未逐个实测**：空间不足、切换过程中强制退出/断电、候选库迁移失败。代码采用 A/B 槽位 + 阶段记录的可恢复设计，业务层不变量已自动化验证，但物理层面的强杀验证需要真机配合。
4. **静态托管未实际部署**。配置文件与本地服务器已提供，正式域名部署待授权。
5. 未做日文界面与语言切换（规格 V1 明确不做）。

---

## 六、目录结构

```
src/
  domain/        领域类型、金额、图片处理、ID 与时间
  db/            schema 与迁移、事务步骤抽象、Worker、主线程客户端、
                 测试用真实 SQLite 执行器、业务不变量、存储与所有权检查
  services/      服务层（校验 + 生成 SQL 步骤）：catalog / events / inventory /
                 orders / reports / system / context
  ui/            组件与页面
  store.ts       应用状态（会话、PIN、购物车、当前订单）
scripts/         Playwright 冒烟脚本
```

架构遵循规格第 3 节：**React 不写 SQL**，SQL 只出现在 `services/`，由 Worker 在单个 `BEGIN IMMEDIATE … COMMIT` 内执行；UI 通过服务层读写。
