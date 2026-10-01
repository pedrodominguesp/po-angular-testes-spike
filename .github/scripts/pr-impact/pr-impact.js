#!/usr/bin/env node
/**
 * Análise de impacto de Pull Request na lib `projects/ui`.
 *
 * Mapeia os arquivos alterados para "unidades" da lib (componentes, serviços, diretivas, utils...),
 * monta o grafo reverso de dependências (imports TS + seletores usados em templates) e gera:
 *  - report.md    → relatório completo (comentário na PR)
 *  - discord.json → payload de embed para o webhook do Discord
 *  - report.json  → dados brutos
 *
 * Uso:
 *   node pr-impact.js --files files.json --out-dir out   # CI: lista de arquivos da API do GitHub
 *   node pr-impact.js --base origin/master --out-dir out # local: diff do git
 *
 * Metadados da PR são lidos de variáveis de ambiente: PR_TITLE, PR_AUTHOR, PR_URL, PR_NUMBER.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB_DIR = 'projects/ui/src/lib';
const DOCS_URL = 'https://po-ui.io/documentation';
const MAX_LIST = 15;

// Arquivos agregadores (barrels/módulos raiz) não são considerados dependências reais.
const AGGREGATOR_UNITS = new Set([
  'root',
  'components',
  'services',
  'directives',
  'pipes',
  'interceptors',
  'guards',
  'decorators',
  'interfaces',
  'utils',
  'enums'
]);

const API_LINE = /@Input\(|@Output\(|\binput(<|\(|\.required)|\boutput(<|\()|\bmodel(<|\(|\.required)/;
const ALIAS = /alias:\s*'([^']+)'|@(?:Input|Output)\(\s*'([^']+)'/g;

const CATEGORY_LABELS = {
  api: 'API pública',
  exports: 'exports/módulos',
  logic: 'lógica',
  template: 'template',
  style: 'estilo',
  literals: 'literais (i18n)',
  contract: 'interfaces/enums',
  sample: 'samples',
  test: 'testes',
  doc: 'documentação'
};
const NON_FUNCTIONAL = new Set(['sample', 'test', 'doc']);

const RISK = {
  low: { label: 'Baixo', emoji: '🟢', color: 0x2ecc71 },
  medium: { label: 'Médio', emoji: '🟡', color: 0xf1c40f },
  high: { label: 'Alto', emoji: '🔴', color: 0xe74c3c }
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const toPosix = p => p.split(path.sep).join('/');

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else {
      files.push(toPosix(full));
    }
  }
  return files;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function truncateList(items, max = MAX_LIST) {
  if (items.length <= max) {
    return items.join(', ');
  }
  return `${items.slice(0, max).join(', ')} … (+${items.length - max})`;
}

function truncateText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Unidades da lib
// ---------------------------------------------------------------------------

/** Converte um caminho relativo à lib em uma unidade (ex.: `components/po-field/po-combo`). */
function unitOf(relPath) {
  const seg = relPath.split('/');
  if (seg.length === 1) {
    return 'root';
  }
  const isAggregatorFile = name => name === 'index.ts' || name.endsWith('.module.ts');

  if (seg[0] === 'components') {
    if (seg.length === 2) {
      return 'components';
    }
    if (seg[1] === 'po-field') {
      return seg.length === 3 ? 'components/po-field' : `components/po-field/${seg[2]}`;
    }
    return `components/${seg[1]}`;
  }
  if (seg.length === 2) {
    return isAggregatorFile(seg[1]) ? seg[0] : `${seg[0]}/${seg[1].replace(/(\.spec)?\.ts$/, '')}`;
  }
  return `${seg[0]}/${seg[1]}`;
}

const displayName = unit => (unit.startsWith('components/') ? unit.split('/').pop() : unit);

function isGraphSource(relPath) {
  return (
    (relPath.endsWith('.ts') || relPath.endsWith('.html')) &&
    !relPath.endsWith('.spec.ts') &&
    !relPath.includes('/samples/') &&
    !relPath.startsWith('util-test/')
  );
}

// ---------------------------------------------------------------------------
// Grafo de dependências
// ---------------------------------------------------------------------------

/** Barrels e módulos agregam tudo; marcam a unidade como impactada, mas não propagam o impacto. */
const isSink = file => path.basename(file) === 'index.ts' || file.endsWith('.module.ts') || !file.includes('/');

/**
 * Grafo em nível de arquivo: `dependents.get(a)` são os arquivos que importam `a`
 * (ou que usam em template o seletor declarado em `a`).
 */
function buildGraph(libDir) {
  const absLib = path.resolve(libDir);
  const allFiles = walk(absLib).map(f => toPosix(path.relative(absLib, f)));
  const files = allFiles.filter(isGraphSource);
  const sources = new Map(files.map(f => [f, stripComments(fs.readFileSync(path.join(absLib, f), 'utf8'))]));

  // símbolo exportado → arquivo (para resolver imports via barrels como '../../services')
  const symbolFile = new Map();
  // seletor de elemento → arquivo que o declara
  const selectorFile = new Map();
  const unitsWithSamples = new Set();

  for (const file of allFiles) {
    const match = file.match(/^(.*?)\/samples\//);
    if (match) {
      unitsWithSamples.add(unitOf(`${match[1]}/x.ts`));
    }
  }

  for (const [file, source] of sources) {
    if (!file.endsWith('.ts') || isSink(file)) {
      continue;
    }
    for (const m of source.matchAll(
      /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|const|function|type|let)\s+(\w+)/g
    )) {
      if (!symbolFile.has(m[1])) {
        symbolFile.set(m[1], file);
      }
    }
    for (const m of source.matchAll(/selector:\s*['`]([^'`]+)['`]/g)) {
      for (const selector of m[1].split(',').map(s => s.trim())) {
        if (/^po-[\w-]+$/.test(selector)) {
          selectorFile.set(selector, file);
        }
      }
    }
  }

  const dependents = new Map();
  const addEdge = (from, to) => {
    if (!to || from === to) {
      return;
    }
    if (!dependents.has(to)) {
      dependents.set(to, new Set());
    }
    dependents.get(to).add(from);
  };

  for (const [file, source] of sources) {
    if (file.endsWith('.ts')) {
      for (const m of source.matchAll(/(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+'(\.[^']*)'/g)) {
        const target = resolveImport(absLib, file, m[2]);
        if (!target) {
          continue;
        }
        if (path.basename(target) === 'index.ts') {
          for (const name of m[1].replace(/[{}*]/g, '').split(',')) {
            addEdge(file, symbolFile.get(name.trim().split(/\s+as\s+/)[0]));
          }
        } else {
          addEdge(file, target);
        }
      }
      for (const m of source.matchAll(/(?:templateUrl|styleUrl)\s*:\s*'(\.[^']*)'/g)) {
        addEdge(file, toPosix(path.join(path.dirname(file), m[1])));
      }
    }

    for (const m of source.matchAll(/<(po-[\w-]+)/g)) {
      addEdge(file, selectorFile.get(m[1]));
    }
  }

  return { dependents, unitsWithSamples };
}

function resolveImport(absLib, fromFile, specifier) {
  const base = path.resolve(absLib, path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) {
      const rel = toPosix(path.relative(absLib, candidate));
      return rel.startsWith('..') ? null : rel;
    }
  }
  return null;
}

/**
 * Busca em largura a partir dos arquivos alterados. A distância só aumenta ao cruzar a fronteira
 * de uma unidade, então o retorno é "unidade → quantos saltos de unidade até ela".
 */
function collectImpact(graph, startFiles) {
  const best = new Map(startFiles.map(f => [f, 0]));
  const unitDistance = new Map();
  let frontier = [...startFiles];

  for (let level = 0; frontier.length; level++) {
    const next = [];
    const stack = [...frontier];
    while (stack.length) {
      const file = stack.pop();
      const unit = unitOf(file);
      if (!unitDistance.has(unit)) {
        unitDistance.set(unit, level);
      }
      if (isSink(file)) {
        continue;
      }
      for (const consumer of graph.dependents.get(file) || []) {
        const sameUnit = unitOf(consumer) === unit;
        const dist = sameUnit ? level : level + 1;
        if (best.has(consumer) && best.get(consumer) <= dist) {
          continue;
        }
        best.set(consumer, dist);
        (sameUnit ? stack : next).push(consumer);
      }
    }
    frontier = next.filter(f => best.get(f) === level + 1);
  }
  return unitDistance;
}

// ---------------------------------------------------------------------------
// Arquivos alterados
// ---------------------------------------------------------------------------

function loadChangedFiles(args) {
  if (args.files) {
    return JSON.parse(fs.readFileSync(args.files, 'utf8')).map(f => ({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch || ''
    }));
  }

  const range = `${args.base}...${args.head || 'HEAD'}`;
  const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const statusMap = { A: 'added', D: 'removed', M: 'modified', R: 'renamed' };

  return git('diff', '--numstat', range)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [additions, deletions, filename] = line.split('\t');
      const status = git('diff', '--name-status', range, '--', filename).trim().charAt(0);
      return {
        filename,
        status: statusMap[status] || 'modified',
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
        patch: git('diff', '-U0', range, '--', filename)
      };
    });
}

function classifyFile(relPath, patch) {
  if (relPath.endsWith('.spec.ts') || relPath.startsWith('util-test/')) {
    return 'test';
  }
  if (relPath.includes('/samples/')) {
    return 'sample';
  }
  if (relPath.endsWith('.md')) {
    return 'doc';
  }
  if (relPath.endsWith('.html')) {
    return 'template';
  }
  if (/\.(s?css|less)$/.test(relPath)) {
    return 'style';
  }
  if (/literals|\.constant\.ts$/.test(relPath)) {
    return 'literals';
  }
  if (path.basename(relPath) === 'index.ts' || relPath.endsWith('.module.ts')) {
    return 'exports';
  }
  if (/\.(interface|enum)\.ts$/.test(relPath) || /\/(interfaces|enums)\//.test(relPath)) {
    return 'contract';
  }
  const changedLines = patch.split('\n').filter(l => /^[+-](?![+-]{2} )/.test(l));
  if (changedLines.length && changedLines.every(l => /^[+-]\s*(\*|\/\/|\/\*|$)/.test(l))) {
    return 'doc';
  }
  if (changedLines.some(l => API_LINE.test(l))) {
    return 'api';
  }
  return 'logic';
}

/** Aliases de inputs/outputs adicionados e removidos (removidos sem re-adição podem indicar breaking change). */
function apiAliases(patch) {
  const added = new Set();
  const removed = new Set();
  for (const line of patch.split('\n')) {
    const target =
      line.startsWith('+') && !line.startsWith('+++')
        ? added
        : line.startsWith('-') && !line.startsWith('---')
          ? removed
          : null;
    if (!target) {
      continue;
    }
    for (const m of line.matchAll(ALIAS)) {
      target.add(m[1] || m[2]);
    }
  }
  return {
    added: [...added].filter(a => !removed.has(a)),
    removed: [...removed].filter(a => !added.has(a))
  };
}

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

function analyze(changedFiles, graph) {
  const prefix = `${LIB_DIR}/`;
  const libFiles = changedFiles.filter(f => f.filename.startsWith(prefix));
  const outsideFiles = changedFiles.filter(f => !f.filename.startsWith(prefix));

  const units = new Map(); // unidade → { categories, files, addedAliases, removedAliases, removedFiles }
  for (const file of libFiles) {
    const rel = file.filename.slice(prefix.length);
    const unit = unitOf(rel);
    if (!units.has(unit)) {
      units.set(unit, {
        categories: new Set(),
        files: [],
        functionalFiles: [],
        addedAliases: new Set(),
        removedAliases: new Set(),
        removedFiles: []
      });
    }
    const info = units.get(unit);
    const category = classifyFile(rel, file.patch);
    info.categories.add(category);
    info.files.push(rel);
    if (!NON_FUNCTIONAL.has(category)) {
      info.functionalFiles.push(rel);
    }
    if (file.status === 'removed' && !NON_FUNCTIONAL.has(category)) {
      info.removedFiles.push(rel);
    }
    const aliases = apiAliases(file.patch);
    aliases.added.forEach(a => info.addedAliases.add(a));
    aliases.removed.forEach(a => info.removedAliases.add(a));
  }

  const impact = collectImpact(
    graph,
    [...units.values()].flatMap(info => info.functionalFiles)
  );

  const changed = [...units].map(([unit, info]) => {
    const own = collectImpact(graph, info.functionalFiles);
    own.delete(unit);
    const transitive = [...own.keys()].filter(u => !AGGREGATOR_UNITS.has(u)).length;
    const direct = [...own].filter(([u, d]) => d === 1 && !AGGREGATOR_UNITS.has(u)).map(([u]) => u);
    const functional = info.functionalFiles.length > 0;

    let score = 0;
    const reasons = [];
    if (functional) {
      score += 1;
      if (transitive >= 25) {
        score += 3;
        reasons.push(`dependência compartilhada por ${transitive} unidades`);
      } else if (transitive >= 10) {
        score += 2;
        reasons.push(`${transitive} unidades dependem dela`);
      } else if (transitive >= 3) {
        score += 1;
      }
      if (info.removedAliases.size || info.removedFiles.length) {
        score += 2;
        reasons.push('possível breaking change');
      }
      if (info.categories.has('exports')) {
        score += 1;
        reasons.push('altera exports/módulos');
      }
    }
    const risk = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

    return {
      unit,
      name: displayName(unit),
      categories: [...info.categories],
      files: info.files,
      addedAliases: [...info.addedAliases],
      removedAliases: [...info.removedAliases],
      removedFiles: info.removedFiles,
      directConsumers: direct.map(displayName).sort(),
      transitiveCount: transitive,
      functional,
      risk,
      reasons
    };
  });

  const changedSet = new Set(units.keys());
  const affected = [...impact].filter(([unit]) => !changedSet.has(unit) && !AGGREGATOR_UNITS.has(unit));
  const direct = affected.filter(([, d]) => d === 1).map(([u]) => u);
  const indirect = affected.filter(([, d]) => d > 1).map(([u]) => u);

  const riskOrder = ['low', 'medium', 'high'];
  const overallRisk = changed.reduce(
    (acc, c) => (riskOrder.indexOf(c.risk) > riskOrder.indexOf(acc) ? c.risk : acc),
    'low'
  );

  // Onde testar: unidades com samples no portal, priorizando as alteradas e depois os consumidores diretos.
  const testTargets = [...changed.filter(c => c.functional).map(c => c.unit), ...[...direct].sort()]
    .filter(u => graph.unitsWithSamples.has(u))
    .map(u => ({ name: displayName(u), url: `${DOCS_URL}/${displayName(u)}` }));

  return {
    changed: changed.sort((a, b) => riskOrder.indexOf(b.risk) - riskOrder.indexOf(a.risk)),
    directConsumers: direct.map(displayName).sort(),
    indirectConsumers: indirect.map(displayName).sort(),
    testTargets,
    overallRisk,
    stats: {
      files: changedFiles.length,
      libFiles: libFiles.length,
      outsideFiles: outsideFiles.length,
      additions: changedFiles.reduce((s, f) => s + f.additions, 0),
      deletions: changedFiles.reduce((s, f) => s + f.deletions, 0)
    }
  };
}

// ---------------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------------

function parseTitle(title) {
  const m = (title || '').match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.*)$/);
  return m ? { type: m[1], scope: m[2] || '', subject: m[3] } : { type: '', scope: '', subject: title || '' };
}

function attentionItems(result) {
  const items = [];
  for (const c of result.changed) {
    if (c.removedAliases.length) {
      items.push(
        `⚠️ \`${c.name}\`: propriedade removida/renomeada → ${c.removedAliases.map(a => `\`${a}\``).join(', ')}`
      );
    }
    if (c.removedFiles.length) {
      items.push(`⚠️ \`${c.name}\`: ${c.removedFiles.length} arquivo(s) removido(s)`);
    }
    if (c.addedAliases.length) {
      items.push(`🆕 \`${c.name}\`: nova(s) propriedade(s) → ${c.addedAliases.map(a => `\`${a}\``).join(', ')}`);
    }
    if (c.transitiveCount >= 25 && c.functional) {
      items.push(`🌐 \`${c.name}\` é usada por ${c.transitiveCount} unidades — considere um teste de regressão amplo`);
    }
  }
  if (result.changed.length && result.changed.every(c => !c.functional)) {
    items.push('✅ Apenas testes, samples ou documentação foram alterados');
  }
  return items;
}

function buildMarkdown(result, pr) {
  const risk = RISK[result.overallRisk];
  const { stats } = result;
  const lines = [
    '<!-- pr-impact-report -->',
    '## 🔎 Análise de impacto',
    '',
    `**Risco estimado:** ${risk.emoji} ${risk.label} · **Arquivos:** ${stats.files} (+${stats.additions}/-${stats.deletions})` +
      (stats.outsideFiles ? ` · ${stats.outsideFiles} fora da lib \`ui\` (não analisados)` : ''),
    ''
  ];

  if (!result.changed.length) {
    lines.push('Nenhum arquivo da lib `ui` foi alterado nesta PR.');
    return lines.join('\n');
  }

  const attention = attentionItems(result);
  if (attention.length) {
    lines.push('### Pontos de atenção', '', ...attention.map(a => `- ${a}`), '');
  }

  lines.push(
    '### Unidades alteradas',
    '',
    '| Unidade | Tipo de mudança | Consumidores diretos | Impacto total | Risco |',
    '|---|---|---|---|---|'
  );
  for (const c of result.changed) {
    const r = RISK[c.risk];
    lines.push(
      `| \`${c.name}\` | ${c.categories.map(cat => CATEGORY_LABELS[cat]).join(', ')} | ${
        c.directConsumers.length
          ? truncateList(
              c.directConsumers.map(n => `\`${n}\``),
              8
            )
          : '—'
      } | ${c.transitiveCount} | ${r.emoji} ${r.label}${c.reasons.length ? ` — ${c.reasons.join('; ')}` : ''} |`
    );
  }
  lines.push('');

  if (result.directConsumers.length || result.indirectConsumers.length) {
    lines.push('### Componentes impactados', '');
    if (result.directConsumers.length) {
      lines.push(
        `**Diretos (${result.directConsumers.length}):** ${result.directConsumers.map(n => `\`${n}\``).join(', ')}`,
        ''
      );
    }
    if (result.indirectConsumers.length) {
      lines.push(
        `<details><summary><b>Indiretos (${result.indirectConsumers.length})</b></summary>`,
        '',
        result.indirectConsumers.map(n => `\`${n}\``).join(', '),
        '',
        '</details>',
        ''
      );
    }
  }

  if (result.testTargets.length) {
    lines.push('### Onde testar', '', ...result.testTargets.map(t => `- [ ] [${t.name}](${t.url})`), '');
  }

  lines.push(
    '<details><summary>Arquivos por unidade</summary>',
    '',
    ...result.changed.map(c => `- \`${c.name}\`: ${c.files.map(f => `\`${f}\``).join(', ')}`),
    '',
    '</details>',
    '',
    `<sub>Gerado automaticamente a partir do grafo de imports e seletores da branch base${pr.number ? ` · PR #${pr.number}` : ''}.</sub>`
  );
  return lines.join('\n');
}

function buildDiscordPayload(result, pr) {
  const risk = RISK[result.overallRisk];
  const { type, scope } = parseTitle(pr.title);
  const { stats } = result;
  const field = (name, value, inline = false) => ({ name, value: truncateText(value || '—', 1024), inline });

  const fields = [
    field('Tipo', [type, scope].filter(Boolean).join(' · ') || '—', true),
    field('Risco', `${risk.emoji} ${risk.label}`, true),
    field('Arquivos', `${stats.files} (+${stats.additions}/-${stats.deletions})`, true)
  ];

  if (result.changed.length) {
    fields.push(
      field(
        'Alterados',
        result.changed
          .map(c => `\`${c.name}\` (${c.categories.map(cat => CATEGORY_LABELS[cat]).join(', ')})`)
          .join('\n')
      )
    );
    if (result.directConsumers.length) {
      fields.push(
        field(`Consumidores diretos (${result.directConsumers.length})`, truncateList(result.directConsumers))
      );
    }
    if (result.indirectConsumers.length) {
      fields.push(
        field(`Impacto indireto (${result.indirectConsumers.length})`, truncateList(result.indirectConsumers, 10))
      );
    }
    const attention = attentionItems(result);
    if (attention.length) {
      fields.push(field('Atenção', attention.join('\n')));
    }
    if (result.testTargets.length) {
      fields.push(
        field(
          'Onde testar',
          result.testTargets
            .slice(0, 8)
            .map(t => `[${t.name}](${t.url})`)
            .join(' · ')
        )
      );
    }
  } else {
    fields.push(field('Lib ui', 'Nenhum arquivo da lib `ui` alterado'));
  }

  return {
    content: '🚀 **Nova Pull Request** 🚀',
    embeds: [
      {
        title: truncateText(`${pr.number ? `#${pr.number} ` : ''}${pr.title || ''}`, 256),
        url: pr.url || undefined,
        color: risk.color,
        author: pr.author ? { name: pr.author, url: `https://github.com/${pr.author}` } : undefined,
        fields,
        footer: { text: 'Relatório completo nos comentários da PR' }
      }
    ]
  };
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files && !args.base) {
    console.error('Informe --files <arquivo.json> ou --base <ref>.');
    process.exit(1);
  }
  const outDir = args['out-dir'] || 'pr-impact';
  const pr = {
    title: process.env.PR_TITLE || '',
    author: process.env.PR_AUTHOR || '',
    url: process.env.PR_URL || '',
    number: process.env.PR_NUMBER || ''
  };

  const graph = buildGraph(LIB_DIR);
  const result = analyze(loadChangedFiles(args), graph);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), buildMarkdown(result, pr));
  fs.writeFileSync(path.join(outDir, 'discord.json'), JSON.stringify(buildDiscordPayload(result, pr)));

  console.log(
    `Risco: ${result.overallRisk} · alterados: ${result.changed.length} · diretos: ${result.directConsumers.length} · indiretos: ${result.indirectConsumers.length}`
  );
}

main();
