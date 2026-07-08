const db = require('../database');

// ===================================================================================
// MÓDULO DE PLANEJAMENTO ESTRATÉGICO DE OBRAS
// Regras de negócio (ver PLANO_MODULO_PLANEJAMENTO_OBRAS.md na raiz do workspace):
//  - Capacidade: 175 h/mês por máquina (≈ 5,83 h/dia)
//  - Meta: concluir obras em ≤ 45 dias
//  - Escalonamento: preferir N-1 máquinas até o dia 35 + reforço, quando fecha no prazo
//  - "Terminando": ≥ 70% horas consumidas OU fim previsto/projetado ≤ 15 dias
// ===================================================================================

const DEFAULTS = {
    HORAS_MES_MAQUINA: 175,
    PRAZO_ALVO_DIAS: 45,
    DIA_REFORCO: 35,
    PCT_TERMINANDO: 70,
    DIAS_TERMINANDO: 15,
    JANELA_BALANCO_DIAS: 60,
};

const PRE_ACTIVE = ['radar', 'planejada', 'mobilizacao'];

const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

// Dimensionamento por subgrupo: dado H horas contratadas, quantas máquinas e em
// que regime (constante ou escalonado) para fechar em ≤ PRAZO_ALVO_DIAS.
const dimensionar = (horas, p) => {
    const horasDia = p.HORAS_MES_MAQUINA / 30;
    const capPrazo = horasDia * p.PRAZO_ALVO_DIAS;        // 1 máquina no prazo todo
    const capAteReforco = horasDia * p.DIA_REFORCO;       // 1 máquina até o dia de reforço

    if (!horas || horas <= 0) return null;

    const nMin = Math.ceil(horas / capPrazo);             // mínimo constante que fecha no prazo

    // Testa escalonado com nMin-1 máquinas até DIA_REFORCO, depois nMin
    if (nMin > 1) {
        const entregueAteReforco = (nMin - 1) * capAteReforco;
        const restante = horas - entregueAteReforco;
        if (restante > 0) {
            const diasExtra = restante / (nMin * horasDia);
            const diasTotal = p.DIA_REFORCO + diasExtra;
            if (diasTotal <= p.PRAZO_ALVO_DIAS) {
                return {
                    regime: 'escalonado',
                    maquinasIniciais: nMin - 1,
                    maquinasPico: nMin,
                    diaReforco: p.DIA_REFORCO,
                    diasEstimados: Math.ceil(diasTotal),
                };
            }
        }
    }

    const diasConstante = horas / (nMin * horasDia);
    return {
        regime: 'constante',
        maquinasIniciais: nMin,
        maquinasPico: nMin,
        diaReforco: null,
        diasEstimados: Math.ceil(diasConstante),
        // Termina em menos de metade do prazo → candidata a ceder máquina no meio
        folga: diasConstante < p.PRAZO_ALVO_DIAS / 2,
    };
};

// GET /api/obras/planejamento
// Retorna todas as obras com métricas de planejamento + balanço demanda×oferta por subgrupo.
const getPlanejamento = async (req, res) => {
    try {
        const p = { ...DEFAULTS };
        if (req.query.janelaDias) p.JANELA_BALANCO_DIAS = parseInt(req.query.janelaDias, 10) || DEFAULTS.JANELA_BALANCO_DIAS;

        const [obras] = await db.query(`
            SELECT id, nome, status, tipo_registro, regiao, orgao_contratante, responsavel,
                   contractType, dataInicio, dataFim, dataInicioPrevisto, dataFimPrevisto,
                   origemInfo, confiancaInfo, obsPlanejamento,
                   horasContratadasPorTipo, horasContratadasPorSubTipo
            FROM obras
            WHERE (tipo_registro IS NULL OR tipo_registro = 'obra')
              AND (status != 'finalizada' OR dataFim >= DATE_SUB(NOW(), INTERVAL 30 DAY))
        `);

        // Horas consumidas por obra × subgrupo (fallback: grupo) — apenas obras não-finalizadas pesam
        const [consumo] = await db.query(`
            SELECT l.obraId, COALESCE(NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo,
                   SUM(l.totalHours) AS horas,
                   SUM(CASE WHEN l.date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY) THEN l.totalHours ELSE 0 END) AS horas14d
            FROM daily_work_logs l
            JOIN vehicles v ON v.id = l.vehicleId
            GROUP BY l.obraId, subgrupo
        `);

        // Máquinas atualmente alocadas por obra
        const [alocacoes] = await db.query(`
            SELECT h.obraId, h.veiculoId, h.registroInterno, h.placa, h.modelo, h.dataEntrada,
                   h.employeeName, v.operationalAssignment,
                   COALESCE(NULLIF(v.sub_tipo, ''), v.tipo) AS subgrupo
            FROM obras_historico_veiculos h
            JOIN vehicles v ON v.id = h.veiculoId
            WHERE h.dataSaida IS NULL
        `);

        // Execução por máquina (horas apontadas e último apontamento na obra)
        const [execVeiculos] = await db.query(`
            SELECT obraId, vehicleId, SUM(totalHours) AS horas, MAX(date) AS ultimoApontamento
            FROM daily_work_logs
            GROUP BY obraId, vehicleId
        `);

        // Frota disponível — linha a linha para permitir drill-down no frontend
        const [disponiveis] = await db.query(`
            SELECT id, registroInterno, placa, modelo,
                   COALESCE(NULLIF(sub_tipo, ''), tipo) AS subgrupo
            FROM vehicles
            WHERE status = 'Disponível'
        `);

        const consumoPorObra = {};
        consumo.forEach(r => {
            (consumoPorObra[r.obraId] = consumoPorObra[r.obraId] || []).push(r);
        });
        const execPorObraVeiculo = {};
        execVeiculos.forEach(r => { execPorObraVeiculo[`${r.obraId}|${r.vehicleId}`] = r; });

        const alocPorObra = {};
        alocacoes.forEach(r => {
            const exec = execPorObraVeiculo[`${r.obraId}|${r.veiculoId}`];
            const nextMission = parseJson(r.operationalAssignment)?.next_mission || {};
            (alocPorObra[r.obraId] = alocPorObra[r.obraId] || []).push({
                obraId: r.obraId,
                veiculoId: r.veiculoId,
                registroInterno: r.registroInterno,
                placa: r.placa,
                modelo: r.modelo,
                dataEntrada: r.dataEntrada,
                subgrupo: r.subgrupo,
                employeeName: r.employeeName || null,
                horasApontadas: exec ? (parseFloat(exec.horas) || 0) : 0,
                ultimoApontamento: exec ? exec.ultimoApontamento : null,
                previsaoLiberacao: nextMission.release_date || null,
                liberacaoManual: !!nextMission.release_date,
            });
        });

        const hoje = new Date();
        const emDias = (d) => d ? Math.round((new Date(d) - hoje) / 86400000) : null;

        const result = obras.map(o => {
            const planoSub = parseJson(o.horasContratadasPorSubTipo);
            const planoTipo = parseJson(o.horasContratadasPorTipo);
            const plano = (planoSub && Object.keys(planoSub).length > 0) ? planoSub : (planoTipo || {});
            const planoNivelGrupo = !(planoSub && Object.keys(planoSub).length > 0) && !!planoTipo && Object.keys(planoTipo).length > 0;

            const totalContratado = Object.values(plano).reduce((s, h) => s + (parseFloat(h) || 0), 0);

            const linhasConsumo = consumoPorObra[o.id] || [];
            const consumidoPorSubgrupo = {};
            let totalConsumido = 0, horas14d = 0;
            linhasConsumo.forEach(r => {
                consumidoPorSubgrupo[r.subgrupo] = parseFloat(r.horas) || 0;
                totalConsumido += parseFloat(r.horas) || 0;
                horas14d += parseFloat(r.horas14d) || 0;
            });

            const pctConsumido = totalContratado > 0 ? (totalConsumido / totalContratado) * 100 : null;

            // Projeção de término pelo ritmo dos últimos 14 dias
            const ritmoDia = horas14d / 14;
            const horasRestantes = Math.max(totalContratado - totalConsumido, 0);
            const diasProjetados = (o.status === 'ativa' && ritmoDia > 0 && totalContratado > 0)
                ? Math.ceil(horasRestantes / ritmoDia)
                : null;

            // Perfil de demanda (obras pré-ativas): dimensionamento por subgrupo
            let perfilDemanda = null;
            if (PRE_ACTIVE.includes(o.status)) {
                perfilDemanda = Object.entries(plano)
                    .map(([subgrupo, horas]) => {
                        const dim = dimensionar(parseFloat(horas) || 0, p);
                        return dim ? { subgrupo, horasContratadas: parseFloat(horas), ...dim } : null;
                    })
                    .filter(Boolean);
            }

            // Cobertura dinâmica (obras ativas): quantas máquinas o restante do contrato
            // ainda exige, redimensionando as horas que faltam por subgrupo.
            let necessidadeAtual = null;
            if (o.status === 'ativa' && o.contractType === 'horas' && totalContratado > 0) {
                necessidadeAtual = Object.entries(plano).map(([subgrupo, horas]) => {
                    const restante = Math.max((parseFloat(horas) || 0) - (consumidoPorSubgrupo[subgrupo] || 0), 0);
                    const dim = dimensionar(restante, p);
                    return {
                        subgrupo,
                        horasRestantes: Math.round(restante * 10) / 10,
                        maquinasNecessarias: dim ? dim.maquinasPico : 0,
                        diasEstimados: dim ? dim.diasEstimados : 0,
                        regime: dim ? dim.regime : 'concluido',
                    };
                });
            }

            // Critério "Terminando" (apenas ativas)
            const diasParaFimPrevisto = emDias(o.dataFimPrevisto);
            const terminando = o.status === 'ativa' && (
                (pctConsumido != null && pctConsumido >= p.PCT_TERMINANDO) ||
                (diasParaFimPrevisto != null && diasParaFimPrevisto <= p.DIAS_TERMINANDO) ||
                (diasProjetados != null && diasProjetados <= p.DIAS_TERMINANDO)
            );

            // Faixa de evolução física (colunas computadas do Kanban)
            let faixa = null;
            if (o.status === 'ativa' && pctConsumido != null) {
                faixa = pctConsumido < 30 ? '0-30' : pctConsumido < 70 ? '30-70' : '70-100';
            }

            return {
                id: o.id, nome: o.nome, status: o.status, regiao: o.regiao,
                orgao_contratante: o.orgao_contratante, responsavel: o.responsavel,
                contractType: o.contractType,
                dataInicio: o.dataInicio, dataFim: o.dataFim,
                dataInicioPrevisto: o.dataInicioPrevisto, dataFimPrevisto: o.dataFimPrevisto,
                origemInfo: o.origemInfo, confiancaInfo: o.confiancaInfo, obsPlanejamento: o.obsPlanejamento,
                plano, planoNivelGrupo, totalContratado,
                consumidoPorSubgrupo, totalConsumido,
                pctConsumido: pctConsumido != null ? Math.round(pctConsumido * 10) / 10 : null,
                ritmoDia: Math.round(ritmoDia * 10) / 10,
                diasProjetados, terminando, faixa,
                maquinasAlocadas: alocPorObra[o.id] || [],
                perfilDemanda, necessidadeAtual,
            };
        });

        // ── Balanço demanda × oferta por subgrupo (janela) ──
        const janela = p.JANELA_BALANCO_DIAS;
        const balanco = {};
        const entry = (sg) => (balanco[sg] = balanco[sg] || {
            subgrupo: sg, demanda: 0, liberando: 0, disponiveis: 0,
            demandaObras: [], liberandoVeiculos: [], disponiveisVeiculos: [],
        });

        result.forEach(o => {
            // Demanda: obras pré-ativas que começam dentro da janela (sem data prevista = incluída)
            if (PRE_ACTIVE.includes(o.status) && o.perfilDemanda) {
                const dias = emDias(o.dataInicioPrevisto);
                if (dias == null || dias <= janela) {
                    // Mobilização já tem máquinas no canteiro — abate da demanda para não contar dobrado
                    const jaAlocadas = {};
                    (o.maquinasAlocadas || []).forEach(m => { jaAlocadas[m.subgrupo] = (jaAlocadas[m.subgrupo] || 0) + 1; });
                    o.perfilDemanda.forEach(d => {
                        const falta = Math.max(d.maquinasPico - (jaAlocadas[d.subgrupo] || 0), 0);
                        if (falta === 0) return;
                        const e = entry(d.subgrupo);
                        e.demanda += falta;
                        e.demandaObras.push({ obraNome: o.nome, maquinas: falta, inicioPrevisto: o.dataInicioPrevisto });
                    });
                }
            }
            // Oferta: máquinas em obras "terminando" — guardamos onde cada uma está hoje
            if (o.terminando) {
                o.maquinasAlocadas.forEach(m => {
                    const e = entry(m.subgrupo);
                    e.liberando += 1;
                    e.liberandoVeiculos.push({
                        veiculoId: m.veiculoId, registroInterno: m.registroInterno,
                        placa: m.placa, modelo: m.modelo, obraNome: o.nome, regiao: o.regiao,
                    });
                });
            }
        });
        disponiveis.forEach(v => {
            const e = entry(v.subgrupo);
            e.disponiveis += 1;
            e.disponiveisVeiculos.push({ veiculoId: v.id, registroInterno: v.registroInterno, placa: v.placa, modelo: v.modelo });
        });

        const balancoArr = Object.values(balanco)
            .map(b => ({ ...b, saldo: b.liberando + b.disponiveis - b.demanda }))
            .filter(b => b.demanda > 0 || b.liberando > 0)
            .sort((a, b) => a.saldo - b.saldo);

        res.json({ params: p, obras: result, balanco: balancoArr });
    } catch (error) {
        console.error('Erro no planejamento de obras:', error);
        res.status(500).json({ error: 'Erro ao montar planejamento.', details: error.message });
    }
};

module.exports = { getPlanejamento, dimensionar, DEFAULTS };
