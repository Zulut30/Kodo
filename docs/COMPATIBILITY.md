# Совместимость Kodo

Каталог устанавливает навыки в поддерживаемые клиентами каталоги. Исполнитель запускает официальные CLI через подписочную авторизацию. Правильный файл, обнаружение клиентом и выполнение задачи подтверждаются отдельно.

## Навыки и роли

| Клиент | Навыки | Роли |
| --- | --- | --- |
| Codex | `.agents/skills/<name>/SKILL.md` | Навыки `kodo-<role>` |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `.claude/agents/kodo-<role>.md` |
| OpenCode | Общий путь `.agents/skills/<name>/SKILL.md` | `.opencode/agents/kodo-<role>.md` |

Codex и OpenCode используют общую копию навыков. При установке для Claude Code создаётся ещё одна копия; OpenCode умеет обнаруживать и её. Исходники компонентов общие, а адаптеры отвечают за формат клиента.

Официальные описания: [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [OpenCode skills](https://opencode.ai/docs/skills/), [OpenCode agents](https://opencode.ai/docs/agents/).

## Исполнение по подпискам

Codex использует неинтерактивный клиент, JSON-события и явные идентификаторы сессий. Список моделей зависит от доступа аккаунта; наличие имени в кэше не доказывает возможность выполнить запрос. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [App Server model/list](https://learn.chatgpt.com/docs/app-server).

Claude Code запускается через обычный `claude -p` с авторизацией подписки. `--bare` для этого режима не подходит: он не использует OAuth subscription login. Переменные API-провайдеров не должны незаметно переключать запуск на платный API. [Programmatic Claude Code](https://code.claude.com/docs/en/headless), [Authentication](https://code.claude.com/docs/en/authentication).

В первом исполнителе используются Sol/Astra/Terra через Codex и Opus/Sonnet через Claude Code, если клиент и аккаунт действительно их предоставляют. По умолчанию маршрутизация остаётся внутри одного клиента; `--providers both` явно разрешает обе подписки. Недоступная модель исключается из выбора.

OpenCode пока служит точкой запуска навыка с настроенным backend Codex или Claude. Отдельное исполнение дешёвыми моделями OpenCode не входит в этот этап.

## Внешние API

- Анализ: [Gemini 4 Argon](https://aistudio.google.com/docs/models/gemini-4-argon).
- Маршрутизация: [TypeSafe Jev](https://docs.typesafe.ai/introduction). Jev принимает типизированные решения; текст плана готовит основная модель.
- Поиск Reddit: [Reddit API](https://www.redditapis.com/docs).
- Поиск X: [GetXAPI](https://docs.getxapi.com/docs).
- Поиск и получение GitHub, Hacker News и страниц документации: [Scrape.do](https://scrape.do/documentation/).

Исследователь использует операции чтения. Права сервиса на публикацию, голосование или другие действия не означают, что Kodo должен их выполнять.

## Доставка и MCP

Для личного репозитория Kodo использует свою очередь и актуальные обязательные проверки `main`. Нативная merge queue GitHub предназначена для репозиториев организаций. [Merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

MCP-шаблоны основаны на документации [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp) и [OpenCode](https://opencode.ai/docs/mcp-servers/). Серверы: [GitHub](https://github.com/github/github-mcp-server), [Playwright](https://github.com/microsoft/playwright-mcp), [Supabase](https://supabase.com/docs/guides/ai-tools/mcp). Копирование шаблона не проверяет авторизацию или соединение.
