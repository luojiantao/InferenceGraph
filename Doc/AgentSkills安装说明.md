# Agent Skills 安装说明

本仓库在 `AgentSkills/` 提供独立的 Agent Skills 分发包，供复制给其他
项目或其他兼容 Agent 使用。该目录不是 Pi、Codex 或 Claude 的配置目录，
不会被当前仓库中的 Agent 自动发现或加载。

每个技能保留自己的目录，并以 `SKILL.md` 作为入口文件。安装时必须保留
该层级，不能把多个 `SKILL.md` 扁平化到同一目录。

原始副本来自当前开发机的 `C:\Users\Jon\.pi\agent\skills`。该路径只用于
维护时同步；分发包的运行不依赖该用户目录。

## 内容

```text
AgentSkills/
  herdr/
    SKILL.md
  inference-graph-backward-expansion/
    SKILL.md
  inference-graph-parallel-backward-expansion/
    SKILL.md
  inference-graph-sequential-subagent-expansion/
    SKILL.md
```

| 技能                                            | 用途                                                  | 主要前提                                    |
| ----------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `herdr`                                         | 在用户明确要求时控制 Herdr 终端多路复用会话           | `HERDR_ENV=1`                               |
| `inference-graph-backward-expansion`            | 对一个 Goal 或 State 创建单步或受限递归的反向候选前提 | 可用的 InferenceGraph MCP 工具              |
| `inference-graph-parallel-backward-expansion`   | 协调只读 Worker 并行规划，再串行写入候选前提          | InferenceGraph MCP 和全局 `worker` subagent |
| `inference-graph-sequential-subagent-expansion` | 以 fresh Worker 串行执行逐节点单步反向展开            | InferenceGraph MCP 和全局 `worker` subagent |

三个 InferenceGraph 展开技能均配置为仅显式调用。它们创建的是 `Candidate`
结构，不会在未获额外授权时领取、取证、完成、释放、阻塞或结束推理边/会话。

## 安装到 Pi 项目

在目标项目的根目录创建 Pi 会扫描的 `.agents/skills/` 或 `.pi/skills/`
目录，然后将本分发包中的四个子目录复制进去。以下命令中的 `<...>` 要替换
为实际路径。

PowerShell：

```powershell
$source = '<包含本仓库的路径>\AgentSkills'
$target = '<目标项目路径>\.agents\skills'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $source '*') -Destination $target
```

Bash：

```bash
source_dir='/path/to/InferenceGraph/AgentSkills'
target_dir='/path/to/target-project/.agents/skills'
mkdir -p "$target_dir"
cp -R "$source_dir"/. "$target_dir"/
```

Pi 在项目被信任后会扫描上述目录。复制完成后重新打开 Pi 会话，再显式调用
需要的展开技能，例如：

```text
/skill:inference-graph-backward-expansion sessionId=<sessionId> vertexId=<vertexId> agentId=<agentId>
/skill:inference-graph-parallel-backward-expansion sessionId=<sessionId> vertexId=<vertexId> agentId=<agentId> maxDepth=3 maxNodes=24 maxEdges=36
/skill:inference-graph-sequential-subagent-expansion sessionId=<sessionId> vertexId=<vertexId>
```

`herdr` 只应在用户明确要求使用 Herdr 时加载；技能会先检查
`HERDR_ENV=1`。不要仅为了并行任务而加载它。

## 安装到 Pi 全局目录

需要让同一台机器上的多个 Pi 项目都可使用时，将 `AgentSkills/` 的内容
复制到 Pi 的全局目录：

```powershell
$source = '<包含本仓库的路径>\AgentSkills'
$target = Join-Path $HOME '.pi\agent\skills'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $source '*') -Destination $target
```

```bash
mkdir -p "$HOME/.pi/agent/skills"
cp -R /path/to/InferenceGraph/AgentSkills/. "$HOME/.pi/agent/skills/"
```

重启 Pi 或新建会话后，Pi 会在启动时发现全局技能。若目标目录已有同名
技能，应先审查差异；不同位置的同名技能会冲突，Pi 只会保留先被发现的一个。

## 安装到其他兼容 Agent

将 `AgentSkills/` 下的四个子目录复制到目标 Agent 文档规定的项目级或全局
skills 搜索目录，并保留本说明中的目录结构。若该 Agent 不会自动扫描其
skills 目录，则按其配置方式将目标目录加入搜索路径。

导入前应审查每个 `SKILL.md` 的指令、所需 MCP 工具和外部环境变量。技能
可以指示 Agent 执行操作，不能把它们当作不受信任的纯数据文件。

## 维护与校验

更新分发包时，先从全局源目录复制到临时位置并审查差异，再更新
`AgentSkills/`。不要直接覆盖后立即提交：串行子 Agent 技能已改为从已安装
的同名技能读取内容，并仅在未安装时回退读取分发包中的副本。

完成更新后至少检查以下项目：

```bash
find AgentSkills -name SKILL.md -print | sort
git diff --check
```

每个 `SKILL.md` 必须保留有效的小写 `name` 和非空 `description`。Pi 会在
新会话启动时校验这些 frontmatter 字段。
