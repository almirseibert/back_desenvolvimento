# Confronto Faturamento × Rastreador (SigaSul)

Proposta de substituição da atual página de "Confronto" por um modelo de conciliação baseado em **intervalos de atividade** da máquina, e não em soma de horas.

---

## 1. Problema

O confronto atual compara o **total de horas** lançadas no faturamento com o **total de horas do horímetro/rastreador**. Esse modelo é estruturalmente errado para a operação da MAK:

- Em obra, uma máquina frequentemente fica **parada com motor ligado**, esperando outra operar, e depois volta à atividade. Isso aparece como hora trabalhada no rastreador, mas não é hora produtiva.
- Por outro lado, o que realmente queremos detectar são dois cenários:
  1. **Atividade fora da janela lançada** — ex.: lançamento de 08h às 15h, mas a máquina teve horímetro depois das 15h.
  2. **Atividade sem nenhum lançamento** — máquina operou no dia e não há linha de faturamento correspondente.

Comparar somas mascara os dois cenários. Comparar **intervalos** os expõe.

---

## 2. Fontes de dados disponíveis

Tabelas relevantes no banco:

| Tabela | Papel no confronto |
|---|---|
| `daily_work_logs` | Lançamentos manuais de faturamento. Campos-chave: `vehicleId`, `date`, `morningStart/End`, `afternoonStart/End`, `obraId`. |
| `vehicles` | Liga `vehicleId` ↔ `placa` (chave de match com SigaSul). |
| `sigasul_positions` | Posições históricas com `pos_ignicao` (0/1) e `pos_velocidade`. **Fonte primária do confronto.** |
| `sigasul_journeys` | Jornada do motorista (data_inicial/data_final). Usável como contexto, não como sinal de atividade. |
| `sigasul_journey_events` | Apenas 3 tipos no banco real ("Início de jornada", "Fim de jornada", "Direção"). Insuficiente como sinal de atividade da máquina. |
| `sigasul_daily_summary` | Soma diária — útil pra atalhos, mas não serve sozinha porque o caso de uso é *quando*, não *quanto*. |

### Descobertas da análise do banco de produção

- **Densidade de posições:** ~1 ponto a cada 30–60s, 1.500–2.700 pontos/placa/dia. Resolução mais que suficiente para reconstruir intervalos de atividade.
- **Cobertura:** 181 placas com dados, retenção atual de ~14 dias (a migration prevê 90 — vale conferir o cron de limpeza).
- **Pegadinha:** algumas placas (ex.: rolos, reboques, carretas) reportam pontos mas **nunca** ignição ligada. Precisam de fallback por `pos_velocidade`.
- **Sync da SigaSul é D-1** (cron diário às 02:00). O confronto sempre opera sobre "ontem pra trás" — adequado para fechamento de faturamento.

---

## 3. Estratégia de confronto

### Chave de match
`vehicles.placa` ↔ `sigasul_positions.pos_placa` + igualdade de `data`.

### Sinal de atividade do rastreador
Por padrão `pos_ignicao = 1`. Para placas cujo histórico nunca apresenta ignição ligada (`MAX(pos_ignicao) = 0`), cair em fallback de `pos_velocidade > 0`. A fonte usada fica registrada por linha de confronto (`fonte_sinal`).

### Construção dos intervalos

**Do rastreador:** agrupar pontos consecutivos de atividade, fundindo gaps ≤ **15 min** (parâmetro `MERGE_GAP_MIN`). Isso elimina o ruído de "máquina desligou 5 min entre uma operação e outra" sem mascarar pausas reais.

**Do faturamento:** até 2 intervalos por dia — `[morningStart, morningEnd]` e `[afternoonStart, afternoonEnd]`.

### Tolerância de borda
**±10 min** (parâmetro `EDGE_TOLERANCE_MIN`) para considerar que atividade próxima do início/fim da janela está "dentro".

### Mínimo significativo
**15 min** (parâmetro `MIN_ACTIVITY_MIN`) de atividade para disparar os buckets de problema. Atividade abaixo disso é considerada ruído.

### Buckets de classificação

| Bucket | Regra | Significado |
|---|---|---|
| `ok` | Toda atividade do rastreador cai dentro de algum intervalo lançado (± tolerância) | Caso normal — colapsado por padrão na UI |
| `atividade_fora_janela` | Há ≥ 15 min de atividade do rastreador fora de qualquer intervalo lançado | **Caso principal:** trabalho não declarado no faturamento |
| `sem_lancamento` | Há ≥ 15 min de atividade e **não existe linha** em `daily_work_logs` para a placa+data | Pior caso — dia inteiro de trabalho não faturado |
| `lancamento_sem_rastreio` | Há lançamento mas nenhuma atividade no rastreador | Possível lançamento errado, rastreador offline ou veículo sem telemetria |
| `sem_dados_rastreador` | Sem posições para a placa no dia | Neutro — não conclui nada |

---

## 4. Modelo de dados

Tabela materializada, atualizada via job + endpoint de reprocessamento manual:

```sql
CREATE TABLE billing_tracker_confronto (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vehicle_id VARCHAR(36) NOT NULL,
  placa VARCHAR(20) NOT NULL,
  data DATE NOT NULL,
  obra_id VARCHAR(36) NULL,
  daily_log_id VARCHAR(36) NULL,
  bucket ENUM(
    'ok',
    'atividade_fora_janela',
    'sem_lancamento',
    'lancamento_sem_rastreio',
    'sem_dados_rastreador'
  ) NOT NULL,
  minutos_atividade_total INT DEFAULT 0,
  minutos_dentro_janela INT DEFAULT 0,
  minutos_fora_janela INT DEFAULT 0,
  intervalos_rastreador_json JSON NULL,
  intervalos_lancados_json JSON NULL,
  fonte_sinal ENUM('ignicao','velocidade') DEFAULT 'ignicao',
  gerado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_placa_data (placa, data),
  INDEX idx_bucket_data (bucket, data),
  INDEX idx_obra_data (obra_id, data)
);
```

**Por que materializar (e não calcular on-the-fly):**
- Lançamentos de `daily_work_logs` são editados retroativamente com frequência.
- Precisamos congelar o estado de confronto a cada fechamento de faturamento, para auditoria.
- Telas com filtros amplos ficariam lentas se reprocessadas a cada request.

O `intervalos_*_json` guarda os intervalos calculados (formato `[{inicio, fim}, ...]`) para a UI desenhar a timeline sem reprocessar.

---

## 5. Endpoints

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/confronto/reprocessar` | Body `{ startDate, endDate, vehicleIds? }`. Limpa e regrava o período. Idempotente. |
| `GET` | `/api/confronto` | Query `obraId, startDate, endDate, bucket?`. Lista paginada para a tela principal. |
| `GET` | `/api/confronto/:placa/:data` | Detalhe completo com os JSONs de intervalos para renderizar a timeline. |

---

## 6. Cron automático

Adicionar uma rotina no `sigasulSyncService` (ou serviço próprio) que roda diariamente após o `syncPositions` D-1, processando o dia anterior para todas as placas com posições. Tempo estimado: poucos segundos por dia para 181 placas.

---

## 7. Página nova (substitui a atual)

- **Filtros:** obra, período, bucket, placa.
- **Cards no topo:** contagem por bucket no período filtrado.
- **Lista agrupada por bucket:** problemáticos abertos, `ok` colapsado.
- **Detalhe de cada linha:** timeline visual de 24h com duas faixas sobrepostas (lançamento vs. rastreador), trechos "fora da janela" destacados em vermelho. Resolve em segundos a pergunta "onde está a divergência?".
- **Ações:** botão "Reprocessar período" e link direto para editar o `daily_work_log` correspondente.

A página atual de "Confronto" é removida após essa entrar no ar.

---

## 8. Plano de execução (3 PRs)

### PR 1 — Backend de cálculo
- Migration `billing_tracker_confronto`.
- Serviço `confrontoService.js`: funções puras de fusão de intervalos, tolerância, classificação em buckets.
- Script `scripts/backfill_confronto.js` para popular histórico inicial.
- **Testável via script, zero impacto em UI.**

### PR 2 — Endpoints + reprocessamento manual
- Controller e rotas `/api/confronto/*`.
- Endpoint de reprocessar período.
- Página antiga de Confronto continua viva temporariamente.

### PR 3 — UI nova + cron diário
- Página nova de Confronto no front, com timeline visual.
- Cron diário processando D-1 automaticamente após o sync de posições.
- Remoção da página antiga.

---

## 9. Parâmetros consolidados

| Parâmetro | Valor | Descrição |
|---|---|---|
| `MERGE_GAP_MIN` | 15 min | Gap máximo para fundir dois intervalos consecutivos de atividade |
| `EDGE_TOLERANCE_MIN` | 10 min | Tolerância de borda da janela lançada |
| `MIN_ACTIVITY_MIN` | 15 min | Mínimo de atividade para classificar como problema |

Todos parametrizáveis via `.env` ou tabela de configuração, para ajuste fino sem deploy.

---

## 10. Pontos em aberto para alinhar

1. **Retenção de `sigasul_positions`** — a migration prevê 90 dias mas o banco tem ~14. Confirmar se o cron de retenção está rodando como esperado, já que o confronto histórico depende disso.
2. **Placas sem ignição** — confirmar que o fallback por `pos_velocidade` é aceitável para rolos, reboques e similares, ou se preferimos sinalizar essas placas como "telemetria incompleta" e não confrontá-las.
3. **Confronto multi-obra no mesmo dia** — hoje `daily_work_logs` permite múltiplas linhas (`obraId` diferente) por placa+data. A regra atual da `UNIQUE KEY uk_placa_data` da tabela de confronto consolida tudo numa linha por placa+data. Se for comum a mesma máquina rodar em duas obras no mesmo dia, vale repensar a chave para `(placa, data, obra_id)`.
