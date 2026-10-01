const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { unitOf, displayName, isSink } = require('../lib/units');
const { collectImpact } = require('../lib/graph');
const { classifyFile, apiAliases } = require('../lib/changed-files');
const { analyze } = require('../lib/analyze');
const { parseTitle } = require('../lib/format');
const { buildDiscordPayload } = require('../lib/discord');

const LIB = 'projects/ui/src/lib';

const graphOf = (edges, unitsWithSamples = []) => {
  const dependents = new Map();
  for (const [from, to] of edges) {
    dependents.set(to, new Set([...(dependents.get(to) || []), from]));
  }
  return { dependents, unitsWithSamples: new Set(unitsWithSamples) };
};

const changedFile = (relPath, patch = '', status = 'modified') => ({
  filename: `${LIB}/${relPath}`,
  status,
  additions: 1,
  deletions: 0,
  patch
});

describe('unitOf', () => {
  it('agrupa arquivos pelo componente, inclusive subpastas', () => {
    assert.equal(unitOf('components/po-table/po-table-detail/po-table-detail.component.ts'), 'components/po-table');
  });

  it('separa cada campo de po-field', () => {
    assert.equal(unitOf('components/po-field/po-combo/po-combo.component.ts'), 'components/po-field/po-combo');
    assert.equal(unitOf('components/po-field/validators.ts'), 'components/po-field');
  });

  it('trata arquivos soltos de utils e enums como unidades próprias', () => {
    assert.equal(unitOf('utils/util.ts'), 'utils/util');
    assert.equal(unitOf('utils/util.spec.ts'), 'utils/util');
    assert.equal(unitOf('services/index.ts'), 'services');
  });

  it('exibe componentes pelo nome e demais unidades pelo caminho', () => {
    assert.equal(displayName('components/po-field/po-combo'), 'po-combo');
    assert.equal(displayName('services/po-theme'), 'services/po-theme');
  });

  it('não propaga impacto por index.ts e módulos', () => {
    assert.ok(isSink('components/po-field/index.ts'));
    assert.ok(isSink('components/po-tag/po-tag.module.ts'));
    assert.ok(!isSink('components/po-tag/po-tag.component.ts'));
  });
});

describe('classifyFile', () => {
  it('classifica pelo caminho', () => {
    assert.equal(classifyFile('components/po-tag/po-tag.component.spec.ts', ''), 'test');
    assert.equal(classifyFile('components/po-tag/samples/x/x.component.ts', ''), 'sample');
    assert.equal(classifyFile('components/po-tag/po-tag.component.html', ''), 'template');
    assert.equal(classifyFile('components/po-tag/po-tag-literals.ts', ''), 'literals');
    assert.equal(classifyFile('components/po-tag/index.ts', ''), 'exports');
    assert.equal(classifyFile('components/po-tag/enums/po-tag-type.enum.ts', ''), 'contract');
  });

  it('identifica mudança de API pelos inputs/outputs alterados', () => {
    const patch = "+  @Input({ alias: 'p-new' }) value: string;";
    assert.equal(classifyFile('components/po-tag/po-tag-base.component.ts', patch), 'api');
  });

  it('considera documentação um diff só de comentários', () => {
    const patch = '+   * Nova descrição da propriedade.\n-   * Descrição antiga.';
    assert.equal(classifyFile('components/po-tag/po-tag-base.component.ts', patch), 'doc');
  });

  it('usa lógica como padrão', () => {
    assert.equal(classifyFile('components/po-tag/po-tag.component.ts', '+ this.value = 1;'), 'logic');
  });
});

describe('apiAliases', () => {
  it('detecta propriedades adicionadas e removidas', () => {
    const patch = [
      "-  @Input({ alias: 'p-old' }) a;",
      "+  @Input({ alias: 'p-new' }) a;",
      "+  @Output('p-change') c;"
    ].join('\n');
    assert.deepEqual(apiAliases(patch), { added: ['p-new', 'p-change'], removed: ['p-old'] });
  });

  it('ignora propriedade que só mudou de linha', () => {
    const patch = ["-  @Input({ alias: 'p-same' }) a;", "+  @Input({ alias: 'p-same', transform: x }) a;"].join('\n');
    assert.deepEqual(apiAliases(patch), { added: [], removed: [] });
  });
});

describe('collectImpact', () => {
  const graph = graphOf([
    ['components/po-listbox/po-listbox.component.html', 'components/po-listbox/po-listbox-item.component.ts'],
    ['components/po-field/po-combo/po-combo.component.html', 'components/po-listbox/po-listbox.component.html'],
    ['components/po-dynamic/po-dynamic-form.component.html', 'components/po-field/po-combo/po-combo.component.html']
  ]);

  it('conta distância apenas ao trocar de unidade', () => {
    const impact = collectImpact(graph, ['components/po-listbox/po-listbox-item.component.ts']);
    assert.deepEqual(Object.fromEntries(impact), {
      'components/po-listbox': 0,
      'components/po-field/po-combo': 1,
      'components/po-dynamic': 2
    });
  });

  it('não propaga a partir de módulos', () => {
    const moduleGraph = graphOf([['components/po-page/po-page.component.ts', 'components/po-tag/po-tag.module.ts']]);
    const impact = collectImpact(moduleGraph, ['components/po-tag/po-tag.module.ts']);
    assert.deepEqual([...impact.keys()], ['components/po-tag']);
  });
});

describe('analyze', () => {
  const graph = graphOf(
    [['components/po-field/po-combo/po-combo.component.html', 'components/po-listbox/po-listbox.component.ts']],
    ['components/po-field/po-combo']
  );

  it('lista consumidores e onde testar', () => {
    const result = analyze([changedFile('components/po-listbox/po-listbox.component.ts', '+ x = 1;')], graph);
    assert.deepEqual(result.directConsumers, ['po-combo']);
    assert.deepEqual(result.testTargets, [{ name: 'po-combo', url: 'https://po-ui.io/documentation/po-combo' }]);
    assert.equal(result.overallRisk, 'low');
  });

  it('eleva o risco quando há possível breaking change', () => {
    const patch = "-  @Input({ alias: 'p-old' }) a;";
    const result = analyze([changedFile('components/po-listbox/po-listbox.component.ts', patch)], graph);
    assert.equal(result.overallRisk, 'medium');
    assert.deepEqual(result.changed[0].removedAliases, ['p-old']);
  });

  it('mantém risco baixo quando só testes e samples mudam', () => {
    const result = analyze([changedFile('components/po-listbox/po-listbox.component.spec.ts', '+ it()')], graph);
    assert.equal(result.overallRisk, 'low');
    assert.deepEqual(result.directConsumers, []);
  });

  it('ignora arquivos fora da lib ui', () => {
    const result = analyze(
      [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '' }],
      graph
    );
    assert.equal(result.changed.length, 0);
    assert.equal(result.stats.outsideFiles, 1);
  });
});

describe('saídas', () => {
  it('extrai tipo e escopo do título no padrão de commit', () => {
    assert.deepEqual(parseTitle('fix(calendar): corrige anos'), { type: 'fix', scope: 'calendar' });
    assert.deepEqual(parseTitle('Título livre'), { type: '', scope: '' });
  });

  it('mantém o título da PR como texto, sem interpretar', () => {
    const result = analyze([], graphOf([]));
    const payload = buildDiscordPayload(result, { title: 'fix: $(whoami) `x`', author: '', url: '', number: '1' });
    assert.equal(payload.embeds[0].title, '#1 fix: $(whoami) `x`');
  });
});
