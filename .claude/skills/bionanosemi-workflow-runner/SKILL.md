---
name: bionanosemi-workflow-runner
description: Execute BionanoSemi repository workflows stored in Doc/WorkFlows. Use when the user asks to run, follow, apply, or execute a specified workflow, mentions a workflow document by name, asks which workflow to use, or provides supplemental instructions for a Doc/WorkFlows procedure. If no matching workflow is specified, ask the user which workflow to execute before proceeding.
---

# BionanoSemi Workflow Runner

## Overview

Use the Markdown files in `Doc/WorkFlows` as the authoritative workflow source for BionanoSemi project tasks. Do not duplicate workflow content in this skill; always discover and read the current workflow file from the repository before acting.

## Workflow Directory

Default workflow directory:

```text
D:\Code\Code_2026\BionanoSemi\Doc\WorkFlows
```

When working from the repository root, use `Doc/WorkFlows`. If the absolute path is unavailable, locate the nearest repository root and resolve `Doc/WorkFlows` from there.

## Selection Rules

1. List available workflow candidates from `Doc/WorkFlows`, including `.md` files and workflow directories that contain `FLOW.md`.
2. Match the user's requested workflow against file names, file stems, directory names, and obvious keyword aliases.
3. Prefer an exact file-name or stem match over fuzzy keyword matches.
4. If there is no specified workflow, no match, or multiple plausible matches, ask the user which workflow to execute and include the candidate names. Do not guess.
5. Treat `README.md` as an index only unless the user explicitly asks to update or inspect the index.

## Execution Rules

1. Read the selected workflow document completely before making changes or running commands.
2. If the workflow document links to required references, templates, or subdocuments, read only the files needed for the current task.
3. Follow the workflow order, checklists, validation steps, and output expectations in the document.
4. Apply user-provided supplemental instructions as task-specific constraints after reading the workflow.
5. If supplemental instructions conflict with the workflow, repository rules, or system/developer instructions, stop and ask for clarification unless the higher-priority instruction clearly resolves the conflict.
6. Preserve repository conventions from `CLAUDE.md`, including Chinese responses, .NET Framework 4.8.1 expectations, WPF/Prism conventions, and conservative scoped edits.
7. Execute the work end to end when enough information is available: inspect context, edit files, run relevant validation, and report the result.
8. If the workflow requires missing external inputs, credentials, hardware, or ambiguous target modules, ask the user for the smallest necessary clarification.

## Supplemental Instructions

Recognize supplemental instructions from explicit labels such as "supplemental instructions", "extra requirements", or the equivalent Chinese phrases commonly used by the repository owner, as well as any task-specific constraint following the workflow request.

When supplemental instructions are present:

- Restate only the actionable constraints if needed for clarity.
- Integrate them into the selected workflow's steps.
- Do not rewrite the workflow document unless the user explicitly asks to update the workflow itself.

## Common Requests

- "Execute the PLC IO point table generation workflow"
- "Follow the component creation workflow to add a component"
- "Use the S_HMI_MODULE generation workflow for this Excel file"
- "Execute the matching workflow; supplemental instruction: only handle PBD1"
- "Run the workspace overview unit synchronization workflow"

## If No Workflow Is Specified

Ask a concise question before acting:

```text
master, which workflow should I execute? I can choose from Doc\WorkFlows, for example: <candidate list>.
```
