---
name: Doujin POS
description: 同人场刊 / Risograph 轻印风 · 离线电子菜单与摊位工作台
colors:
  paper: "#f9f7f4"
  warmPaper: "#faf5ec"
  surface: "#ffffff"
  sidebarPaper: "#f3f1f7"
  indigoInk: "#1e2436"
  cherryRose: "#d41956"
  cherryText: "#b8154a"
  roseSoft: "#fde8ef"
  promoAmber: "#fef3c7"
  promoInk: "#8a3d06"
---

# Design System: Doujin POS（同人场刊 / Risograph 轻印风）

## Overview

以日系同人展场刊与 Risograph 轻印刷物为视觉灵感，用通透的画纸底色、深靛墨正文和樱桃玫红主色建立高对比、活泼但不喧宾夺主的界面秩序。样式统一收口在 `src/styles.css`，不再叠加多层覆写样式表。

## Colors & Themes

- **清爽白（`light`）**：浅画纸底 `#f9f7f4`、纯白内容卡 `#ffffff`、柔和浅靛纸面侧栏 `#f3f1f7`、深靛墨正文 `#1e2436`、樱桃玫红主填充 `#d41956`（白字对比度 > 5:1）、文字强调 `#b8154a`。
- **暖纸（`warm`）**：暖米画纸底 `#faf5ec`、暖白卡片 `#fffdf8`、暖纸侧栏 `#f4eee3`、暖炭墨正文 `#242126`、樱桃玫红 `#cc1b54`。
- **深色夜间（`dark`）**：深靛夜空底 `#13151d`、深靛卡片 `#1b1e29`、侧栏 `#171a24`、浅纸白字 `#eef0f6`、亮樱桃文字 `#ff7ba5` 与玫红按钮 `#d41956`。
- **功能点缀**：优惠与满减贴纸统一用暖橘黄浅底深字（`--promo-bg` / `--promo-ink`）；摊位号与领货券编号使用深靛印章块（`--stamp-bg` / `--stamp-ink`）。所有主题正文与语义色对均满足 WCAG AA（≥ 4.5:1）。

## Layout & Navigation

- **游客菜单页头**：浅底单行紧凑布局（`KioskCatalogHeader`），由摊位号印章、摊位/展会名、非空分类标签、「仅看有货」快捷切换、搜索框和「摊主处理」组成，最大限度把纵向空间让给封面网格。
- **后台外壳**：柔和浅靛纸面侧栏 + 顶部当前展会状态条（展会名、摊位号印章、营业状态）；侧栏「待付款」实时展示未处理笔数角标。

## Signature Components

- **商品卡片与缺省封面**：1:1 顶部对齐封面、下方品名与分类、暖黄优惠贴纸、带柔光晕的 44px 樱桃玫红圆形加购钮；无封面商品自动渲染按分类区分的几何线框图标占位（`CategoryPlaceholder`）。
- **动态满减凑单提示（`ThresholdProgress`）**：在横屏右侧购物车、购物车页与底部悬浮条实时提示距离下一档满减的差额或已享优惠，配合 220ms 轻弹加购反馈。
- **摊位领货券（`KioskOrder`）**：取货号卡片采用带虚线齿孔分隔的领货券版式，高对比呈现取货号与金额，与下方摊主处理区清晰分层。
- **统一现金收款控件（`CashTenderControl`）**：在摊主收银、待付款与游客付款页摊主区共享，内置按币种适配的一键面额按钮（CNY `10/20/50/100`、JPY `1000/5000/10000`）与大字实时找零横幅。
