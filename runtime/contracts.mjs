import Ajv from 'ajv';
import path from 'node:path';

const ajv = new Ajv({ allErrors: true, strict: true });
export const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tasks'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'description', 'dependsOn', 'writePaths', 'acceptance', 'parallel'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' },
          role: { enum: ['developer', 'tester', 'documenter'] },
          description: { type: 'string', minLength: 1 },
          dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string' } },
          writePaths: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
          acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          parallel: { type: 'boolean' },
        },
      },
    },
  },
};
export const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'checks', 'complete'],
  properties: {
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    complete: { type: 'boolean' },
  },
};
export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'findings'],
  properties: {
    passed: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'severity', 'problem', 'fix'],
        properties: {
          file: { type: 'string' },
          severity: { enum: ['blocker', 'major', 'minor'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};
export const routingSchema = {
  type: 'object',
  required: ['model', 'parallel', 'confidence'],
  properties: {
    model: { type: 'string', minLength: 1 },
    parallel: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    modelConfidence: { type: 'number', minimum: 0, maximum: 1 },
    parallelConfidence: { type: 'number', minimum: 0, maximum: 1 },
    sessionConfidence: { type: 'number', minimum: 0, maximum: 1 },
    sessionMode: { enum: ['fresh', 'continue'] },
    fallback: { type: 'boolean' },
  },
};
const checks = new Map();
export function validate(schema, value) {
  let check = checks.get(schema);
  if (!check) {
    check = ajv.compile(schema);
    checks.set(schema, check);
  }
  if (!check(value))
    throw Object.assign(new Error(`Некорректный контракт: ${ajv.errorsText(check.errors)}`), {
      code: 'invalid_output',
    });
  return value;
}
export function validatePlan(plan) {
  validate(planSchema, plan);
  const nodes = new Map(plan.tasks.map(node => [node.id, node]));
  if (nodes.size !== plan.tasks.length) throw new Error('Повторные идентификаторы задач');
  const seen = new Set(),
    active = new Set();
  function visit(id) {
    if (active.has(id)) throw new Error('Цикл зависимостей задач');
    if (seen.has(id)) return;
    if (!nodes.has(id)) throw new Error(`Неизвестная зависимость: ${id}`);
    active.add(id);
    nodes.get(id).dependsOn.forEach(visit);
    active.delete(id);
    seen.add(id);
  }
  for (const node of plan.tasks) {
    visit(node.id);
    for (const scope of node.writePaths)
      if (
        scope.includes('\\') ||
        scope.startsWith('/') ||
        scope.includes(':') ||
        scope.split('/').includes('..') ||
        /(^|\/)(\.git|\.env[^/]*)(\/|$)/.test(scope)
      )
        throw new Error(`Недопустимая область записи: ${scope}`);
  }
  return plan;
}
export function ownsPath(scopes, name) {
  return scopes.some(
    scope =>
      path.posix.matchesGlob(name, scope) || name === scope || name.startsWith(scope.replace(/\/\*\*$/, '') + '/'),
  );
}
export function scopesOverlap(left, right) {
  return left.some(a =>
    right.some(b => {
      const ap = a.split(/[*?[{]/)[0].replace(/\/$/, ''),
        bp = b.split(/[*?[{]/)[0].replace(/\/$/, '');
      return (
        !ap ||
        !bp ||
        ap === bp ||
        ap.startsWith(bp + '/') ||
        bp.startsWith(ap + '/') ||
        path.posix.matchesGlob(ap, b) ||
        path.posix.matchesGlob(bp, a)
      );
    }),
  );
}
