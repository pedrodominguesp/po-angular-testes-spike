# Análise de impacto de PR

Executada pelo workflow [`pr-analysis.yml`](../../workflows/pr-analysis.yml) na **abertura** de cada Pull Request.
Analisa apenas a lib `projects/ui` e publica:

- **Discord:** resumo em embed (tipo, risco, componentes alterados, consumidores, pontos de atenção e onde testar);
- **PR:** comentário com o relatório completo e checklist de componentes para o teste integrado.

## Como funciona

1. Lista os arquivos alterados pela API do GitHub (o código da PR **não** é baixado nem executado).
2. Agrupa os arquivos em unidades: `components/<componente>`, `components/po-field/<campo>`,
   `services/<serviço>`, `directives/<diretiva>`, `utils/<arquivo>` etc.
3. Monta, a partir da branch base, o grafo reverso de dependências em nível de arquivo:
   - imports TypeScript relativos (incluindo os resolvidos via barrels, como `../../services`);
   - `templateUrl`/`styleUrl`;
   - seletores `<po-*>` usados em templates.

   `index.ts` e `*.module.ts` marcam a unidade como impactada, mas não propagam o impacto.
4. Classifica cada arquivo: API pública, template, lógica, interfaces/enums, literais, exports, estilo,
   testes, samples ou documentação (diffs só de comentário contam como documentação).
5. Detecta propriedades `p-*` adicionadas e removidas/renomeadas (possível breaking change).
6. Calcula o risco por unidade alterada:

   | Critério | Pontos |
   |---|---|
   | Alteração funcional (fora de testes/samples/docs) | +1 |
   | 3+ / 10+ / 25+ unidades impactadas | +1 / +2 / +3 |
   | Propriedade ou arquivo removido | +2 |
   | Alteração em `index.ts`/módulo | +1 |

   Resultado: até 1 ponto → 🟢 baixo · 2-3 → 🟡 médio · 4+ → 🔴 alto. O risco da PR é o maior entre as unidades.

7. "Onde testar" lista a documentação do portal das unidades alteradas e consumidores diretos que possuem samples.

## Executando localmente

```bash
node .github/scripts/pr-impact/pr-impact.js --base origin/master --out-dir pr-impact
```

Gera `pr-impact/report.md`, `pr-impact/discord.json` e `pr-impact/report.json`.
Use `--head <ref>` para analisar outro commit/branch e as variáveis `PR_TITLE`, `PR_AUTHOR`, `PR_URL` e
`PR_NUMBER` para preencher os metadados.

## Limitações

- O grafo é gerado a partir da branch base: componentes criados na própria PR aparecem sem consumidores.
- Arquivos muito grandes podem vir sem `patch` da API; nesse caso a classificação usa apenas o caminho.
- Se a análise falhar, o Discord recebe a notificação simples (autor, título e link).
