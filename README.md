# robot-agent

## 这是什么

这是第二讲公开分发版使用的最小 `robot-agent/` 工程。

它的目标不是直接变成一个完整产品，而是帮助你们把一个“家庭公共区域低风险巡视 / 提醒型机器人 Agent”的最小闭环先跑起来，再逐步改造成自己组的机器人方案。

这个模板当前包含三层内容：

- 文档系统骨架
- 可运行的 Next.js 最小前后端
- 配置骨架

## 当前默认运行逻辑

- 默认机器人类型：家庭陪伴与日常协助机器人（可修改）
- 默认 Agent 类型：家庭公共区域巡视提醒 Agent（可修改）
- 默认任务：在家庭公共区域中主动巡视，发现低风险但值得提醒的小问题，并给出最小下一步建议
- 默认边界：不进入医疗、安全、婴幼儿照护、紧急处置等高风险判断

## 第二讲课堂最低目标

在本讲结束前，你们至少应做到：

1. 让本地网页界面成功跑起来。
2. 能输入一条系统事件说明，并上传一张图片。
3. Agent 能输出一段中文解释和一段结构化结果。
4. 系统能把关键内容写回本地 Markdown 文件系统。
5. 在默认运行逻辑基础上，开始改成你们自己机器人的场景。

## 课堂内建议先改哪些文件

请优先修改：

1. `identity.md`
2. `SOUL.md`
3. `input.md`
4. `memory/policy.md`
5. `memory/owner-profile.md`

## 当前目录说明

- `identity.md`：定义机器人与 Agent 是谁、服务谁、核心场景是什么
- `SOUL.md`：定义它何时主动提醒、何时保持克制
- `input.md`：定义如何模拟机器人主动感知
- `runtime/decision-loop.md`：定义三类标准巡视结果
- `memory/`：定义主人偏好、长期记忆与 patrol 类短期记忆；当前会话运行态默认在前端 `Runtime Snapshot` 中展示
- `app/`：提供最小前后端演示界面

## 当前执行接口说明

- 当前模板会在模型决策结果之外，由系统侧补出一个最小 `execution` 执行接口对象。
- 该对象默认属于运行态信息，不写入长期记忆主链。
- 右侧当前除 `Persistent Memory` 与 `Runtime Snapshot` 外，还新增 `Execution Info` 展示区，用于说明“本轮机器人准备如何行动”。

## 当前已知限制

- 当前版本已经接入最小 Next.js 运行骨架，但仍然是课堂原型，不是完整产品。
- 音频上传入口已保留，但课堂默认不启用音频转写。
- 当前仍通过网页上传图片和事件说明，来模拟机器人真实巡视输入。
- 课堂默认建议接入 OpenAI-compatible 的国产多模态模型。
- 当前模板默认关闭 `owner-profile.md` 自动晋升；若后续要扩展为更自动化版本，应把它设计成显式开关能力，而不是默认开启。

## 建议使用的两类输入

1. 上传一张环境图片，模拟机器人刚采集到的一帧巡视画面
2. 输入一条系统事件说明，例如：
   - `系统事件：机器人刚完成一次客厅巡视，请判断是否需要主动提醒主人。`
   - `系统事件：机器人刚经过书桌区域，请判断当前是否值得打扰主人。`

## 本地启动方式

1. 在当前目录执行 `npm install`
2. 根据 `.env.example` 生成 `.env`
3. 填入你自己的 `BASE_URL`、`API_KEY`、`MODEL`
4. 执行 `npm run dev`

启动后，默认访问：

- `http://localhost:3000`

## 给学生的克隆与启动说明

当前 GitHub 仓库的默认分支已经设置为学生分发分支，因此你们可以直接执行：

```bash
git clone https://github.com/mychmly/robot-agent-template.git
cd robot-agent-template
```

然后按以下顺序启动：

```bash
npm install
cp .env.example .env
```

接着打开 `.env`，填写你们自己的模型配置：

- `BASE_URL`
- `API_KEY`
- `MODEL`

建议默认先使用：

- `BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
- `MODEL=qwen3.6-plus`

填好后执行：

```bash
npm run dev
```

浏览器打开：

- `http://localhost:3000`

如果 `3000` 端口已经被其他程序占用，Next.js 会自动切换到其他可用端口。  
这时请以终端里实际显示的本地地址为准，例如：

- `http://localhost:3001`
- `http://localhost:3002`

如果你的本机在 `npm run dev` 时出现文件监听过多、`EMFILE`、首页返回异常等开发态问题，可以改用：

```bash
WATCHPACK_POLLING=true npm run dev
```

如果你只是想先验证“能不能跑起来”，也可以先执行：

```bash
npm run build
npm run start
```

## 建议的第一次测试方式

第一次启动成功后，建议先做最小测试，不要急着改代码：

1. 直接输入一条系统事件说明
2. 再上传一张你们自己准备的环境图片
3. 观察网页是否返回：
   - 中文解释性回复
   - 结构化结果
   - 右侧 `Execution Info`

推荐的第一条测试文本：

```text
系统事件：机器人刚完成一次客厅巡视，请判断是否需要主动提醒主人。
```

如果这一步能跑通，再开始把默认设定改成你们自己组的机器人方案。

## 课程讲义 PDF 下载

- 第一讲 PPT 预览与下载：[lesson-1.pdf](https://github.com/mychmly/robot-agent-template/releases/latest/download/lesson-1.pdf)
- 第二讲 PPT 预览与下载：[lesson-2.pdf](https://github.com/mychmly/robot-agent-template/releases/latest/download/lesson-2.pdf)
