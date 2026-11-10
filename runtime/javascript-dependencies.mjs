import { parse } from 'acorn';

/** Inspect source as data. Occurrences retain UTF-16 AST offsets; nothing is loaded. */
// oxlint-disable-next-line complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export function inspectJavaScriptModule({ file, source }) {
  const dependencies = [],
    exports = new Set(),
    unsupported = [];
  const unknown = (scope, reason, offset) => unsupported.push({ scope, reason, offset });
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: file.endsWith('.cjs') ? 'script' : 'module',
      allowHashBang: true,
    });
  } catch {
    return {
      schemaVersion: 1,
      dependencies,
      exports: [],
      unsupported: [{ scope: 'dependency', reason: 'parse-error', offset: 0 }],
    };
  }
  const add = (value, kind, node) => {
    if (value?.type === 'Literal' && typeof value.value === 'string')
      dependencies.push({ specifier: value.value, kind, offset: node.start });
    else unknown('dependency', 'computed-loader', node.start);
  };
  const stack = [[ast, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
      add(node.source, node.type === 'ImportDeclaration' ? 'import' : 'reexport', node);
    if (node.type === 'ImportExpression') add(node.source, 'dynamic-import', node);
    if (
      node.type === 'CallExpression' &&
      ((node.callee?.type === 'Identifier' && node.callee.name === 'require') ||
        (node.callee?.type === 'MemberExpression' &&
          node.callee.object?.name === 'require' &&
          node.callee.property?.name === 'resolve'))
    ) {
      if (node.arguments.length !== 1) unknown('dependency', 'computed-loader', node.start);
      else add(node.arguments[0], node.callee.type === 'Identifier' ? 'require' : 'require-resolve', node);
    }
    // Preserve CI's conservative treatment of custom/aliased loaders and eval.
    if (node.type === 'Identifier' && ['require', 'createRequire', 'eval', 'Function'].includes(node.name)) {
      const directRequire =
        node.name === 'require' &&
        ((parent?.type === 'CallExpression' && parent.callee === node) ||
          (parent?.type === 'MemberExpression' && parent.object === node && parent.property?.name === 'resolve'));
      if (!directRequire) unknown('dependency', 'aliased-loader', node.start);
    }
    if (node.type === 'ExportDefaultDeclaration') exports.add('default');
    if (node.type === 'ExportAllDeclaration') {
      if (node.exported) exports.add(node.exported.name ?? node.exported.value);
      else unknown('exports', 'export-star', node.start);
    }
    if (node.type === 'ExportNamedDeclaration') {
      for (const specifier of node.specifiers) exports.add(specifier.exported.name ?? specifier.exported.value);
      const declaration = node.declaration;
      if (declaration?.id?.name) exports.add(declaration.id.name);
      for (const item of declaration?.declarations || []) {
        if (item.id.type === 'Identifier') exports.add(item.id.name);
        else unknown('exports', 'export-pattern', item.start);
      }
    }
    if (
      (node.type === 'MemberExpression' &&
        ((node.object?.type === 'Identifier' && node.object.name === 'exports') ||
          (node.object?.type === 'Identifier' &&
            node.object.name === 'module' &&
            (node.computed ? node.property?.value === 'exports' : node.property?.name === 'exports')))) ||
      (node.type === 'AssignmentExpression' && node.left?.name === 'exports')
    )
      unknown('exports', 'commonjs-exports', node.start);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value))
        for (let index = value.length - 1; index >= 0; index--) stack.push([value[index], node]);
      else if (value && typeof value === 'object') stack.push([value, node]);
    }
  }
  dependencies.sort((a, b) => a.offset - b.offset || compare(a.kind, b.kind) || compare(a.specifier, b.specifier));
  unsupported.sort((a, b) => a.offset - b.offset || compare(a.scope, b.scope) || compare(a.reason, b.reason));
  return { schemaVersion: 1, dependencies, exports: [...exports].sort(), unsupported };
}
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
