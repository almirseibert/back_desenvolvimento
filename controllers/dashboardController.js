const db = require('../database');
const { _computeAnalyticsCore, _fmtDate } = require('./obraSupervisorController');

const HORAS_PADRAO_DIA = 8;
const FUEL_LIMIT_PCT = 20;

const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
};

const safeQuery = async (sql, params = []) => {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (e) {
        console.warn('[dashboard] query falhou, devolvendo vazio:', e.code || e.message);
        return [];
    }
};

const classifyAproveitamento = (pct) => {
    if (pct >= 70) return 'verde';
    if (pct >= 40) return 'amarelo';
    return 'vermelho';
};

// Calcula projeção leve por obra a partir de logs e abastecimentos já agregados.
// Não chama getProjecaoObra para evitar custo de 10+ requisições; cobre só os
// campos que a home consome (combustível %, dias para finalizar, % concluído).
const computeProjecoesLeves = async (obraIds) => {
    if (!obraIds.length) return new Map();

    const placeholders = obraIds.map(() => '?').join(',');

    const obras = await safeQuery(
        `SELECT id, nome, horasContratadasPorTipo, valoresPorTipo
           FROM obras WHERE id IN (${placeholders})`,
        obraIds
    );

    const logs = await safeQuery(`
        SELECT l.obraId, v.tipo AS tipo_veiculo,
               SUM(l.totalHours) AS horas,
               MIN(DATE_FORMAT(l.date, '%Y-%m-%d')) AS primeira_data,
               COUNT(DISTINCT DATE(l.date)) AS dias_lancamento
          FROM daily_work_logs l
          LEFT JOIN vehicles v ON v.id = l.vehicleId
         WHERE l.obraId IN (${placeholders})
         GROUP BY l.obraId, tipo_veiculo
    `, obraIds);

    const refuels = await safeQuery(`
        SELECT obraId,
               COALESCE(SUM(litrosLiberados * pricePerLiter), 0) AS custo
          FROM refuelings
         WHERE obraId IN (${placeholders})
           AND litrosLiberados IS NOT NULL
           AND pricePerLiter IS NOT NULL
         GROUP BY obraId
    `, obraIds);
    const custoCombustivelPorObra = new Map(refuels.map(r => [String(r.obraId), parseFloat(r.custo) || 0]));

    const logsPorObra = new Map();
    for (const r of logs) {
        const key = String(r.obraId);
        if (!logsPorObra.has(key)) logsPorObra.set(key, { totalHoras: 0, faturamento: 0, diasLancamento: 0, primeiraData: null, porTipo: [] });
        const entry = logsPorObra.get(key);
        entry.porTipo.push(r);
        entry.totalHoras += parseFloat(r.horas) || 0;
        entry.diasLancamento = Math.max(entry.diasLancamento, parseInt(r.dias_lancamento, 10) || 0);
        if (!entry.primeiraData || (r.primeira_data && r.primeira_data < entry.primeiraData)) {
            entry.primeiraData = r.primeira_data;
        }
    }

    const out = new Map();
    for (const obra of obras) {
        const key = String(obra.id);
        let horasContratadasPorTipo = {};
        let valoresPorTipo = {};
        try { horasContratadasPorTipo = obra.horasContratadasPorTipo ? (typeof obra.horasContratadasPorTipo === 'string' ? JSON.parse(obra.horasContratadasPorTipo) : obra.horasContratadasPorTipo) : {}; } catch {}
        try { valoresPorTipo = obra.valoresPorTipo ? (typeof obra.valoresPorTipo === 'string' ? JSON.parse(obra.valoresPorTipo) : obra.valoresPorTipo) : {}; } catch {}

        const horasContratadas = Object.values(horasContratadasPorTipo).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        const entry = logsPorObra.get(key) || { totalHoras: 0, diasLancamento: 0, porTipo: [] };

        let faturamento = 0;
        for (const t of entry.porTipo) {
            const preco = parseFloat(valoresPorTipo[t.tipo_veiculo] || valoresPorTipo[(t.tipo_veiculo || '').trim()] || 0);
            faturamento += (parseFloat(t.horas) || 0) * preco;
        }

        const percentConcluido = horasContratadas > 0 ? (entry.totalHoras / horasContratadas) * 100 : 0;
        const ritmoHorasPorDia = entry.diasLancamento > 0 ? entry.totalHoras / entry.diasLancamento : 0;
        const horasRestantes = Math.max(0, horasContratadas - entry.totalHoras);
        const diasParaFinalizar = ritmoHorasPorDia > 0 ? Math.ceil(horasRestantes / ritmoHorasPorDia) : null;

        const custoCombust = custoCombustivelPorObra.get(key) || 0;
        const percentCombust = faturamento > 0 ? (custoCombust / faturamento) * 100 : 0;
        const projecaoFinalPercent = percentConcluido > 1
            ? (percentCombust / percentConcluido) * 100
            : percentCombust;

        out.set(key, {
            nome: obra.nome,
            horasContratadas,
            percentConcluido: Math.round(percentConcluido * 10) / 10,
            ritmoHorasPorDia: Math.round(ritmoHorasPorDia * 10) / 10,
            diasParaFinalizar,
            faturamento,
            custoCombust,
            percentCombust: Math.round(percentCombust * 10) / 10,
            projecaoFinalPercent: Math.round(projecaoFinalPercent * 10) / 10,
        });
    }
    return out;
};

const buildLinhaResumo = (proj, aproveitamentoPct) => {
    const parts = [];
    if (proj.projecaoFinalPercent > FUEL_LIMIT_PCT) {
        parts.push(`combustível projetado ${proj.projecaoFinalPercent.toLocaleString('pt-BR')}%`);
    }
    if (proj.diasParaFinalizar !== null && proj.percentConcluido >= 70 && proj.diasParaFinalizar <= 15) {
        parts.push(`estima término em ${proj.diasParaFinalizar}d (${proj.percentConcluido}%)`);
    } else if (proj.percentConcluido >= 100) {
        parts.push('escopo atingido — revisar fechamento');
    }
    if (aproveitamentoPct >= 80 && parts.length === 0) {
        parts.push(`aproveitamento ${Math.round(aproveitamentoPct)}% no período`);
    }
    if (parts.length === 0) {
        parts.push(`${Math.round(proj.percentConcluido)}% concluída · ritmo ${proj.ritmoHorasPorDia.toLocaleString('pt-BR')} h/dia`);
    }
    return parts.join(' · ');
};

exports.getHomeSummary = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(12, 0, 0, 0);

        // Janela consolidada: últimos 30d com buffer 7d (today-37 → today-7)
        const endConsolidated = addDays(today, -7);
        const startConsolidated = addDays(endConsolidated, -29);

        // Janela do pulso diário: últimos 14 dias corridos (não úteis) até hoje
        const endPulse = today;
        const startPulse = addDays(today, -13);

        const analytics = await _computeAnalyticsCore(
            'geral',
            _fmtDate(startConsolidated),
            _fmtDate(endConsolidated)
        );

        // Período anterior (mesmo comprimento) para delta de aproveitamento
        const prevEnd = addDays(startConsolidated, -1);
        const prevStart = addDays(prevEnd, -29);
        const analyticsPrev = await _computeAnalyticsCore(
            'geral',
            _fmtDate(prevStart),
            _fmtDate(prevEnd)
        );

        const veiculosTrabalharam = await safeQuery(`
            SELECT COUNT(DISTINCT vehicleId) AS qtd
              FROM daily_work_logs
             WHERE date BETWEEN ? AND ?
               AND totalHours > 0
        `, [_fmtDate(startConsolidated), _fmtDate(endConsolidated)]);
        const qtdTrabalharam = parseInt(veiculosTrabalharam[0]?.qtd || 0, 10);

        // Projeções leves para todas as obras com atividade no período
        const obraIdsAtivos = (analytics.porObra || []).map(o => o.obraId).filter(Boolean);
        const projecoes = await computeProjecoesLeves(obraIdsAtivos);

        const obrasAnalisadas = (analytics.porObra || []).map(o => {
            const proj = projecoes.get(String(o.obraId)) || {};
            const emRisco = (proj.projecaoFinalPercent || 0) > FUEL_LIMIT_PCT
                         || (proj.diasParaFinalizar !== null && proj.diasParaFinalizar > 60 && proj.percentConcluido < 50);
            return {
                obraId: o.obraId,
                obraNome: o.obraNome,
                aproveitamento: Math.round(o.aproveitamento * 10) / 10,
                horasExecutadas: Math.round(o.horas_executadas * 10) / 10,
                qtdVeiculos: o.qtdVeiculos,
                percentConcluido: proj.percentConcluido ?? null,
                ritmoHorasPorDia: proj.ritmoHorasPorDia ?? null,
                diasParaFinalizar: proj.diasParaFinalizar ?? null,
                projecaoFinalCombustivel: proj.projecaoFinalPercent ?? null,
                emRisco,
            };
        });

        // Combustível/Receita agregado de todas as obras analisadas
        let faturamentoTotal = 0;
        let custoCombustTotal = 0;
        for (const id of obraIdsAtivos) {
            const p = projecoes.get(String(id));
            if (p) {
                faturamentoTotal += p.faturamento;
                custoCombustTotal += p.custoCombust;
            }
        }
        const fuelPct = faturamentoTotal > 0 ? (custoCombustTotal / faturamentoTotal) * 100 : 0;

        // Obras em foco: 3 piores aproveitamentos + 2 melhores (mesmo critério visual do mockup)
        const ordenadoPiorMelhor = [...obrasAnalisadas].sort((a, b) => a.aproveitamento - b.aproveitamento);
        const criticas = ordenadoPiorMelhor.slice(0, 3).map(o => ({
            ...o,
            status: classifyAproveitamento(o.aproveitamento),
            linhaResumo: buildLinhaResumo({
                projecaoFinalPercent: o.projecaoFinalCombustivel || 0,
                diasParaFinalizar: o.diasParaFinalizar,
                percentConcluido: o.percentConcluido || 0,
                ritmoHorasPorDia: o.ritmoHorasPorDia || 0,
            }, o.aproveitamento),
        }));
        const destaques = ordenadoPiorMelhor.slice(-2).reverse().map(o => ({
            ...o,
            status: 'verde',
            linhaResumo: buildLinhaResumo({
                projecaoFinalPercent: o.projecaoFinalCombustivel || 0,
                diasParaFinalizar: o.diasParaFinalizar,
                percentConcluido: o.percentConcluido || 0,
                ritmoHorasPorDia: o.ritmoHorasPorDia || 0,
            }, o.aproveitamento),
        }));

        const obrasEmFoco = [...criticas, ...destaques];

        // Ranking: top 5 melhores (por aproveitamento DESC) e bottom 5 (ASC)
        const top = [...obrasAnalisadas]
            .sort((a, b) => b.aproveitamento - a.aproveitamento)
            .slice(0, 5)
            .map(o => ({ obraId: o.obraId, nome: o.obraNome, aproveitamento: o.aproveitamento }));
        const atencao = [...obrasAnalisadas]
            .sort((a, b) => a.aproveitamento - b.aproveitamento)
            .slice(0, 5)
            .map(o => ({ obraId: o.obraId, nome: o.obraNome, aproveitamento: o.aproveitamento, classe: classifyAproveitamento(o.aproveitamento) }));

        // Pulso diário: horas/dia nos últimos 14 dias. Marca quais estão "em consolidação" (após endConsolidated).
        const pulseRows = await safeQuery(`
            SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, SUM(totalHours) AS h
              FROM daily_work_logs
             WHERE date BETWEEN ? AND ?
             GROUP BY d
             ORDER BY d
        `, [_fmtDate(startPulse), _fmtDate(endPulse)]);
        const pulseMap = new Map(pulseRows.map(r => [r.d, parseFloat(r.h) || 0]));
        const consolidatedEndStr = _fmtDate(endConsolidated);
        const pulseDays = [];
        for (let i = 0; i < 14; i++) {
            const d = addDays(startPulse, i);
            const dStr = _fmtDate(d);
            pulseDays.push({
                date: dStr,
                horas: Math.round((pulseMap.get(dStr) || 0) * 10) / 10,
                emConsolidacao: dStr > consolidatedEndStr,
            });
        }

        // Alertas (queries leves, defensivas — devolvem 0 se a tabela não existir)
        const [solicitRows, revisRows, finesRows] = await Promise.all([
            safeQuery(`SELECT COUNT(*) c FROM solicitacoes_abastecimento WHERE status = 'PENDENTE'`),
            safeQuery(`SELECT COUNT(*) c FROM revisions WHERE proximaRevisaoData IS NOT NULL AND proximaRevisaoData < CURDATE()`),
            safeQuery(`
                SELECT COUNT(*) c,
                       COALESCE(SUM(valor), 0) v
                  FROM fines
                 WHERE LOWER(COALESCE(paymentStatus, '')) NOT IN ('pago', 'paid', 'quitado')
            `),
        ]);

        const obrasEscopoEstourar = obrasAnalisadas.filter(o =>
            o.percentConcluido !== null
            && o.percentConcluido >= 85
            && o.percentConcluido < 100
        ).length;

        const aproveitamentoAtual = analytics.summary.aproveitamento || 0;
        const aproveitamentoAnterior = analyticsPrev.summary.aproveitamento || 0;
        const fuelPctPrev = (() => {
            // delta de combustível/receita: refazendo o cálculo no período anterior seria custoso —
            // devolvemos 0 e marcamos como não disponível para a primeira versão.
            return null;
        })();

        const obrasEmRisco = obrasAnalisadas.filter(o => o.emRisco).length;

        res.json({
            generatedAt: today.toISOString(),
            period: {
                start: _fmtDate(startConsolidated),
                end: _fmtDate(endConsolidated),
                consolidatedUntil: _fmtDate(endConsolidated),
            },
            kpis: {
                aproveitamento: {
                    value: Math.round(aproveitamentoAtual * 10) / 10,
                    deltaPp: Math.round((aproveitamentoAtual - aproveitamentoAnterior) * 10) / 10,
                },
                veiculosAtivos: {
                    trabalharam: qtdTrabalharam,
                    total: analytics.summary.qtdVeiculos,
                },
                combustivelReceita: {
                    value: Math.round(fuelPct * 10) / 10,
                    deltaPp: fuelPctPrev,
                    limit: FUEL_LIMIT_PCT,
                },
                obrasEmRisco,
            },
            obrasEmFoco,
            ranking: { top, atencao },
            pulse: {
                consolidatedEnd: consolidatedEndStr,
                days: pulseDays,
            },
            alerts: {
                solicitacoesPendentes: parseInt(solicitRows[0]?.c || 0, 10),
                revisoesVencidas: parseInt(revisRows[0]?.c || 0, 10),
                obrasEscopoEstourar,
                multasPendentes: {
                    count: parseInt(finesRows[0]?.c || 0, 10),
                    valor: parseFloat(finesRows[0]?.v || 0),
                },
            },
        });
    } catch (error) {
        console.error('❌ Erro em /dashboard/home-summary:', error);
        res.status(500).json({ error: error.message });
    }
};
