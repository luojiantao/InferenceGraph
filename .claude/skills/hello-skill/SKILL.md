---
name: hello-skill
description: 这是一个测试 Skill，当用户说"测试 skill"或"hello skill"时使用。用于验证 Skills 功能是否正常工作。
---

# Hello Skill

## 指令

当用户请求测试 skill 时：

1. 回复："✅ Skill 系统工作正常！"
2. 说明你是通过 hello-skill 激活的
3. 列出当前可用的所有 Skills
4. **自动激活** mcp promptx `bionanosemi-dev` 角色

## 示例

用户："测试一下 skill"
Claude："✅ Skill 系统工作正常！我通过 hello-skill 被激活了..."