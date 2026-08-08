---
name: bionanosemi-skill-guide
description: 指导在本仓库创建/更新 Claude Code Skills（.claude/skills/*/SKILL.md）。当用户说"创建skill/写一个skill/新增skill/做个skills/技能怎么写/skill模板/skill规范/skill触发词/allowed-tools/帮我写个skill/skill怎么创建"等，或需要为某个工作流（配置/代码生成/测试/排障）封装成 Skill 时使用。
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# Skill 创建完整指南

> 本 Skill 帮助你在 BionanoSemi 项目中创建高质量的 Claude Code Skills

## 核心概念（30秒理解）

```
Skills = 让 Claude 自动识别任务并应用专业知识的能力模块

用户请求 → Claude 分析语义 → 匹配 description → 自动激活 Skill → 执行指令
```

**关键点**：
- `description` 是最重要的字段，决定 Skill 何时被激活
- Skills 由 Claude **自动调用**，不需要用户输入 `/命令`
- 一个好的 description = 功能动词 + 具体对象 + 触发关键词 + 使用场景

---

## 创建流程（必须严格遵循）

### 第零步：激活女娲角色（可选，推荐）

**可选条件**：如果你的环境中配置了 MCP PromptX 工具，推荐先激活女娲角色来辅助创建。

**执行方式**：
```
使用 mcp__promptx__action 工具激活女娲角色：
{
  "role": "nuwa"
}
```

**为什么推荐女娲**：
- 女娲是 AI 角色创造专家，专门负责创建高质量的 Skill
- 她能提供专业的 description 设计建议
- 确保 Skill 符合 PromptX 规范和最佳实践
- 帮助设计更准确的触发词和使用场景

**如果没有 MCP PromptX**：
- 可以直接跳过此步骤
- 按照后续的第一步到第四步正常创建 Skill
- 仍然可以创建高质量的 Skill，只需要更仔细地设计 description

**激活后**：
- 女娲会进入工作状态,提供专业的 Skill 创建指导
- 后续步骤由女娲协助完成，确保质量

---

### 第一步：需求澄清（ISSUE 四问）

在创建任何 Skill 前，必须问清楚以下 4 件事（不清楚就用 AskUserQuestion 询问 master）：

| 问题 | 说明 | 示例 |
|------|------|------|
| **解决什么问题？** | 输入是什么？输出是什么？ | 输入：Conf.json 路径；输出：验证报告 |
| **触发方式？** | 用户会怎么说？涉及哪些文件？ | "检查配置"、"验证 Conf.json"、*.json |
| **约束条件？** | 只读还是要改文件？是否允许跑脚本？ | 只读验证，不修改文件 |
| **验收标准？** | 做到什么程度算完成？ | 输出 ✅/❌ 报告，提供修复建议 |

### 第二步：设计 description（最关键！）

**编写公式**：
```
description = 功能动词 + 具体对象 + 触发关键词 + 使用场景
```

**BionanoSemi 项目关键词参考**：

| 类别 | 关键词 |
|------|--------|
| 配置文件 | Conf.json, conf-io.xml, IoKey, BussinesComponents, Mode |
| 模块类型 | TM, PM, CAR, AS, CRU, LTHP, LoadPort |
| 组件类型 | BRobot, Aligner, Chuck, Spindle, Pin, Vacuum, Axis |
| 技术栈 | .NET 4.8, WPF, MVVM, Prism, RabbitMQ, MongoDB, gRPC |
| 工具 | ProcessManager, TestDrive, AlarmGen, RecipeMigration |
| 路径特征 | WorkSpaceTB/Modules/, Core/, Drive/, Server/ |

**示例对比**：

```yaml
# ❌ 差的 description（太模糊）
description: 处理配置文件

# ✅ 好的 description（具体明确）
description: 验证 BionanoSemi 模块配置文件（Conf.json、conf-io.xml）的格式和 IoKey 映射正确性。当用户需要检查配置、验证模块设置、排查 IoKey 不匹配问题时使用。
```

### 第三步：编写 SKILL.md

**文件结构**：

```yaml
---
name: my-skill-name          # 小写+连字符，最多64字符
description: ...             # 最重要！决定何时激活，最多1024字符
allowed-tools: Read, Glob    # 可选，限制工具权限
---

# Skill 标题

## 指令
[详细的执行步骤]

## 示例
[具体使用场景]
```

### 第四步：创建文件

**目录结构**（完整版）：

```
.claude/skills/<skill-name>/
├── SKILL.md                    # 必需：主 skill 定义
├── REFERENCE.md                # 可选：详细 API 文档
├── EXAMPLES.md                 # 可选：更多使用示例
├── CHANGELOG.md                # 可选：版本历史
├── scripts/
│   ├── helper.py               # 可选：Python 辅助脚本
│   ├── validator.py            # 可选：验证脚本
│   └── setup.sh                # 可选：环境设置脚本
├── templates/
│   ├── config_template.json    # 可选：配置模板
│   └── code_template.cs        # 可选：代码模板
└── docs/
    ├── architecture.md         # 可选：架构说明
    └── troubleshooting.md      # 可选：故障排除
```

**简化版**（适合大多数场景）：

```
.claude/skills/<skill-name>/
├── SKILL.md                    # 必需：主 skill 定义
└── templates/                  # 可选：如需模板
    └── xxx_template.json
```

**路径规范**：
- ✅ 使用正斜杠：`templates/config.json`
- ❌ 不用反斜杠：`templates\config.json`（即使在 Windows）

---

## SKILL.md 模板

### 模板 1：只读分析型 Skill

```yaml
---
name: bionanosemi-xxx-analyzer
description: 分析 BionanoSemi 的 [具体对象]。当用户需要 [动作1]、[动作2]、[动作3] 时使用。处理 [文件类型] 文件。
allowed-tools: Read, Glob, Grep
---

# [Skill 名称]

## 概述
简要说明此 Skill 的用途（1-2句话）

## 指令

### 1. 定位文件
使用 Glob 查找目标文件：
- `WorkSpaceTB/Modules/*/Conf/[文件名]`

### 2. 读取分析
使用 Read 读取文件内容，分析 [具体内容]

### 3. 输出报告
以清晰格式报告：
- ✅ 正常项
- ❌ 问题项
- 💡 建议

## 示例

**用户**："[典型请求]"
**Claude**：[执行流程说明]
```

### 模板 2：配置生成型 Skill

```yaml
---
name: bionanosemi-xxx-generator
description: 为 BionanoSemi 生成 [具体对象]。当用户需要创建 [对象1]、添加 [对象2]、初始化 [对象3] 时使用。
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion
---

# [Skill 名称]

## 概述
简要说明此 Skill 的用途

## 指令

### 1. 收集信息
使用 AskUserQuestion 询问必要参数：
- 参数1：[说明]
- 参数2：[说明]

### 2. 读取模板/参考
从 `templates/xxx_template.json` 读取模板
或从现有模块复制配置作为参考

### 3. 生成配置
根据用户输入生成配置内容

### 4. 验证并保存
验证生成的配置格式正确后保存

## 示例

**用户**："[典型请求]"
**Claude**：[执行流程说明]
```

### 模板 3：命令执行型 Skill

```yaml
---
name: bionanosemi-xxx-runner
description: 执行 BionanoSemi 的 [具体操作]。当用户需要运行 [操作1]、启动 [操作2]、测试 [操作3] 时使用。
allowed-tools: Read, Bash, Glob
---

# [Skill 名称]

## 概述
简要说明此 Skill 的用途

## 指令

### 1. 检查前置条件
确认必要的服务/文件已就绪

### 2. 执行命令
使用 Bash 执行相关命令

### 3. 检查结果
验证执行结果，报告成功/失败

## 示例

**用户**："[典型请求]"
**Claude**：[执行流程说明]
```

---

## allowed-tools 权限指南

| 场景 | 推荐配置 | 说明 |
|------|----------|------|
| 只读分析 | `Read, Glob, Grep` | 最安全，无修改风险 |
| 配置修改 | `Read, Write, Edit, Glob` | 可读写文件 |
| 需要交互 | 加上 `AskUserQuestion` | 可询问用户 |
| 需要执行命令 | 加上 `Bash` | 可运行 shell 命令 |
| 不限制 | 不写此字段 | 使用所有工具 |

**最小权限原则**：只给必需的权限，能只读就只读。

---

## BionanoSemi 专用 Skill 示例

### 示例 1：模块配置验证器

```yaml
---
name: bionanosemi-config-validator
description: 验证 BionanoSemi 模块配置文件（Conf.json、conf-io.xml）的格式、必需字段和 IoKey 映射正确性。当用户需要检查配置、验证模块设置、排查配置错误、添加新模块前检查时使用。
allowed-tools: Read, Glob, Grep
---

# BionanoSemi 配置验证器

## 指令

### 1. 定位配置文件
```bash
WorkSpaceTB/Modules/{ModuleName}/Conf/Conf.json
WorkSpaceTB/Modules/{ModuleName}/Conf/conf-io.xml
```

### 2. 验证 Conf.json
检查必需字段：
- [ ] Name（模块名，唯一）
- [ ] Type（TM/PM/CAR/AS 等）
- [ ] Mode（SIM/Normal/Test/Disable）
- [ ] BussinesComponents（组件数组）

检查 Mode 值是否合法：
- ✅ SIM, Normal, Test, Disable
- ❌ Simulation, Enable, Run（常见错误）

### 3. 验证 IoKey 映射
检查 Conf.json 中的 IoKey 是否在 conf-io.xml 中有对应定义

### 4. 输出报告
```
✅ Conf.json 格式正确
✅ 必需字段完整
❌ IoKey "R1.NewSensor" 在 conf-io.xml 中未定义
💡 建议：在 conf-io.xml 中添加 ITEM 定义
```

## 示例

**用户**："帮我检查 R1 模块的配置"
**Claude**：
1. 读取 WorkSpaceTB/Modules/R1/Conf/Conf.json
2. 读取 WorkSpaceTB/Modules/R1/Conf/conf-io.xml
3. 逐项验证并报告结果
```

### 示例 2：机器人指令映射器

```yaml
---
name: bionanosemi-robot-mapper
description: 管理 BionanoSemi 机器人模块的指令映射文件（_Instructions_map.json）。当用户需要配置机器人站位、修改 Station/Slot 参数、创建新的站位映射、调试机器人抓取动作时使用。
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion
---

# 机器人指令映射器

## 指令

### 1. 定位映射文件
```bash
WorkSpaceTB/Modules/{RobotName}/Conf/{RobotName}_Instructions_map.json
```

### 2. 映射格式说明
```json
{
  "1": {                    // 站位号（工艺配方中使用）
    "GET_F1": [1, 2],       // 手指1抓取：[Station, Slot]
    "PUT_F1": [1, 2],       // 手指1放置
    "GET_F2": [3, 4],       // 手指2抓取
    "PUT_F2": [3, 4]        // 手指2放置
  }
}
```

### 3. 创建/修改映射
根据用户需求创建或修改站位映射

### 4. 验证
- JSON 格式正确
- 每个站位有 GET 和 PUT
- 参数值在合理范围

## 示例

**用户**："把 R1 的站位 3 改成 Station 100, Slot 1"
**Claude**：
1. 读取 R1_Instructions_map.json
2. 修改站位 "3" 的参数
3. 保存并确认
```

---

## 验证清单

创建 Skill 后，逐项检查：

### 文件结构
- [ ] 目录在 `.claude/skills/<skill-name>/`
- [ ] 文件名是 `SKILL.md`（大写）
- [ ] 路径使用正斜杠

### YAML 元数据
- [ ] 有开头和结尾的 `---`
- [ ] `name` 仅小写字母+数字+连字符
- [ ] `name` 不超过 64 字符
- [ ] `description` 包含功能动词
- [ ] `description` 包含触发关键词
- [ ] `description` 说明使用场景
- [ ] `description` 不超过 1024 字符

### 正文内容
- [ ] 有清晰的指令步骤
- [ ] 有具体的使用示例
- [ ] 指令可操作、不模糊

### 测试验证
- [ ] 重启 Claude Code 后 Skill 出现在列表中
- [ ] 使用触发词能成功激活
- [ ] 执行结果符合预期

---

## 常见错误

### 错误 1：YAML 语法错误
```yaml
# ❌ 缺少 --- 分隔符
name: my-skill

# ✅ 正确
---
name: my-skill
description: ...
---
```

### 错误 2：name 格式错误
```yaml
# ❌ 错误
name: My Skill          # 有空格和大写
name: my_skill          # 有下划线

# ✅ 正确
name: my-skill
```

### 错误 3：description 太模糊
```yaml
# ❌ 模糊
description: 处理文件

# ✅ 具体
description: 验证 JSON 配置文件格式。当用户需要检查 Conf.json、验证配置时使用。
```

### 错误 4：路径使用反斜杠
```markdown
# ❌ 错误（Windows 风格）
参见 [模板](templates\config.json)

# ✅ 正确（Unix 风格）
参见 [模板](templates/config.json)
```

---

## 参考资源

### 项目内参考
- 完整创建指南：`Claude_Code_Skills.md`
- 开发专家 Skill：`.claude/skills/bionanosemi-dev/SKILL.md`
- 测试 Skill：`.claude/skills/hello-skill/SKILL.md`
- Unit 配置 Skill：`.claude/skills/bionanosemi-unit-config/SKILL.md`

### 关键路径
- 模块配置：`WorkSpaceTB/Modules/*/Conf/`
- 核心代码：`Core/`
- 驱动代码：`Drive/`
- 服务端代码：`Server/`

---

## 快速开始

**最快创建一个 Skill 的步骤**：

0. （可选）如果有 MCP PromptX，可以先激活女娲角色（`mcp__promptx__action` 工具，role: "nuwa"）
1. 告诉我你想创建什么 Skill
2. 我会用 ISSUE 四问确认需求
3. 帮你设计 description
4. 生成完整的 SKILL.md
5. 创建文件并测试

**示例请求**：
- "帮我创建一个验证 Alarm 配置的 Skill"
- "我想做一个自动生成 Unit 配置的 Skill"
- "创建一个检查 Recipe 格式的 Skill"

---

*最后更新：2025-01-22*
