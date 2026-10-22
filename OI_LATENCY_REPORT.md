# 交易所未平仓合约（Open Interest）数据获取方式与延迟诊断报告

- 检查时间：2026-10-22 13:15–13:29（Asia/Shanghai，即 05:15–05:29 UTC）
- 检查方式：源码静态走查 + 5 分钟线上实测（Node 24 直连交易所公共接口）
- 实测对象：Bybit 永续 `BTCUSDT`
- 结论：**项目没有订阅 Bybit `tickers.{symbol}` WebSocket 流，也没有从任何 WS 推送解析 openInterest；Bybit 的 OI 目前是 60 秒一次的 REST 轮询。延迟主因是这 60 秒轮询（实测 OI 变化平均要等 30.4 秒、最长 60.2 秒才被采样到），而非数据源慢——Bybit 的 WS ticker 流本身最迟约 12 秒就会推送 OI 变化。**

---

## 1. 各交易所 OI 获取方式对比

OI 有两条独立链路：本地服务器（`src/server`）和浏览器直连（`src/shared/engine.ts` 的 `#pollOi`，页面运行在 Web Worker 里）。除 Hyperliquid 走 WebSocket 外，**所有交易所的实时 OI 都是 60 秒一次 REST 轮询**。

### 1.1 本地服务器（`npm run dev` / `server`）

| 交易所 | 方式 | 接口 / 频道 | 轮询间隔 | 取用的字段 | 时间戳处理 | 历史数据 | 失败处理与可见性 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Binance | REST 轮询 | `GET https://fapi.binance.com/fapi/v1/openInterest?symbol=X`（`live-feeds.mts` 的 `pollOpenInterest`） | 60 s（`oiPollMs = 60_000`） | `openInterest` | 保留交易所 `time` 字段作 `sourceTimestamp` → reducer 里 `observationTimestamp = sourceTimestamp`，`timeBasis: 'exchange'` | 启动时读 `/futures/data/openInterestHist`（5m，500 条）写历史库；另有浏览器可读的 30 天历史 | `/api/diagnostics` 报 `feedManager.openInterest`（轮询中/失败次数/最后错误），每 10 分钟记一次日志；每次 REST 尝试有 30 s deadline（`REST_ATTEMPT_TIMEOUT_MS`） |
| **Bybit** | **REST 轮询** | **`GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=X`**（`src/server/v2/oi-sampler.mts`，`OI_SAMPLE_MS = 60_000`） | **60 s** | **`result.list[0].singleOpenInterest`（缺省时取 `openInterest/2`，即单边口径）** | **`sourceTimestamp: null` → `observationTimestamp = receivedAt`（本地接收时刻），`timeBasis: 'receipt'`；REST 响应自带的交易所 `time` 字段被丢弃** | 启动时读 `/v5/market/open-interest`（近 2 天 5min、再往前到 8 天 1h）写历史库，失败退避 1 min 起、倍增到 1 h | **采样失败静默跳过（下一分钟再试），没有任何 diagnostics 状态或日志**（只有 Binance 有） |
| OKX | REST 轮询 | `GET https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=X` | 60 s（OiSampler） | `data[0].oiCcy`（币本位） | `sourceTimestamp: null` → 本地接收时刻 | `/api/v5/rubik/stat/contracts/open-interest-history`（5m 约 2 天、1h 到 8 天，仅服务器可读：无 CORS 头）；OKX 行的时间戳是周期开始、值是周期末读数，代码把行挪到周期末（`fetchOiHistory`） | 同 Bybit，静默 |
| Bitget | REST 轮询 | `GET https://api.bitget.com/api/v2/mix/market/open-interest?symbol=X&productType=usdt-futures` | 60 s（OiSampler） | `data.openInterestList[0].size` | `sourceTimestamp: null` → 本地接收时刻 | 无 | 同 Bybit，静默 |
| Deribit | REST 轮询 | `GET https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=X` | 60 s（OiSampler） | `result[0].open_interest`（币本位永续按 mark 折算成币） | `sourceTimestamp: null` → 本地接收时刻 | 无 | 同 Bybit，静默 |
| Hyperliquid | **WebSocket** | 频道 `activeAssetCtx`（`buildHyperliquidSubscription('activeAssetCtx')`），从推送的 asset context 解析 `openInterest`（quality `native`）；启动时先用 REST `metaAndAssetCtxs` 快照兜底 | 交易所推送节奏（代码未自定间隔） | `openInterest` | 交易所 `time` 字段（exchange 基准） | 无公开历史；服务器把 WS 样本写进历史库 | 断线走 feed 的重连机制（与其他 Hyperliquid 频道同一个 socket） |

补充说明：

- `OiSampler`（Bybit/OKX/Bitget/Deribit 四家共用）只在对应 venue 的 order book 处于 live 状态时采样：`installV2` 的主循环每 5 秒把当前 live books 列表同步给它（`src/server/v2/api.mts:292`）。
- 采样结果经 `app.applyMessage` 进 reducer（`src/server/http.mts:1670`），写入历史库（`recordOi`）并更新内存 `state.oi`；`/api/v2/oi` 把存储的历史 bars 和内存 live 样本合并聚合后返回。
- 浏览器模式（`src/shared/engine.ts` `#pollOi`，每 250 ms 的 step 里检查）：六家（binance/bybit/hyperliquid/bitget/okx/deribit）都是 60 s 一次 REST 采样（`OI_SAMPLE_MS = 60_000`，`OI_KEEP_MS = 3 天`），需要该 venue 的 book 已连接；样本时间戳一律用本地时间（`observationTimestamp = t`）；采样结果存 IndexedDB（`oi` store）。
- UI 侧：页面每 20 秒重新请求一次 OI 数据（`src/app/main.ts:297` `setInterval(loadOi, 20_000)`），而数据源 60 秒才出新值——每 3 次刷新里约 2 次拿不到新数据。

### 1.2 浏览器直连的 REST 端点（`src/shared/history.ts` `readOiSample`）

| 交易所 | 端点 | 字段 |
| --- | --- | --- |
| Binance | `GET https://fapi.binance.com/fapi/v1/openInterest?symbol=X` | `openInterest` |
| Bybit | `GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=X` | `singleOpenInterest`（缺省 `openInterest/2`） |
| OKX | `GET https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=X` | `data[0].oiCcy` |
| Bitget | `GET https://api.bitget.com/api/v2/mix/market/open-interest?symbol=X&productType=usdt-futures` | `data.openInterestList[0].size` |
| Deribit | `GET https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=X` | `result[0].open_interest` |
| Hyperliquid | `POST https://api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` | `[1][i].openInterest` |

## 2. Bybit 专项确认

**问题：项目是否订阅了 `tickers.{symbol}` WebSocket 流？是否从推送消息解析 openInterest？**

**答案：没有。** 证据：

- 服务器侧 `live-feeds.mts:856` 为 Bybit 建立的唯一 feed spec 是 `bybit-depth`，订阅 `orderbook.1000.<symbol>`（`buildBybitSubscription('depth', …)`），没有任何 ticker 订阅。
- 浏览器侧 `src/shared/venues.ts` 的 `BybitBook.open()` 订阅 `orderbook.1000.<symbol>` + `publicTrade.<symbol>` +（linear 时）`allLiquidation.<symbol>`，同样没有 ticker 订阅。
- `src/adapters/bybit.mts:201` 里 `buildBybitSubscription('ticker')` 确实能生成 `tickers.<symbol>` 这个 topic，但全仓库搜索只有这一处定义，**没有任何调用点**（死代码）。`normalizeBybitOpenInterest`（解析 `/v5/market/open-interest` REST 响应）与 `buildBybitRequest('openInterest')` 同样没有任何调用点。

**现状使用的接口与间隔：**

- 服务器：`OiSampler` 每 **60 s** 轮询 `GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=X`，取 `singleOpenInterest`（单边口径，缺省 `openInterest/2`）；读到的值以**本地接收时间**作为样本时间戳，REST 响应自带的交易所 `time` 字段被丢弃。
- 浏览器：`engine.#pollOi` 每 **60 s** 用同一个 REST 端点采样。
- 历史回填：启动时读 `/v5/market/open-interest`（2 天 5min bars + 8 天 1h bars）。

## 3. Bybit 实测结果（5 分钟，2026-10-22 05:23:53–05:28:54 UTC）

实测环境：Node v24.21.0 直连；REST 到 `api.bybit.com` 单次往返约 104 ms，60 次请求 0 失败；WS `wss://stream.bybit.com/v5/public/linear` 全程 0 断线。本机时钟比 Bybit 服务器时钟慢约 0.97 s（REST 响应 `time` 与本机接收时刻差稳定在 +965 ~ +983 ms）。原始数据见 `oi-latency-probe-results.json`。

### 3.1 WebSocket `tickers.BTCUSDT`（当前项目未订阅的流）

| 指标 | 实测值 |
| --- | --- |
| 300 秒内消息总数 | 2 277 条（≈ 7.6 条/秒） |
| 消息构成 | 1 条 snapshot（全字段）+ 2 276 条 delta（**只含变化字段**） |
| 5 分钟内 OI 值变化次数 | **31 次**（≈ 6.2 次/分钟） |
| 相邻两次 OI 变化间隔 | 最小 7.0 s，中位 9.0 s，P90 12.0 s，**最大 12.0 s**（多次恰好 12.0 s） |
| 重连 | 0 |

要点：

- Bybit ticker 流是 **snapshot + delta 结构**：订阅时先推一条全字段 snapshot（含 `openInterest`/`singleOpenInterest`），之后 delta 只携带发生变化的字段。**OI 字段只在 OI 变化时出现在 delta 里**（实测 15 秒 134 条消息中只有 3 条带 OI 字段）。
- 数据源本身是"批处理"的：OI 变化后约 **0–12 秒**内推送到 WS，不是逐合约事件即时推送。即使接入 WS，显示的 OI 最多也只比真实值晚约 12 秒（无变化时不推，值保持）。
- WS 消息自带交易所时间戳 `ts`；与本机接收时刻差 +0.1 ~ +1.0 s（与本机时钟偏慢 ~0.97 s 一致）。

### 3.2 REST（项目现状所用接口）与对照

| 对照组 | 结果 |
| --- | --- |
| 每 5 s 快速轮询 `tickers` REST（对照组，300 s） | 61 次请求、0 失败；检测到 **30 次** OI 变化（与 WS 的 31 次基本一致 → REST 端点数据是新鲜的、无缓存滞后；同一时刻 REST 的 OI 值 == WS 的 OI 值） |
| 每 60 s 轮询（项目实际节奏，300 s） | 4 次采样，值都不同（30418.6 → 30413.8 → 30411.8 → 30413.6） |
| **WS 每次 OI 变化 → 下一次 60 s 采样之间的等待** | **最小 5.2 s，平均 30.4 s，中位 35.2 s，P90 53.2 s，最大 60.2 s** |

### 3.3 REST 数据时间戳对比

- Bybit REST 响应顶层带交易所服务器时间 `time`（ms）。实测 60 s 采样时 `time − 本地接收时刻 ≈ +974 ms`（本机时钟偏慢；若双方时钟同步，该差应约等于半个 RTT ≈ 50 ms）。
- 项目对 Bybit 采样消息显式传 `sourceTimestamp: null`（`oi-sampler.mts:90`），reducer 因此把 `observationTimestamp` 定为本地接收时刻（`http.mts:1677`），**交易所 `time` 被丢弃**。
- 对照 Binance：保留交易所 `time` 作为 `sourceTimestamp`（`timeBasis: 'exchange'`）。两家时间基准不一致（Bybit=接收时刻、Binance=交易所时刻），在本机时钟偏差 ~1 s 的量级上，分钟级归桶偶尔会差一个桶，但不构成秒级以上的延迟。
- 历史端点 `/v5/market/open-interest`（5min）的 `timestamp` 是**周期结束时刻**（实测 05:20:00Z 的 bar 在 05:23:53 就返回了）；代码把它当作"该读数自身时刻"写入（`sourceTimestamp = t`）。这与 Binance"读数时刻"口径一致，可以接受，但和"周期开始"语义不同（报告里说明以免误解）。

### 3.4 端到端延迟账（现状链路）

OI 变化 →（等下一次 60 s REST 采样，均值 30 s、最坏 60 s）→（等下一次 20 s UI 刷新，均值 10 s）→ 显示。
**合计：均值 ≈ 40 s，最坏 ≈ 80 s，最好 ≈ 0–5 s（变化恰好落在采样/刷新窗口）。**

## 4. 延迟根因判断

按影响从大到小：

1. **项目的轮询间隔 / 接口选择（主因，可修且收益最大）。** Bybit 的 OI 只靠 60 s REST 轮询，而 Bybit 自己的 WS ticker 流 ≤12 s 就能给出变化。实测为这 60 s 采样额外等待：均值 +30.4 s、P90 +53.2 s、最大 +60.2 s。**不是数据源慢，是采集方式慢。**
2. **数据源批处理（次因，上限约 12 s）。** Bybit ticker 的 OI 更新以 ~7–12 s 的批次推送，且"变化才推送"。接入 WS 后，UI 上的 OI 仍可能比真实值晚至多约 12 s，且无变化期间显示最后值（与现状语义一致）。
3. **UI 刷新与采样节奏不匹配（小）。** 页面 20 s 刷新一次、采样 60 s 一次，多数刷新拿不到新数据；接入 WS 后这个 20 s 时钟可直接受益。
4. **时间戳处理不一致（小）。** Bybit 丢弃交易所 `time`、用本地接收时间；Binance 用交易所时间。本机时钟偏 ~1 s 时影响分钟归桶边界与"样本年龄"读数，不造成 60 s 级延迟。
5. **失败可见性（隐患，非当前延迟来源）。** `OiSampler` 采样失败静默跳过、下一分钟再试，没有 `/api/diagnostics` 状态也没有日志（只有 Binance 的轮询有）。连续失败时 UI 只表现为 OI 越来越旧，没有任何告警。REST 无连接概念；WS 侧（Hyperliquid、Bybit 深度）已有成熟断线重连机制，tickers 订阅可以直接复用。

## 5. 建议的最小修改方案（**待确认后再改，本次未改动任何正式代码**）

原则：不改业务逻辑、不变口径（继续用 `singleOpenInterest` 单边口径、币单位）；**WS 只负责"新鲜度"，REST 保持"历史持久化 + 兜底"**。

### 方案 A：服务器侧接入 tickers WS（推荐，最小改动）

1. `src/server/live-feeds.mts`：给 `bybit-depth` 所在的同一个 socket 增加 `tickers.<symbol>` 订阅（`buildBybitSubscription('ticker', …)` 已能生成正确的 topic，无需新连接）；新增 decode：snapshot 全字段初始化，delta 里出现 OI 字段才更新；产出 `openInterest` 消息（`quality: 'native'`，`sourceTimestamp` 用消息 envelope 的 `ts`，沿用 `bybitSingle` 单边口径；inverse 品类按现有逻辑处理）。
2. `src/server/http.mts` 的 openInterest 分支已能接收这类消息；需要做两处保护：
   - `history.recordOi` 按 instrument 限流为每分钟一条（实测 31 次/5 分钟，若每条都写，Bybit 的历史行会从 1440 行/天涨到约 8900 行/天）；
   - 内存 `state.oi`（上限 20 000 条、全 instrument 共用）同样按"每 instrument 每分钟最后一条"合并，避免 WS 变化把内存窗口挤短。
3. `src/server/v2/oi-sampler.mts`：保留 60 s REST 作为兜底与历史回填（WS 样本 quality `native` 优先于 REST 的 `sampled`，两者读数同源一致、实测同刻相等，不会打架）；顺手把 REST 响应的 `time` 作为 `sourceTimestamp` 填上，消除时间戳口径不一致。
4. 诊断可见性：给 `OiSampler` 加 `lastSuccess`/连续失败计数，挂到 `/api/diagnostics`（参照 Binance `feedManager.openInterest` 的做法），连续失败时记日志。

### 方案 B：浏览器直连模式（可选，第二阶段）

1. `src/shared/venues.ts` 的 `BybitBook.open()` 增加 `tickers.<symbol>` 订阅；`onMessage` 增加 tickers 分支（snapshot 初始化、delta 变化更新），通过新回调（参照 `emitLiquidation` 的既有模式）把 `{t, base, quote}` 交给引擎。
2. `src/shared/engine.ts`：WS 读数直接更新 `#oiLive`（保持 `OI_KEEP_MS` 裁剪）；`#pollOi` 的 60 s REST 保留为兜底与 IndexedDB 持久化。
3. 页面 hub 的 20 s 时钟不需要改，自动受益。

### 其他小修

- 统一时间戳口径：Bybit 的 REST/WS 路径都带上交易所时间。
- 带宽：实测 tickers 约 7.6 条/秒/符号、delta 很小；单符号增量可忽略（当前 orderbook 流的带宽远大于此）。

### 风险提示

- tickers 的 OI 只在变化时推送，长时间无变化时显示最后值（与现状一致）。
- 不要用 delta 缺省字段覆盖已有值（delta 只含变化字段）。
- 历史写入务必限流（见方案 A 第 2 条），否则 224 MiB 历史库预算下的行数增长约 6 倍。

## 6. 诊断脚本与运行环境

- 诊断脚本：`oi-latency-probe.mjs`（项目根目录，**临时脚本，未动任何业务代码**，确认后即可删除）。
  - 用法：`node oi-latency-probe.mjs BTCUSDT 300`（符号、秒数可选；环境变量 `PROBE_SECONDS`/`REST_FAST_MS` 可覆盖）。
  - 只依赖 Node 内置的 `fetch` 和 `WebSocket`（Node ≥ 22；本机 v24.21.0），不需要项目依赖、不需要编译。
  - 输出：控制台打印摘要 + 写 `oi-latency-probe-results.json`。
- 本次实测原始数据：`oi-latency-probe-results.json`。
- 复现前提：本机网络可直连 `api.bybit.com` 与 `stream.bybit.com`（本机可达，REST 往返约 104 ms）。
- 项目本身未启动（避免产生历史库写入）；运行环境要求 Node ≥ 22.5（`package.json` engines），依赖已安装、`build/` 产物已存在；本次会话已实测 `npm run typecheck` 通过（三个 tsconfig 项目，exit 0）——项目在本机可以构建运行。注意：本机 PowerShell 默认执行策略禁止 `.ps1` 脚本，需用 `npm.cmd` 而不是 `npm`。

## 附录：关键代码位置索引

| 内容 | 位置 |
| --- | --- |
| 服务器 Bybit/OKX/Bitget/Deribit 采样（60 s） | `src/server/v2/oi-sampler.mts`（`OI_SAMPLE_MS`、`SAMPLED_OI_VENUES`） |
| 浏览器六家采样（60 s） | `src/shared/engine.ts` `#pollOi`（`OI_SAMPLE_MS = 60_000`） |
| 各交易所 REST OI 端点与字段解析 | `src/shared/history.ts` `readOiSample`（260–293 行附近） |
| Bybit OI 历史读取（2 天 5min/8 天 1h） | `src/shared/history.ts` `fetchOiHistory` |
| 服务器 Binance OI 轮询（60 s + 诊断） | `src/server/live-feeds.mts` `pollOpenInterest` / `#scheduleOiPoll`（`oiPollMs = 60_000`） |
| Hyperliquid WS `activeAssetCtx` | `src/server/live-feeds.mts:848,1417`、`src/adapters/hyperliquid.mts` |
| Bybit WS 订阅清单（浏览器） | `src/shared/venues.ts` `BybitBook.open()`（只有 orderbook/publicTrade/allLiquidation） |
| Bybit WS 订阅清单（服务器） | `src/server/live-feeds.mts:856`（只有 `bybit-depth`） |
| `tickers.<symbol>` 死代码 | `src/adapters/bybit.mts:201`（`buildBybitSubscription`，无调用点） |
| 死代码：OI REST 解析 | `src/adapters/bybit.mts` `normalizeBybitOpenInterest`、`buildBybitRequest('openInterest')`（无调用点） |
| OI 消息进 reducer（时间戳处理） | `src/server/http.mts:1670–1687` |
| UI 20 s 刷新时钟 | `src/app/main.ts:297` |
| OI bars 聚合/合并 | `src/shared/series.ts` `aggregateOi` / `withLiveOi` |
