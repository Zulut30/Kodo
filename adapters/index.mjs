export const clients = Object.freeze({
  codex: { skills: '.agents/skills', agentKind: 'skill' },
  'claude-code': { skills: '.claude/skills', agents: '.claude/agents', agentKind: 'claude' },
  // OpenCode officially supports the shared .agents/skills discovery directory.
  opencode: { skills: '.agents/skills', agents: '.opencode/agents', agentKind: 'opencode' }
});

export function selectClients(names) {
  const selected = names.includes('all') ? Object.keys(clients) : [...new Set(names)];
  if (!selected.length) throw new Error('Укажи --client codex, claude-code, opencode или all');
  for (const name of names) if (name !== 'all' && !Object.hasOwn(clients, name)) throw new Error(`Неизвестный клиент: ${name}`);
  return selected;
}

function skill(name, description, body) {
  if (name.length > 64) throw new Error(`Имя навыка длиннее 64 символов: ${name}`);
  return Buffer.from(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`);
}

export function renderComponent(component, bundle, dependencies, bundles, clientName) {
  const client = Object.hasOwn(clients, clientName) ? clients[clientName] : null;
  if (!client) throw new Error(`Неизвестный клиент: ${clientName}`);
  const slug = component.id.split('/')[1];
  const files = new Map();
  if (component.type === 'skill') {
    for (const [name, data] of bundle) files.set(`${client.skills}/${slug}/${name}`, data);
  } else if (component.type === 'agent') {
    const name = `kodo-${slug}`, body = bundle.get('AGENT.md').toString('utf8');
    if (client.agentKind === 'skill') files.set(`${client.skills}/${name}/SKILL.md`, skill(name, component.description, body));
    else {
      const header = client.agentKind === 'claude' ? `name: ${name}\ndescription: ${JSON.stringify(component.description)}` : `description: ${JSON.stringify(component.description)}\nmode: subagent`;
      files.set(`${client.agents}/${name}.md`, Buffer.from(`---\n${header}\n---\n\n${body}`));
    }
  } else if (component.type === 'pipeline') {
    const pipeline = JSON.parse(bundle.get('pipeline.json').toString('utf8'));
    const base = `${client.skills}/${slug}`;
    const intro = `${pipeline.goal}\n\nВыполняй этапы последовательно в текущей сессии, учитывая инструкции проекта и поручение пользователя. Роли ниже задают область внимания; они не требуют запуска отдельных агентов. Делегирование используй только когда оно разрешено и полезно для задачи. Если необходимый вход отсутствует, укажи блокер и продолжай независимую работу. Для каждой проверки различай выполненное, непроведённое и неприменимое.\n\n`;
    const steps = pipeline.steps.map((step, index) => {
      const ref = step.agent ?? step.skill;
      const entry = step.agent ? 'AGENT.md' : 'INSTRUCTIONS.md';
      return `${index + 1}. **${step.id}** — ${step.task}\n   Инструкция: [${ref}](references/${ref}/${entry}). Результат: ${step.output}`;
    }).join('\n\n');
    files.set(`${base}/SKILL.md`, skill(slug, component.description, intro + steps));
    files.set(`${base}/pipeline.json`, bundle.get('pipeline.json'));
    for (const dependency of dependencies.filter(item => item.type === 'agent' || item.type === 'skill')) {
      for (const [name, data] of bundles.get(dependency.id)) {
        const referenceName = dependency.type === 'skill' && name === 'SKILL.md' ? 'INSTRUCTIONS.md' : name;
        files.set(`${base}/references/${dependency.id}/${referenceName}`, data);
      }
    }
  } else if (component.type === 'preset') {
    const name = `kodo-preset-${slug}`;
    files.set(`${client.skills}/${name}/SKILL.md`, skill(name, component.description, bundle.get('PRESET.md').toString('utf8')));
  }
  return files;
}
