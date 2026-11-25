---
name: ashare-news-triage
description: "对 A 股新闻候选集做价值分级与影响路径标注（规则召回后的智能体精排层）；只输出标注 JSON，不改事实、不入日历、不给买卖建议。"
version: 1.0.0
metadata:
  hermes:
    tags: [a-share, news, triage, materiality, grounded, deepseek]
    related_skills: [market-modules, rss-feeds, competitor-news-monitor, grounded-citations]
---

# A 股新闻价值分级（ashare-news-triage）

## 定位：第二层，不是第一层

系统已经有一层**确定性规则召回**（`sources.js` 政策关键词权重 → `news-pulse.js` 政策快讯 →
`future-events.js` 时间抽取 + 影响词入历）。规则层高召回、可追溯、零幻觉，但不懂语义，
会把「已发生的旧闻」「境外体育/地缘杂闻」「同一事件的多家转载」「标题带关键词但正文无关」
一起排到前面。

**本技能只做第二层精排**：对规则层已经召回的候选新闻做「是否真的对 A 股有价值」的判断，
输出标注 JSON。它**不替代**规则层、**不抓取新闻**、**不写入日历**、**不改任何评分**。

方法论沿用 `competitor-news-monitor` 的四条：materiality（重大性）、source hierarchy（来源分级）、
event deduplication（事件去重）、cited digest（带出处摘要）；引用纪律沿用 `grounded-citations`。

## 何时使用

- 用户问「今天哪些新闻真正值得看」「帮我筛掉没价值的新闻」「这条政策是不是真利好/只是标题党」
- 用户要求解释「为什么某条新闻被排到前面」「XX 新闻跟 A 股到底有没有关系」
- 前端「政策快讯 → 智能体筛选」按钮生成候选集之后，需要对候选集做精排

不要用于：读行情/选股快照（用 `market-modules`）、抓新源（用 `rss-feeds`）、
查事件历史统计（用 `market-modules` 的 `event-study.json`）。

## 数据位置

候选集（Node 后端每小时自动重建，也可由页面「智能体筛选」按钮触发）：

- Windows：`D:\WorkBuddy\projects\GlobalMarketMonitor\data\agent-perception\news-candidates.json`
- WSL：`/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/news-candidates.json`

结果写回（**唯一允许写入的文件**）：

- Windows：`D:\WorkBuddy\projects\GlobalMarketMonitor\data\agent-perception\news-triage.json`
- WSL：`/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/news-triage.json`

先读 `manifest`-式字段：`generatedAt`、`recall.scannedTotal`、`recall.returned`、
`candidates[]`、`sectorBias[]`。候选超过 24 小时要说明「候选集可能过期」。

## 使用步骤

1. **只读候选集**：`cat .../news-candidates.json`。不要去别的目录找新闻，不要自己联网补新闻。
2. **逐条判断**（只用 `candidates[].title / rawTitle / desc / source / time / rule` 里的原文信息）：
   - `high`：对 A 股有直接、可说明的影响路径（监管/货币/资金面/产业政策/重要宏观数据/龙头业绩），
     且是**新发生的、尚未被市场充分消化**的事件；原文能支撑该判断。
   - `medium`：有间接或板块级关联，或影响路径需要额外假设才能成立；或是重要事件但已发生多时。
   - `low`：仅标题命中关键词、正文无关，或属海外/地区市场但与 A 股传导链条很弱，或为一般性评论。
   - `noise`：重复转载、同一事件的多条、纯体育/娱乐/社会杂闻、旧闻回放、广告。
3. **事件去重**：同一事件（同日期 + 同主体 + 同动作）只保留信息量最大的一条为 high/medium，
   其余标 `noise` 并在 `reason` 里写「与 key=XXX 为同一事件」。
4. **写回 JSON**（结构必须严格如下，否则前端会整份丢弃）：

```json
{
  "generatedAt": "YYYY-MM-DD HH:mm:ss",
  "model": "hermes/deepseek",
  "candidateSetAt": "<原样复制 candidates.generatedAt>",
  "items": [
    {
      "key": "<必须原样复制 candidates[].key，禁止自造>",
      "tier": "high|medium|low|noise",
      "reason": "一句话说明价值判断依据，必须能在该条原文里找到依据",
      "sectors": ["券商"],
      "citedTitle": "<原样复制该条 title>"
    }
  ]
}
```

`items` 应覆盖**全部候选**（含 low / noise），便于前端核对没有漏项。

5. 回答用户时，按 `high → medium` 顺序给出摘要，每条带出处（来源 + 时点 + 原文标题），
   并明确区分三层：**事实（原文写了什么）/ 规则（policyImportance 多少、命中哪些词）/ 判断（我认为价值如何）**。

## 硬性纪律（低幻觉要求）

- **禁止新增新闻**：`items[].key` 只能来自候选集；不得编造标题、公司名、数字、日期、政策内容。
- **禁止改写事实**：不得修改候选集文件、`news-pulse.json`、日历事件、选股结果、任何评分。
- **禁止自动入历**：即使判断为高价值，也**不要**调用日历写入；入历由 `future-events.js` 规则层负责。
- **禁止买卖建议**：不得出现买入/卖出/加仓/减仓/抄底/止盈/止损/目标价/点位预测。
- **不确定就直说**：原文信息不足时标 `low` 并写「原文信息不足，无法判断影响路径」，不要脑补。
- `rule.score` 是规则召回分，**不是**你的价值结论；你的结论放在 `tier` 与 `reason`，并说明二者可能不一致。
- 若候选集缺失或为空，直说「暂无候选新闻」，不要生成任何示例数据。

## 与既有技能的关系

| 技能 | 关系 |
|---|---|
| `market-modules` | 同级：读行情/日程/选股快照；本技能只读新闻候选集 |
| `competitor-news-monitor` | 方法论来源（重大性 / 来源分级 / 去重 / 带出处摘要），但面向公司竞品，不直接套用 |
| `grounded-citations` | 引用纪律来源：每条判断都要能回溯到候选新闻原文 |
| `rss-feeds` / `blogwatcher` | 只负责读源，本项目的新闻抓取由 Node 后端完成，不需要它们 |

## 维护

Node 后端 `POST /api/v2/news-triage/refresh` 重建候选集；
每小时 `runNewsPulse()` 也会自动重建。前端 `GET /api/v2/news-triage` 读取本技能写回的分级结果。
本技能只写 `news-triage.json` 一个文件。
