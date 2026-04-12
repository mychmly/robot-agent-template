# decision-loop.md

## 当前典型场景运行表

| 场景触发 | 感知输入 | 决策依据 | 执行接口 | 用户反馈 | 系统反馈 |
| --- | --- | --- | --- | --- | --- |
| 机器人完成一次公共区域巡视，看到桌面或客厅存在低风险但值得提醒的小问题 | 巡视画面、系统事件说明、主人画像、当前状态 | `identity.md`、`SOUL.md`、`boundaries.md`、`memory/` 和 `output/schema.md` | 生成一句主动提醒，并由系统侧补出 `execution=NOTIFY_USER + simulated` | 返回“我建议你先……”式提醒 | 写回 `recent-interactions.md`，并在右侧 `Runtime Snapshot / Execution Info` 中展示本轮结果 |
| 机器人完成一次巡视，判断当前环境整体正常 | 巡视画面、系统事件说明、当前状态 | `SOUL.md`、`boundaries.md`、`memory/` | 不主动打扰主人，并由系统侧补出 `execution=NO_OP` | 返回“当前无需打扰主人” | 保持持久记忆不被污染，并在右侧展示“不执行动作”的运行态 |
| 机器人完成一次巡视，但画面信息不足或出现高风险疑点 | 巡视画面、系统事件说明、边界规则 | `boundaries.md`、`SOUL.md`、`memory/` | 明确说明不确定或转人工，并由系统侧补出 `REQUEST_MORE_INFO / ASK_HUMAN_CONFIRM / ESCALATE_TO_HUMAN` | 返回“需要补充画面 / 需要人工确认” | 写回或跳过写回由当前记忆策略决定，执行信息只作为运行态展示 |
