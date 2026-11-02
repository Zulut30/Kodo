---
name: composition-patterns
description: Используй композицию компонентов Vercel при изменении React API, общего состояния и вариантов UI в Kodo.
---

При изменении компонентного API проверь разрастание boolean props, владельца состояния и границы контекста. Выбери явные варианты и композицию детей там, где они упрощают реальные сценарии. Сохраняй совместимость потребителей. Правила React 19 применяй только после проверки версии; не переписывай React 18 по примерам нового API.

Оригинальный навык Vercel — `vercel-composition-patterns`: [upstream](references/upstream/SKILL.md.original), [boolean props](references/upstream/rules/architecture-avoid-boolean-props.md), [context interface](references/upstream/rules/state-context-interface.md). Отдельный renderer или library не устанавливается автоматически. Исходник объявляет MIT; декларации сохранены вместе с оригиналом.
