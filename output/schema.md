# schema.md

## 文档用途

本文件用于规定结构化输出格式长什么样。

它不存具体结果，只定义输出结构。

## 当前最低输出字段

- `intent`：当前巡视事件的核心判断目标是什么
- `decision`：系统判断是否需要主动提醒主人
- `action`：系统建议的动作、提醒内容，或“保持安静并只更新状态”
- `reason`：系统为何做出这一判断
- `memory_update`：如果本轮有适合进入长期记忆的稳定信息，就用一句话写清；如果没有，请写“无新增长期记忆”

## 当前系统侧附加执行字段（由系统生成，不要求模型直接输出）

- `execution.action_type`：当前属于哪一类机器人动作接口
- `execution.execution_mode`：当前是模拟执行、人工代演，还是预留给假工具执行
- `execution.instruction`：当前动作要如何被执行或展示
- `execution.requires_confirmation`：当前动作是否必须先由人确认
- `execution.risk_level`：当前动作的风险等级

说明：

- `action` 继续保留为面向人类可读的动作摘要
- `execution` 由系统在模型决策完成后生成，用于把决策结果转成更接近机器人语义的执行接口
- `execution` 默认属于运行态信息，不直接等同于长期记忆

## 当前写法提醒

- 中文解释性回复应和结构化结果同时存在
- 字段命名尽量稳定，避免每次输出结构都变化
- `memory_update` 不应用来记录临时状态或测试说明
- 当系统判断“当前无需打扰”时，也必须把这一结论清楚写进 `decision` 和 `action`

## 当前运行时附加字段（由系统侧补充，不要求模型写入）

以下字段用于前端展示工具调用信息，不属于模型必须返回的 JSON 主结构：

- `tool_used`
- `tool_status`
- `tool_summary`
- `tool_source_count`

若命中 `web_search`，前端还可单独显示：

- 来源标题
- 来源 URL
