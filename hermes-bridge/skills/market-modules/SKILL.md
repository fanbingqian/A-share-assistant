---
name: market-modules
description: "按需读取全球市场监测系统的模块快照（日程事件、每日行情、三类选股、事件历史统计、知识库、预测账本），避免把全部数据塞进提示词。"
version: 1.0.0
metadata:
  hermes:
    tags: [a-share, market, modules, perception, snapshots]
    related_skills: []
---

# Market Modules — 模块感知技能

## 何时使用

当用户问题涉及以下内容时使用本技能：

- 今日/近期行情、量能、板块涨跌、涨停情绪
- 日程事件、事件影响、历史同类事件表现
- 三类选股（热度独立行情 / 趋势股 / 强势反弹股）的结构与统计
- 个人知识库、预测账本命中情况
- 任何“当前系统里有什么数据”的提问

## 数据位置

快照目录（Windows 路径）：

`D:\WorkBuddy\projects\GlobalMarketMonitor\data\agent-perception\`

WSL 内路径（Hermes 所在环境）：

`/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/`

文件清单：

| 文件 | 内容 |
|---|---|
| `manifest.json` | 生成时间、文件清单、路径说明 |
| `market.json` | 两市量价、指数涨跌、宽度情绪 |
| `sectors.json` | 行业/概念强弱、领涨与持续强势 |
| `picks.json` | 三类选股的结构化结果与候选池规模 |
| `calendar.json` | 未来 60 天事件、7 天提醒 |
| `event-study.json` | 近 2 年事件 × ETF 代理的 T+1/T+3/T+5 超额与胜率 |
| `knowledge.json` | 笔记/消息/图谱节点统计 |
| `predictions.json` | 方向预测账本汇总 |

## 使用方式

1. 先用终端工具读取需要的 JSON，例如：

   ```bash
   cat /mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/manifest.json
   cat /mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/market.json
   ```

2. 只读取与问题相关的文件，不要一次读完所有文件。
3. 检查 `generatedAt`：超过 24 小时的快照要明确说明“数据可能过期”。
4. `event-study.json` 的 `stats.samples < 8` 时必须说明“低样本，不可外推”。
5. 板块统计用可交易 ETF 作代理，必须说明“代理近似口径”；美元/美债/仅月份事件没有 A 股代理样本。
6. 回答时区分三层：**事实（快照数字）/ 程序计算（超额、胜率）/ 推测（影响判断）**。
7. 不得给买入、卖出、加仓、减仓、清仓、抄底、止盈、止损、满仓等买卖建议，不预测点位。
8. 快照缺失或字段为空时直说“无数据”，不得编造数字或公司事件。

## 典型问答映射

- “今天市场怎么样” → `market.json` + `sectors.json`
- “医保目录事件历史怎么走” → `calendar.json` 找 ruleId → `event-study.json` 找同 ruleId 的 stats
- “三类选股现在是什么结构” → `picks.json`
- “我知识库里有什么” → `knowledge.json`；需要具体节点再通过系统接口查询
- “预测准不准” → `predictions.json`，并说明命中率样本数

## 维护

Node 后端通过 `POST /api/v2/agent/perception/refresh` 重新生成快照；每日定时任务也会自动刷新。
本技能只负责读取与解释，不修改任何数据文件。
