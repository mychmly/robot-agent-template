# context-routing.md

## 文档用途

本文件用于定义当前模板 `robot-agent/` 在运行时的**显性上下文路由机制**。

它回答的是：

- 本轮请求属于哪一类
- 本轮必须披露哪些文件
- 本轮可以跳过哪些文件
- 本轮若需要历史，只允许带入多少

本文件的目标不是让模型自己“猜”该看什么，而是先由系统根据显性规则完成一轮可解释的上下文选择。

## 当前执行原则

1. 默认仍由模型生成回复；但对低歧义、低风险、已收敛为本地信号的显式工具路由，允许直接本地直出。
2. 不再默认把全部 Markdown 文件系统一次性注入模型。
3. 先路由，再披露。
4. 先文件级，再章节级。
5. 历史上下文默认最严格控制。
6. `current-state.md` 与 `latest-response.md` 不再作为高频持久化文件参与当前模板主链。

## 当前路由配置（供系统读取）

<!-- ROUTING_CONFIG_START -->
```json
{
  "core": [
    {
      "path": "identity.md"
    },
    {
      "path": "SOUL.md"
    },
    {
      "path": "boundaries.md",
      "sections": [
        "不能替用户做的决定",
        "高风险场景",
        "人工介入条件",
        "降级与反馈策略"
      ]
    },
    {
      "path": "output/schema.md"
    }
  ],
  "routes": [
    {
      "name": "tool_time_now",
      "description": "用户显式查询当前时间",
      "priority": 96,
      "toolName": "time_now",
      "signalKey": "time_now",
      "responseMode": "local_direct",
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "questionLike": true,
        "startsWithNone": [
          "系统事件"
        ],
        "keywordsAny": [
          "现在几点",
          "几点",
          "时间",
          "日期",
          "今天几号",
          "星期几"
        ]
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "文本输入如何使用"
          ]
        },
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前第一批基础外部工具"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 180
      }
    },
    {
      "name": "tool_current_location",
      "description": "用户显式查询机器人当前位置",
      "priority": 95,
      "toolName": "current_location",
      "signalKey": "current_location",
      "responseMode": "local_direct",
      "match": {
        "hasAudio": false,
        "questionLike": true,
        "startsWithNone": [
          "系统事件"
        ],
        "keywordsAny": [
          "你在哪",
          "你在哪里",
          "现在在哪",
          "当前位置",
          "哪个区域",
          "哪个房间"
        ]
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "文本输入如何使用",
            "图片输入如何使用"
          ]
        },
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前第一批基础外部工具"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 220
      }
    },
    {
      "name": "tool_weather_lookup",
      "description": "用户显式查询天气",
      "priority": 94,
      "toolName": "weather_lookup",
      "signalKey": "weather_lookup",
      "responseMode": "local_direct",
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "questionLike": true,
        "startsWithNone": [
          "系统事件"
        ],
        "keywordsAny": [
          "天气",
          "气温",
          "温度",
          "下雨",
          "降雨",
          "空气质量"
        ]
      },
      "include": [
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前第一批基础外部工具"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 220
      }
    },
    {
      "name": "tool_home_environment_status",
      "description": "用户显式查询家庭环境状态",
      "priority": 93,
      "toolName": "home_environment_status",
      "signalKey": "home_environment_status",
      "responseMode": "local_direct",
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "questionLike": true,
        "startsWithNone": [
          "系统事件"
        ],
        "keywordsAny": [
          "环境状态",
          "家里状态",
          "客厅状态",
          "窗户",
          "门",
          "灯",
          "空调",
          "湿度"
        ]
      },
      "include": [
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前第一批基础外部工具"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 240
      }
    },
    {
      "name": "tool_web_search",
      "description": "用户显式提出常识性或实时信息问题",
      "priority": 92,
      "toolName": "web_search",
      "responseMode": "model",
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "questionLike": true,
        "startsWithNone": [
          "系统事件"
        ],
        "keywordsNone": [
          "现在几点",
          "几点",
          "时间",
          "日期",
          "今天几号",
          "星期几",
          "天气",
          "气温",
          "温度",
          "下雨",
          "你在哪",
          "你在哪里",
          "现在在哪",
          "当前位置",
          "哪个区域",
          "哪个房间",
          "环境状态",
          "家里状态",
          "客厅状态",
          "窗户",
          "门",
          "灯",
          "空调",
          "湿度"
        ]
      },
      "include": [
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前第一批基础外部工具"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 260
      }
    },
    {
      "name": "audio_unavailable",
      "description": "音频输入但当前能力未启用",
      "priority": 100,
      "warning": "当前检测到音频输入，但课堂默认未启用音频能力。",
      "match": {
        "hasAudio": true,
        "audioEnabled": false
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "音频输入当前状态",
            "当前课堂模拟说明"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false
      }
    },
    {
      "name": "profile_capture",
      "description": "用户显式要求系统记住长期偏好或背景信息",
      "priority": 99,
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "startsWithAny": [
          "请记住",
          "记住",
          "帮我记住",
          "你要记住"
        ]
      },
      "include": [
        {
          "path": "memory/policy.md",
          "sections": [
            "哪些信息可沉淀为长期记忆",
            "哪些信息不应写入记忆"
          ]
        },
        {
          "path": "memory/owner-profile.md",
          "sections": [
            "已知背景信息",
            "已知偏好",
            "当前仍待确认的信息"
          ]
        },
        {
          "path": "memory/long-term-memory.md",
          "sections": [
            "长期偏好",
            "持续有效的事实",
            "最近新增候选（待人工检查）"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 180,
        "temperature": 0.1
      }
    },
    {
      "name": "profile_statement_unconfirmed",
      "description": "用户表达个人偏好，但未显式授权写入长期记忆",
      "priority": 98,
      "responseMode": "local_direct",
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "startsWithAny": [
          "我喜欢",
          "我很喜欢",
          "我不喜欢",
          "我很不喜欢",
          "我希望",
          "我不希望",
          "我更喜欢",
          "我更在意"
        ]
      },
      "include": [
        {
          "path": "memory/policy.md",
          "sections": [
            "哪些信息可沉淀为长期记忆",
            "哪些信息不应写入记忆"
          ]
        }
      ]
    },
    {
      "name": "follow_up",
      "description": "连续追问 / 解释上一轮",
      "priority": 99,
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "followUp": true,
        "keywordsAny": [
          "继续",
          "刚才",
          "上一轮",
          "上次",
          "为什么",
          "再解释",
          "那个判断",
          "还是这个场景",
          "如果是"
        ]
      },
      "include": [
        {
          "path": "runtime/decision-loop.md"
        },
        {
          "path": "memory/owner-profile.md",
          "sections": [
            "已知偏好",
            "当前仍待确认的信息"
          ]
        },
        {
          "path": "memory/recent-interactions.md",
          "recentTurns": 2
        },
        {
          "path": "memory/long-term-memory.md",
          "sections": [
            "长期偏好",
            "持续有效的事实"
          ]
        }
      ]
    },
    {
      "name": "multimodal_patrol",
      "description": "图文联合巡视判断",
      "priority": 80,
      "match": {
        "hasImages": true,
        "hasAudio": false
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "文本输入如何使用",
            "图片输入如何使用",
            "当前课堂模拟说明"
          ]
        },
        {
          "path": "runtime/decision-loop.md"
        },
        {
          "path": "memory/owner-profile.md",
          "sections": [
            "基本身份",
            "已知背景信息",
            "已知偏好"
          ]
        },
        {
          "path": "memory/long-term-memory.md",
          "sections": [
            "长期偏好",
            "持续有效的事实"
          ]
        },
        {
          "path": "knowledge-and-tools.md",
          "sections": [
            "当前最关键的知识来源",
            "当前最关键的工具能力"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 260
      }
    },
    {
      "name": "greeting_status",
      "description": "基础问候 / 状态试探",
      "priority": 98,
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "keywordsAny": [
          "你好",
          "您好",
          "在吗",
          "在么",
          "你是谁",
          "你能做什么",
          "现在是什么状态",
          "当前状态",
          "自检"
        ]
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "文本输入如何使用",
            "当前课堂模拟说明"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false
      }
    },
    {
      "name": "text_patrol",
      "description": "文本型巡视判断",
      "priority": 10,
      "match": {
        "hasImages": false,
        "hasAudio": false,
        "default": true
      },
      "include": [
        {
          "path": "input.md",
          "sections": [
            "文本输入如何使用",
            "当前课堂模拟说明"
          ]
        },
        {
          "path": "runtime/decision-loop.md"
        },
        {
          "path": "memory/owner-profile.md",
          "sections": [
            "基本身份",
            "已知偏好"
          ]
        },
        {
          "path": "memory/long-term-memory.md",
          "sections": [
            "长期偏好",
            "持续有效的事实"
          ]
        }
      ],
      "modelOptions": {
        "enableThinking": false,
        "maxTokens": 240,
        "temperature": 0.1
      }
    }
  ]
}
```
<!-- ROUTING_CONFIG_END -->

## 当前提醒

- 若后续修改路由规则，应同时保持本文件的可读性和可解析性。
- 如果新增更多路由类别，优先新增明确、低歧义的类别，不要把规则写成冗长自然语言段落。
- 若后续进入章节级更细抽取，应优先复用现有 `##` / `###` 标题结构，而不是另外发明一套并行结构。
