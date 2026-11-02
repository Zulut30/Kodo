# Database MCP — Supabase

Первый поддерживаемый шаблон базы данных — hosted Supabase MCP. Это не универсальный коннектор к PostgreSQL, MySQL или SQLite. Замени `REPLACE_WITH_PROJECT_REF` идентификатором нужного Supabase-проекта. Параметр `read_only=true` включает режим чтения, `features=database,docs` ограничивает группы инструментов.

Объедини нужную секцию с конфигурацией проекта: Codex — `.codex/config.toml`, Claude Code — `.mcp.json`, OpenCode — `opencode.json`/`opencode.jsonc`. В Codex/OpenCode включи сервер после настройки. Пройди OAuth в выбранном клиенте и проверь список таблиц нужного проекта. Не убирай `project_ref`: он ограничивает область подключения.

Toolkit только сохраняет шаблоны в `.ai-toolkit/components/mcp/database/`. Он не авторизуется и не выполняет SQL. Шаблон не включён в пресеты: добавь его явно через `install mcp/database`.

Источник: [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp). Сверено 2026-11-02; доступ к конкретной базе не проверен.
