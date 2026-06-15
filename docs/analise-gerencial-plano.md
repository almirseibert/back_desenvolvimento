# Análise Gerencial — Plano de Execução

Refatoração da atual aba "Confronto Faturamento × Rastreador" (dentro do SigaSul) para uma seção própria de **Análise Gerencial**, com modelo de dados, navegação e propósito reposicionados.

---

## 1. Reframe do problema

A análise não é conciliação contábil de horas. É **detecção de comportamento operacional anômalo** entre 3 fontes:

1. **Faturamento (manual)** — o que cobramos do cliente. Quanto mais horas, melhor para a receita, mas vulnerável a subfaturamento por parte do operador.
2. **Rastreador (horímetro/ignição)** — o que a máquina efetivamente operou. Normalmente **menor** que o faturado, porque máquina parada esperando outra (legítimo) também desliga para economizar diesel.
3. **Ponto do funcionário (operador)** — quando o operador entrou e saiu. **Ainda não integrado** — virá em fase posterior.

Casos a detectar:
- Operador bate ponto às 06h, máquina só liga às 10h → 4h de gap inicial não justificado.
- Máquina rodou 9h, faturamento lançou 6h → 3h não cobradas do cliente.
- Faturado 8h, máquina rodou 5h, ponto bate 8h → normal (pausas legítimas).
- Atividade do rastreador num dia sem nenhum lançamento.

A unidade de análise é **discrepância entre as 3 fontes acima de um limiar**, não "dia-máquina".

---

## 2. Onde mora a análise

**Nova seção no sidebar: "Análise Gerencial"**, posicionada abaixo de Relatórios, com role-gate.

```
Sidebar
├── Dashboard
├── Veículos
├── Obras
├── ...operacional...
├── Relatórios
└── 🔍 Análise Gerencial        ← NOVO
    ├── Discrepâncias Operacionais   ← 1ª análise
    └── (espaço pra futuras análises)
```

A página é um **container com sub-navegação interna**. A primeira (e por enquanto única) análise é "Discrepâncias Operacionais". Conforme novas análises forem aparecendo (custo real por obra, ranking de operadores, consumo × horímetro etc.), entram como irmãs.

A aba "Confronto" atual no `SigaSulPage` deixa de existir. O SigaSul volta a ser exclusivamente sobre rastreador puro.

---

## 3. Funil de 3 telas (Discrepâncias Operacionais)

### Tela 1 — Seleção de obra (entrada obrigatória)

Sem obra escolhida, não há análise. Grade de cards de obras com 3 indicadores cada:

```
┌──────────────────────────────┐
│ Obra Lajeado BR-386          │
│  18  discrepâncias no mês    │
│  4   máquinas envolvidas     │
│  62h gap acumulado           │
│  [Analisar]                  │
└──────────────────────────────┘
```

Ordenadas por **gap acumulado** desc — obra com mais minutos suspeitos aparece primeiro. Filtro de período no topo (default último mês fechado).

### Tela 2 — Visão da obra escolhida

Três blocos empilhados, do macro pro micro:

**Bloco 1 — Resumo da obra no período (4 KPIs)**
- *Gap ponto → máquina* (operador presente, máquina desligada) — **X horas**
- *Gap máquina → faturado* (máquina rodou, faturamento omitiu) — **Y horas**
- *Gap faturado → máquina* (faturou mais do que rodou — pode ser legítimo) — **Z horas**
- *Dias sem nenhum lançamento com atividade detectada* — **N dias**

**Bloco 2 — Ranking dos geradores de discrepância**
- Top 5 máquinas (RE + minutos acumulados)
- Top 5 operadores (nome + minutos acumulados)

Cada linha clicável → drill na Tela 3.

**Bloco 3 — Lista de discrepâncias do período**
Ordenada por magnitude, mostrando só as significativas (~20-30 linhas):

```
🔴 4h12min  RE-103 / João Silva     12/06  Ponto 06:00, máquina ligou 10:12
🟠 2h45min  RE-087 / Carlos Souza   11/06  Faturado 06–14h, máquina rodou 14–17h
🟠 3h00min  RE-103 / João Silva     11/06  Faturado 8h, máquina 5h, ponto 8h
🟡   45min  RE-061 / Pedro Rocha    10/06  Máquina parou 16:45, ponto até 17:30
```

### Tela 3 — Drill de um (máquina+operador+dia)

Timeline 24h com **3 trilhas sobrepostas** (Faturado / Rastreador / Ponto), gaps destacados por cor do tipo, narrativa em texto humano:

> *"João bateu ponto às 06:00 mas só ligou a RE-103 às 10:12 (gap de 4h12min). A máquina trabalhou até 15:30 e ele saiu às 17:00. O faturamento lançou 08:00–17:00 (9h), mas o motor rodou 5h18min."*

Botão **"Marcar como justificado"** com campo de observação — vira histórico de auditoria.

---

## 4. Modelo de dados

**Armazena tudo, sempre.** Cada dia-máquina analisado gera uma linha, mesmo quando não há discrepância. Isso permite distinguir explicitamente entre "dia OK" e "dia não analisado".

```sql
CREATE TABLE analise_dia_maquina (
    id INT AUTO_INCREMENT PRIMARY KEY,
    obra_id VARCHAR(36) NULL,
    data DATE NOT NULL,
    vehicle_id VARCHAR(36) NOT NULL,
    employee_id INT NULL,                     -- só quando o ponto existir
    discrepancias_json JSON NOT NULL,         -- [] = dia OK, senão lista
    maior_magnitude_min INT NOT NULL DEFAULT 0, -- 0 se OK, senão maior gap detectado (índice de ordenação)
    fontes_disponiveis_json JSON NOT NULL,    -- { faturado:bool, rastreador:bool, ponto:bool }
    faturado_intervalos_json JSON NULL,
    rastreador_intervalos_json JSON NULL,
    ponto_intervalos_json JSON NULL,
    justificado_em DATETIME NULL,
    justificado_por INT NULL,
    justificativa TEXT NULL,
    gerado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    obra_key VARCHAR(36) GENERATED ALWAYS AS (COALESCE(obra_id,'__none__')) STORED,
    UNIQUE KEY uk_placa_data_obra (vehicle_id, data, obra_key),
    INDEX idx_obra_data (obra_id, data),
    INDEX idx_magnitude (maior_magnitude_min, data),
    INDEX idx_employee (employee_id, data)
);
```

**Cada item em `discrepancias_json`:**
```json
{
  "tipo": "maquina_alem_do_faturado",
  "magnitude_min": 180,
  "intervalos_envolvidos": [{ "inicio": "...", "fim": "..." }]
}
```

**Tipos de discrepância:**

| Tipo | Disponível em | Significado |
|---|---|---|
| `maquina_alem_do_faturado` | Fase 1 | Rastreador ativo fora de qualquer janela faturada |
| `faturado_alem_da_maquina` | Fase 1 | Janela faturada sem atividade equivalente no rastreador |
| `sem_lancamento_com_atividade` | Fase 1 | Dia inteiro com atividade sem nenhum lançamento |
| `gap_ponto_maquina_inicio` | Fase 2 (após ponto) | Operador presente, máquina ainda desligada no início |
| `gap_ponto_maquina_fim` | Fase 2 (após ponto) | Máquina parou antes do operador sair |

**Limiar de magnitude pra entrar no JSON:** parâmetro `ANALISE_LIMIAR_MIN` (default 30 min). Gaps menores são ruído operacional e ficam de fora.

---

## 5. Endpoints

| Rota | Função |
|---|---|
| `GET /api/analise-gerencial/discrepancias/obras` | Tela 1 — cards de obras com totais agregados |
| `GET /api/analise-gerencial/discrepancias/obra/:obraId` | Tela 2 — KPIs, ranking e lista da obra |
| `GET /api/analise-gerencial/discrepancias/:id` | Tela 3 — detalhe completo + narrativa |
| `POST /api/analise-gerencial/discrepancias/:id/justificar` | Marca como justificado, com observação |
| `POST /api/analise-gerencial/discrepancias/reprocessar` | Recálculo manual de período |

---

## 6. Arquitetura de arquivos

```
back_desenvolvimento/
├── migrations/
│   └── create_analise_dia_maquina.sql
├── services/
│   └── discrepanciaService.js              ← substitui confrontoService
├── controllers/
│   └── analiseGerencialController.js
├── routes/
│   └── analiseGerencialRoutes.js
└── scripts/
    └── backfill_analise_gerencial.js

front_desenvolvimento/src/
├── pages/
│   └── AnaliseGerencialPage.js             ← container com sub-nav
└── components/
    └── analise/
        └── DiscrepanciasOperacionais/
            ├── index.jsx
            ├── ObrasOverview.jsx           ← Tela 1
            ├── ObraDetalhe.jsx             ← Tela 2
            ├── DiscrepanciaDrill.jsx       ← Tela 3
            └── Timeline3Trilhas.jsx
```

---

## 7. Sequência de PRs

### PR 4 — Refactor do backend (sem mexer no front antigo)

- Migration `analise_dia_maquina`
- `discrepanciaService` implementando os 3 tipos da Fase 1:
  - `maquina_alem_do_faturado`
  - `faturado_alem_da_maquina`
  - `sem_lancamento_com_atividade`
- Cron diário substituindo o `processYesterday` do confronto
- Endpoints novos sob `/api/analise-gerencial/...`
- Script de backfill
- **Mantém** a aba "Confronto" antiga viva em paralelo — não quebra produção

### PR 5 — Página Análise Gerencial + sidebar

- `AnaliseGerencialPage` como container com sub-nav lateral interna
- Item no `Sidebar.js` com role-gate
- Registro em `App.js` (`renderPage`, `PAGE_RESOURCE_REQUIREMENTS`)
- **Tela 1** (cards de obras) implementada

### PR 6 — Telas 2 e 3 + remoção da aba antiga

- **Tela 2:** KPIs, ranking, lista priorizada por magnitude
- **Tela 3:** timeline 3 trilhas (ponto fica placeholder com label "aguardando integração"), narrativa em texto, botão "Justificar"
- Remoção da aba "Confronto" do `SigaSulPage`
- Limpeza da tabela `billing_tracker_confronto`

### PR 7 — Integração do ponto (quando o dado existir)

- Adiciona `gap_ponto_maquina_inicio` e `gap_ponto_maquina_fim` no `discrepanciaService`
- Backfill desses tipos no período histórico em que o ponto exista
- Ativa a 3ª trilha na Tela 3
- Sem mudança de UI estrutural — o modelo já tava preparado

### PR 8+ — Outras análises gerenciais (futuro)

- Slots prontos no container.
- Exemplos: Custo Real por Obra, Ranking de Operadores, Consumo vs Horímetro.

---

## 8. Decisões pendentes antes do PR 4

1. **Limiar de magnitude pra entrar no JSON de discrepâncias.** Sugerido 30 min. Aceita ou prefere outro?
2. **Remoção da aba "Confronto" no `SigaSulPage`** — direto no PR 6, ou deixar aviso "→ movido pra Análise Gerencial" por 1–2 semanas antes de remover?
3. **Role de acesso** à Análise Gerencial — só `isAdmin`, ou criar uma flag específica (ex.: `canAccessAnaliseGerencial`) que dá acesso a sócio/gerente sem precisar promover a admin pleno?
4. **Tabela `billing_tracker_confronto`** — dropar no PR 4 junto com a aba antiga, ou deixar dormindo por garantia até depois do PR 6?

---

## 9. Estado atual do trabalho (entregue antes deste replanejamento)

Já em produção/teste sob o modelo antigo, **vai ser substituído** pelos PRs acima:

- `billing_tracker_confronto` (tabela com 5 buckets) — backend funcionando, cron rodando 03:30 BRT, backfill validado em 166 pares no banco de teste.
- Aba "Confronto Faturamento" dentro do `SigaSulPage` — operacional, mas conceitualmente no lugar errado.
- Endpoints `/api/confronto/*` — serão substituídos pelos novos `/api/analise-gerencial/*`.

Esse trabalho **não foi desperdiçado** — a lógica de fusão de intervalos, tolerância, normalização de placa, fallback ignição→velocidade, timeline SVG, tudo isso será reaproveitado integralmente. O que muda é o **enquadramento** (gerencial em vez de rastreador-puro), o **modelo de dados** (linhas com lista de discrepâncias em vez de bucket único) e a **navegação** (funil de 3 telas a partir da obra).

---

## 10. Observações de implementação a carregar pra frente

Coisas que vale lembrar do trabalho anterior:

- `vehicles.placa` é armazenada **sem traço**; `sigasul_positions.pos_placa` vem **com traço**. Normalizar nas duas pontas (já feito no `confrontoService` — copiar pro `discrepanciaService`).
- 55 das 181 placas SigaSul não têm cadastro em `vehicles` — passam em branco. Vale endpoint auxiliar `GET /api/analise-gerencial/placas-orfas` pra acompanhar essa lista.
- Placas como rolos/reboques nunca reportam `pos_ignicao` — fallback automático pra `pos_velocidade > 0` (lógica `detectSignalSource` no `confrontoService`).
- Sync da SigaSul é **D-1** — análise sempre opera sobre "ontem pra trás".
- Edição retroativa de `daily_work_logs` deixa a análise desatualizada até o próximo cron ou clique em "Reprocessar". Avaliar trigger automático no PR 6.
