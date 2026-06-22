const db = require('../database');

// ==================================================================================
// FUNÇÕES AUXILIARES
// ==================================================================================

const sumLegacyHours = (jsonInput) => {
    if (!jsonInput) return 0;
    try {
        const data = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
        if (typeof data !== 'object' || data === null) return 0;
        return Object.values(data).reduce((acc, curr) => acc + (parseFloat(curr) || 0), 0);
    } catch (e) { return 0; }
};

const addBusinessDays = (startDate, daysToAdd) => {
    let currentDate = new Date(startDate);
    if (isNaN(currentDate.getTime())) currentDate = new Date();
    
    if (daysToAdd > 5000) daysToAdd = 5000; 
    
    let count = 0;
    while (count < daysToAdd) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) count++;
    }
    return currentDate;
};

// ==================================================================================
// CONTROLADORES
// ==================================================================================

exports.getDashboardData = async (req, res) => {
    try {
        // Fase 2.8 — centros de custo NÃO entram em faturamento/dashboard de produtividade
        const [allObras] = await db.query(
            "SELECT * FROM obras WHERE status = 'ativa' AND (tipo_registro IS NULL OR tipo_registro != 'centro_custo') ORDER BY nome ASC"
        );
        
        let contracts = [];
        try { const [r] = await db.query('SELECT * FROM obra_contracts'); contracts = r || []; } catch (e) {}
        const contractMap = {}; contracts.forEach(c => contractMap[c.obra_id] = c);

        const dashboardData = await Promise.all(allObras.map(async (obra) => {
            const obraId = String(obra.id);
            const contract = contractMap[obra.id] || {};
            // Flag de Ocultar/Centro de Custo (is_hidden = 1)
            const isHidden = contract.is_hidden === 1;

            let horasContratadas = parseFloat(contract.total_hours_contracted) || sumLegacyHours(obra.horasContratadasPorTipo);
            let valorTotal = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
            
            const [logs] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [obraId]);
            const horasExecutadas = parseFloat(logs[0]?.total) || 0;
            
            const [expenses] = await db.query('SELECT SUM(amount) as total FROM expenses WHERE obraId = ?', [obraId]);
            const totalGasto = parseFloat(expenses[0]?.total) || 0;

            // --- NOVA LÓGICA DE PREVISÃO (Regra: Máquinas Pesadas * 8h) ---
            // Conta veículos que NÃO são leves/passeio/moto/utilitário
            const [veiculosPesados] = await db.query(`
                SELECT COUNT(id) as qtd 
                FROM vehicles 
                WHERE obraAtualId = ? 
                AND tipo NOT IN ('Leve', 'Passeio', 'Utilitario', 'Moto', 'Administrativo', 'Carro')
            `, [obraId]);

            const numMaquinas = veiculosPesados[0]?.qtd || 0;
            const capacidadeDiariaCanteiro = numMaquinas * 8; // Regra Fixa: 8h por máquina média

            const saldoHoras = horasContratadas - horasExecutadas;
            let diasRestantes = 0;
            let previsaoTermino = null;

            // Só calcula previsão se não estiver oculto e tiver saldo/capacidade
            if (!isHidden && saldoHoras > 0 && capacidadeDiariaCanteiro > 0) {
                diasRestantes = Math.ceil(saldoHoras / capacidadeDiariaCanteiro);
                previsaoTermino = addBusinessDays(new Date(), diasRestantes);
            }

            const percConclusao = horasContratadas > 0 ? (horasExecutadas / horasContratadas) * 100 : 0;
            // Crítico se > 90% concluído OU (menos de 15 dias para acabar E não está oculto)
            const isZonaAditivo = percConclusao >= 90;
            const isPrazoCurto = diasRestantes < 15 && diasRestantes > 0 && !isHidden;

            return {
                id: obraId,
                nome: obra.nome,
                dataInicio: obra.dataInicio, 
                responsavel: contract.responsavel_nome || obra.responsavel || 'A Definir',
                kpi: {
                    ...contract, 
                    valor_total_contrato: valorTotal,
                    total_gasto: totalGasto,
                    horas_contratadas: horasContratadas,
                    horas_executadas: horasExecutadas,
                    percentual_conclusao: parseFloat(percConclusao.toFixed(1)),
                    dias_restantes_estimados: diasRestantes,
                    capacidade_diaria_atual: capacidadeDiariaCanteiro,
                    maquinas_ativas: numMaquinas,
                    status_cor: getStatusColor(percConclusao),
                    // Define prioridade crítica apenas se não for oculto
                    is_critical: !isHidden && (isZonaAditivo || isPrazoCurto),
                    is_hidden: isHidden
                },
                previsao: {
                    data_termino_estimada: previsaoTermino
                }
            };
        }));

        // ORDENAÇÃO AVANÇADA: 
        // 1. Obras Críticas (Aditivo/Prazo Curto) primeiro
        // 2. Obras Normais por Data de Término (Mais próxima primeiro)
        // 3. Obras Ocultas/Centro de Custo por último
        dashboardData.sort((a, b) => {
            if (a.kpi.is_hidden && !b.kpi.is_hidden) return 1;
            if (!a.kpi.is_hidden && b.kpi.is_hidden) return -1;
            if (a.kpi.is_critical && !b.kpi.is_critical) return -1;
            if (!a.kpi.is_critical && b.kpi.is_critical) return 1;
            if (a.previsao.data_termino_estimada && b.previsao.data_termino_estimada) {
                return new Date(a.previsao.data_termino_estimada) - new Date(b.previsao.data_termino_estimada);
            }
            if (a.previsao.data_termino_estimada) return -1;
            if (b.previsao.data_termino_estimada) return 1;
            return 0;
        });
        
        res.json(dashboardData);

    } catch (error) {
        console.error('Erro Dashboard Supervisor:', error);
        res.status(500).json({ message: 'Erro interno.', debug: error.message });
    }
};

exports.getObraDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const [obraRes] = await db.query('SELECT * FROM obras WHERE id = ?', [id]);
        if (!obraRes.length) return res.status(404).json({message: 'Obra não encontrada'});
        const obra = obraRes[0];

        const [contractRes] = await db.query('SELECT * FROM obra_contracts WHERE obra_id = ?', [id]);
        let contract = contractRes[0] || {};
        
        contract.total_value = parseFloat(contract.total_value) || parseFloat(obra.valorTotalContrato) || 0;
        contract.total_hours_contracted = parseFloat(contract.total_hours_contracted) || sumLegacyHours(obra.horasContratadasPorTipo);
        contract.start_date = contract.start_date || obra.dataInicio;

        const [expensesCategory] = await db.query(`SELECT category, SUM(amount) as total FROM expenses WHERE obraId = ? GROUP BY category`, [id]);
        const totalDespesas = expensesCategory.reduce((acc, curr) => acc + parseFloat(curr.total), 0);

        const [recentActivity] = await db.query(`
            SELECT date, SUM(totalHours) as total_dia
            FROM daily_work_logs
            WHERE obraId = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
            GROUP BY date ORDER BY date ASC
        `, [id]);

        let mediaDiariaObra = 0;
        if (recentActivity.length > 0) {
            const somaTotal = recentActivity.reduce((acc, cur) => acc + parseFloat(cur.total_dia), 0);
            mediaDiariaObra = somaTotal / recentActivity.length;
        }

        const [crmHistory] = await db.query(`
            SELECT c.*, u.name as supervisor_name 
            FROM obra_crm_logs c 
            LEFT JOIN users u ON c.user_id = u.id 
            WHERE c.obra_id = ? 
            ORDER BY c.created_at DESC
        `, [id]);

        const [vehicles] = await db.query('SELECT id, placa, modelo, tipo, marca, operationalAssignment FROM vehicles WHERE obraAtualId = ?', [id]);
        
        const machinePredictions = await Promise.all(vehicles.map(async (v) => {
            const [myLogs] = await db.query(`
                SELECT SUM(totalHours) / COUNT(DISTINCT date) as media_individual
                FROM daily_work_logs WHERE vehicleId = ? AND obraId = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
            `, [v.id, id]);
            
            const [totalLogs] = await db.query(`
                SELECT SUM(totalHours) as total_absoluto
                FROM daily_work_logs WHERE vehicleId = ? AND obraId = ?
            `, [v.id, id]);

            const mediaIndividual = parseFloat(myLogs[0]?.media_individual) || 0;
            const totalIndividual = parseFloat(totalLogs[0]?.total_absoluto) || 0;
            
            let nextAllocation = {};
            let operatorName = 'A Definir';
            
            try {
                if (v.operationalAssignment) {
                    const assignment = typeof v.operationalAssignment === 'string' 
                        ? JSON.parse(v.operationalAssignment) 
                        : v.operationalAssignment;
                        
                    nextAllocation = assignment.next_mission || {};
                    if (assignment.employeeName) operatorName = assignment.employeeName;
                    else if (assignment.motorista) operatorName = assignment.motorista;
                }
            } catch (e) {}

            return {
                ...v,
                media_diaria: mediaIndividual,
                total_executado: totalIndividual,
                operador_atual: operatorName, 
                proximo_destino: nextAllocation.location || '',
                data_liberacao_manual: nextAllocation.release_date || null
            };
        }));

        const [totalHoursRes] = await db.query('SELECT SUM(totalHours) as total FROM daily_work_logs WHERE obraId = ?', [id]);
        const horasExecutadas = parseFloat(totalHoursRes[0]?.total) || 0;

        const percExecucaoFisica = contract.total_hours_contracted > 0 ? (horasExecutadas / contract.total_hours_contracted) : 0;
        const valorProduzidoEstimado = percExecucaoFisica * contract.total_value;
        const valorPendenteFaturamento = Math.max(0, valorProduzidoEstimado - totalDespesas);

        // Evolução por quinzena (últimas 6) — horas faturadas e % acumulada sobre o contrato.
        // Janelas fixas de 15 dias ancoradas em contract.start_date (mesma régua do getProjecaoObra,
        // para o Diretor ver os mesmos períodos nas duas telas).
        const quinzenas = [];
        try {
            const [allLogs] = await db.query(`
                SELECT DATE_FORMAT(date, '%Y-%m-%d') AS data_log,
                       SUM(totalHours)               AS horas,
                       vehicleId
                  FROM daily_work_logs
                 WHERE obraId = ?
                 GROUP BY data_log, vehicleId
                 ORDER BY data_log ASC
            `, [id]);

            const horasPorData = {};
            const veiculosPorData = {};
            allLogs.forEach(r => {
                const h = parseFloat(r.horas) || 0;
                horasPorData[r.data_log] = (horasPorData[r.data_log] || 0) + h;
                if (r.vehicleId && h > 0) {
                    if (!veiculosPorData[r.data_log]) veiculosPorData[r.data_log] = new Set();
                    veiculosPorData[r.data_log].add(r.vehicleId);
                }
            });
            const datasOrdenadas = Object.keys(horasPorData);

            // Denominador: máquinas atualmente alocadas na obra (proxy — não considera realocações históricas)
            const [maqRows] = await db.query(
                'SELECT COUNT(*) AS total FROM vehicles WHERE obraAtualId = ?',
                [id]
            );
            const totalMaquinasAlocadas = parseInt(maqRows[0]?.total, 10) || 0;

            // Âncora: contract.start_date se houver, senão primeira data com lançamento.
            let ancora = null;
            if (contract.start_date) {
                ancora = new Date(contract.start_date).toISOString().slice(0, 10);
            } else if (datasOrdenadas.length) {
                ancora = datasOrdenadas[0];
            }

            if (ancora) {
                const horasContratadas = parseFloat(contract.total_hours_contracted) || 0;
                const today = new Date().toISOString().slice(0, 10);
                const todasQuinzenas = [];
                let horasAcum = 0;

                for (let q = 0; q < 200; q++) {
                    const ini = new Date(ancora + 'T12:00:00');
                    ini.setDate(ini.getDate() + q * 15);
                    const fim = new Date(ini);
                    fim.setDate(fim.getDate() + 14);

                    const iniStr = ini.toISOString().slice(0, 10);
                    const fimStr = fim.toISOString().slice(0, 10);
                    if (iniStr > today) break;

                    const datasNaQ = datasOrdenadas.filter(d => d >= iniStr && d <= fimStr);
                    const horasQ = datasNaQ.reduce((acc, d) => acc + horasPorData[d], 0);
                    const veicSet = new Set();
                    datasNaQ.forEach(d => {
                        (veiculosPorData[d] || []).forEach(v => veicSet.add(v));
                    });

                    horasAcum += horasQ;

                    todasQuinzenas.push({
                        numero: q + 1,
                        dataInicio: iniStr,
                        dataFim: fimStr,
                        horasLancadas: Math.round(horasQ * 10) / 10,
                        maquinasFaturando: veicSet.size,
                        maquinasAlocadas: totalMaquinasAlocadas,
                        percentualAcumulado: horasContratadas > 0
                            ? Math.round((horasAcum / horasContratadas) * 1000) / 10
                            : null,
                        deltaPercent: horasContratadas > 0
                            ? Math.round((horasQ / horasContratadas) * 1000) / 10
                            : null,
                        encerrada: fimStr < today,
                    });
                }

                // Últimas 4 (mais recentes ao final do array)
                quinzenas.push(...todasQuinzenas.slice(-4));
            }
        } catch (qErr) {
            console.error('Erro ao calcular quinzenas:', qErr);
        }

        res.json({
            obra,
            contract,
            financeiro: {
                total_contrato: contract.total_value,
                total_despesas: totalDespesas,
                categorias: expensesCategory,
                valor_produzido: valorProduzidoEstimado,
                pendente_faturamento: valorPendenteFaturamento
            },
            producao: {
                media_diaria_atual: mediaDiariaObra,
                saldo_horas: contract.total_hours_contracted - horasExecutadas,
                horas_executadas: horasExecutadas,
                quinzenas
            },
            veiculos: machinePredictions,
            crm_history: crmHistory
        });

    } catch (error) {
        console.error('Erro Detalhes Supervisor:', error);
        res.status(500).json({ message: 'Erro ao carregar detalhes.' });
    }
};

exports.getAllocationForecast = async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT v.id, v.placa, v.modelo, v.tipo, v.obraAtualId, o.nome as nome_obra, v.operationalAssignment
            FROM vehicles v
            JOIN obras o ON v.obraAtualId = o.id
            WHERE o.status = 'ativa'
        `);

        const [obrasStats] = await db.query(`
            SELECT 
                o.id, 
                o.nome,
                oc.total_hours_contracted,
                o.horasContratadasPorTipo,
                (SELECT SUM(totalHours) FROM daily_work_logs WHERE obraId = o.id) as executed
            FROM obras o
            LEFT JOIN obra_contracts oc ON o.id = oc.obra_id
            WHERE o.status = 'ativa'
              AND (o.tipo_registro IS NULL OR o.tipo_registro != 'centro_custo')
        `);

        const obraMap = {};
        for (const o of obrasStats) {
             const [recentLogs] = await db.query(`
                SELECT SUM(totalHours) as total, COUNT(DISTINCT date) as days
                FROM daily_work_logs 
                WHERE obraId = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
            `, [o.id]);
            
            const ritmoDiario = (recentLogs[0]?.total || 0) / (recentLogs[0]?.days || 1);
            
            let totalHoras = parseFloat(o.total_hours_contracted) || sumLegacyHours(o.horasContratadasPorTipo);
            let executado = parseFloat(o.executed) || 0;
            let saldo = totalHoras - executado;
            let diasRestantes = (saldo > 0 && ritmoDiario > 0) ? Math.ceil(saldo / ritmoDiario) : 0;
            
            obraMap[o.id] = {
                saldo,
                ritmoDiario,
                previsaoSaida: addBusinessDays(new Date(), diasRestantes)
            };
        }

        const allocationList = vehicles.map(v => {
            const obraStat = obraMap[v.obraAtualId] || { previsaoSaida: new Date() };
            
            let nextMission = {};
            try { if(v.operationalAssignment) nextMission = v.operationalAssignment.next_mission || {}; } catch(e){}

            const calculatedDate = obraStat.previsaoSaida;
            const manualDate = nextMission.release_date ? new Date(nextMission.release_date) : null;

            return {
                id: v.id,
                modelo: v.modelo,
                placa: v.placa,
                tipo: v.tipo,
                obra_atual: v.nome_obra,
                previsao_liberacao: manualDate || calculatedDate,
                is_manual: !!manualDate,
                proximo_destino: nextMission.location || 'A Definir'
            };
        });

        allocationList.sort((a, b) => new Date(a.previsao_liberacao) - new Date(b.previsao_liberacao));

        res.json(allocationList);

    } catch (error) {
        console.error("Erro Allocation Forecast:", error);
        res.status(500).json({message: error.message});
    }
};

exports.updateVehicleNextMission = async (req, res) => {
    const { vehicle_id, next_location, release_date } = req.body;
    try {
        const [v] = await db.query('SELECT operationalAssignment FROM vehicles WHERE id = ?', [vehicle_id]);
        let currentAssignment = v[0]?.operationalAssignment || {};
        if (typeof currentAssignment === 'string') currentAssignment = JSON.parse(currentAssignment);
        if (!currentAssignment) currentAssignment = {};

        currentAssignment.next_mission = { location: next_location, release_date: release_date, updated_at: new Date() };
        await db.query('UPDATE vehicles SET operationalAssignment = ? WHERE id = ?', [JSON.stringify(currentAssignment), vehicle_id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.addCrmLog = async (req, res) => {
    const { obra_id, interaction_type, notes, agreed_action } = req.body;
    const user_id = req.user?.id || null; 
    try {
        await db.query(`INSERT INTO obra_crm_logs (obra_id, user_id, interaction_type, notes, agreed_action) VALUES (?, ?, ?, ?, ?)`, [obra_id, user_id, interaction_type, notes, agreed_action]);
        res.json({success: true});
    } catch (e) { res.status(500).json({error: e.message}); }
};

exports.upsertContract = async (req, res) => {
    let { obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome, is_hidden } = req.body;
    
    if (!data_inicio) data_inicio = null;
    if (!data_fim_contratual) data_fim_contratual = null;
    const hiddenVal = is_hidden ? 1 : 0; 

    try {
        const [existing] = await db.query('SELECT id FROM obra_contracts WHERE obra_id = ?', [obra_id]);
        if (existing.length > 0) {
            await db.query(`
                UPDATE obra_contracts 
                SET total_value = ?, total_hours_contracted = ?, start_date = ?, expected_end_date = ?, fiscal_nome = ?, responsavel_nome = ?, is_hidden = ? 
                WHERE obra_id = ?
            `, [valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome, hiddenVal, obra_id]);
        } else {
            await db.query(`
                INSERT INTO obra_contracts (obra_id, total_value, total_hours_contracted, start_date, expected_end_date, fiscal_nome, responsavel_nome, is_hidden) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [obra_id, valor_total, horas_totais, data_inicio, data_fim_contratual, fiscal_nome, responsavel_nome, hiddenVal]);
        }
        res.json({ message: 'Contrato salvo.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
};

function getStatusColor(perc) {
    if (perc >= 90) return 'red';
    if (perc >= 70) return 'violet';
    if (perc >= 30) return 'yellow';
    return 'green';
}

// ==================================================================================
// BI E ANÁLISE DE PRODUTIVIDADE
// ==================================================================================
// Helpers internos
const HORAS_POR_DIA = 8;
const TIPOS_EXCLUIDOS_PRODUTIVOS = [
    'Leve', 'Passeio', 'Utilitario', 'Moto', 'Administrativo', 'Carro',
    'Automóvel', 'Camionete', 'Semirreboques', 'Caminhão Carroceria', 'Caminhão Prancha'
];

const _isBusinessDay = (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    const wd = d.getDay();
    return wd !== 0 && wd !== 6;
};

const _fmtDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

const _diffDays = (startStr, endStr) => {
    const s = new Date(startStr + 'T12:00:00');
    const e = new Date(endStr + 'T12:00:00');
    return Math.round((e - s) / 86400000) + 1;
};

const _businessDayList = (startStr, endStr) => {
    const out = [];
    const cur = new Date(startStr + 'T12:00:00');
    const end = new Date(endStr + 'T12:00:00');
    while (cur <= end) {
        out.push({ date: _fmtDate(cur), isBusinessDay: _isBusinessDay(_fmtDate(cur)) });
        cur.setDate(cur.getDate() + 1);
    }
    return out;
};

/**
 * Computa as métricas de aproveitamento entre [startDate, endDate] inclusive,
 * filtrado por obraId opcional (ou 'geral').
 *
 * Capacidade líquida = (qtd de veículos produtivos no momento) × HORAS_POR_DIA
 *                       × (dias úteis do período)
 *   − (qtd em manutenção HOJE × HORAS_POR_DIA × dias úteis do período)
 *
 * Limitações conhecidas:
 *   - Não temos histórico per-day de status do veículo nem disponibilidade
 *     de operador. O snapshot atual de "em manutenção" é usado como
 *     proxy do período inteiro.
 *   - Feriados não são removidos (não há tabela de feriados).
 */
async function _computeAnalyticsCore(obraId, startDate, endDate) {
    const isGeral = !obraId || obraId === 'geral';

    // 1) Snapshot da frota produtiva
    let vehiclesQuery = `
        SELECT v.id, v.modelo, v.registroInterno, v.tipo, v.status, v.obraAtualId,
               (CASE
                 WHEN v.status = 'Ativo' AND v.obraAtualId IS NOT NULL THEN 'em_obra'
                 WHEN v.status = 'Disponível' OR v.status = 'Ativo' THEN 'disponivel'
                 WHEN v.status IN ('Em Manutenção', 'Aguardando Manutenção', 'Em Manutencao') THEN 'manutencao'
                 WHEN v.status = 'Sucata' THEN 'sucata'
                 ELSE 'disponivel'
               END) as estado_calculado
        FROM vehicles v
        WHERE v.tipo NOT IN (${TIPOS_EXCLUIDOS_PRODUTIVOS.map(() => '?').join(',')})
          AND (v.ativo IS NULL OR v.ativo != 0)
          AND (v.isOutsourced IS NULL OR v.isOutsourced != 1)
    `;
    const [allVehicles] = await db.query(vehiclesQuery, TIPOS_EXCLUIDOS_PRODUTIVOS);

    // Filtra escopo (visão geral ou obra específica)
    const scopedVehicles = allVehicles.filter(v => {
        if (v.estado_calculado === 'sucata') return false;
        if (isGeral) return true;
        return String(v.obraAtualId) === String(obraId);
    });

    const qtdVeiculos = scopedVehicles.length;
    const qtdManutencao = scopedVehicles.filter(v => v.estado_calculado === 'manutencao').length;

    // 2) Calendário do período
    const cal = _businessDayList(startDate, endDate);
    const diasTotais = cal.length;
    const diasUteis = cal.filter(c => c.isBusinessDay).length || 1;

    const capDiariaBruta = qtdVeiculos * HORAS_POR_DIA;
    const capDiariaLiquida = Math.max(0, (qtdVeiculos - qtdManutencao)) * HORAS_POR_DIA;
    const capPeriodoLiquida = capDiariaLiquida * diasUteis;
    const horasPerdidasManutencao = qtdManutencao * HORAS_POR_DIA * diasUteis;

    // 3) Logs de produção por dia
    let logsParams = [startDate, endDate];
    let logsCondObra = '';
    if (!isGeral) { logsCondObra = ' AND l.obraId = ?'; logsParams.push(obraId); }

    const [logsDia] = await db.query(`
        SELECT DATE_FORMAT(l.date, '%Y-%m-%d') as data_log, SUM(l.totalHours) as horas
        FROM daily_work_logs l
        WHERE l.date BETWEEN ? AND ?${logsCondObra}
        GROUP BY data_log
    `, logsParams);
    const logsMap = new Map(logsDia.map(r => [r.data_log, parseFloat(r.horas) || 0]));

    const chartData = cal.map(c => ({
        date: c.date,
        is_business_day: c.isBusinessDay,
        horas_faturadas: logsMap.get(c.date) || 0,
        capacidade_dia: c.isBusinessDay ? capDiariaLiquida : 0,
    }));

    const horasExecutadas = chartData.reduce((s, c) => s + c.horas_faturadas, 0);
    const aproveitamento = capPeriodoLiquida > 0 ? (horasExecutadas / capPeriodoLiquida) * 100 : 0;
    const horasPerdidasTotal = Math.max(0, capPeriodoLiquida - horasExecutadas);

    // 4) Breakdown por tipo
    const frotaPorTipo = {};
    scopedVehicles.forEach(v => {
        const tipo = v.tipo || 'Outros';
        if (!frotaPorTipo[tipo]) frotaPorTipo[tipo] = { qtd: 0, qtdManutencao: 0, horas_executadas: 0 };
        frotaPorTipo[tipo].qtd += 1;
        if (v.estado_calculado === 'manutencao') frotaPorTipo[tipo].qtdManutencao += 1;
    });

    let tipoParams = [startDate, endDate];
    let tipoCondObra = '';
    if (!isGeral) { tipoCondObra = ' AND l.obraId = ?'; tipoParams.push(obraId); }
    const [tipoLogs] = await db.query(`
        SELECT v.tipo, SUM(l.totalHours) as horas
        FROM daily_work_logs l
        JOIN vehicles v ON l.vehicleId = v.id
        WHERE l.date BETWEEN ? AND ?${tipoCondObra}
        GROUP BY v.tipo
    `, tipoParams);
    tipoLogs.forEach(t => {
        const tipo = t.tipo || 'Outros';
        if (!frotaPorTipo[tipo]) frotaPorTipo[tipo] = { qtd: 0, qtdManutencao: 0, horas_executadas: 0 };
        frotaPorTipo[tipo].horas_executadas = parseFloat(t.horas) || 0;
    });

    const frotaPorTipoArr = Object.entries(frotaPorTipo).map(([tipo, info]) => {
        const capDiaria = info.qtd * HORAS_POR_DIA;
        const capPeriodo = Math.max(0, (info.qtd - info.qtdManutencao)) * HORAS_POR_DIA * diasUteis;
        return {
            tipo,
            qtd: info.qtd,
            qtdManutencao: info.qtdManutencao,
            capDiaria,
            capPeriodo,
            horas_executadas: info.horas_executadas,
            aproveitamento: capPeriodo > 0 ? (info.horas_executadas / capPeriodo) * 100 : 0,
            horas_perdidas: Math.max(0, capPeriodo - info.horas_executadas),
        };
    }).sort((a, b) => a.aproveitamento - b.aproveitamento);

    // 5) Ranking por OBRA (apenas em visão geral)
    let porObra = [];
    if (isGeral) {
        // Agrupa snapshot de máquinas por obra
        const machinesByObra = new Map(); // obraId → { qtd, qtdMan }
        scopedVehicles.forEach(v => {
            const oid = v.obraAtualId ? String(v.obraAtualId) : null;
            if (!oid) return;
            if (!machinesByObra.has(oid)) machinesByObra.set(oid, { qtd: 0, qtdMan: 0 });
            const cur = machinesByObra.get(oid);
            cur.qtd += 1;
            if (v.estado_calculado === 'manutencao') cur.qtdMan += 1;
        });

        const [obraLogs] = await db.query(`
            SELECT l.obraId, SUM(l.totalHours) as horas
            FROM daily_work_logs l
            WHERE l.date BETWEEN ? AND ?
            GROUP BY l.obraId
        `, [startDate, endDate]);
        const obraLogsMap = new Map(obraLogs.map(r => [String(r.obraId), parseFloat(r.horas) || 0]));

        const obraIds = Array.from(new Set([
            ...machinesByObra.keys(),
            ...obraLogsMap.keys(),
        ])).filter(Boolean);

        if (obraIds.length > 0) {
            const placeholders = obraIds.map(() => '?').join(',');
            const [obraInfo] = await db.query(`
                SELECT o.id, o.nome, c.responsavel_nome, c.fiscal_nome
                FROM obras o
                LEFT JOIN obra_contracts c ON c.obra_id = o.id
                WHERE o.id IN (${placeholders})
            `, obraIds);
            const obraInfoMap = new Map(obraInfo.map(r => [String(r.id), r]));

            porObra = obraIds.map(oid => {
                const snap = machinesByObra.get(oid) || { qtd: 0, qtdMan: 0 };
                const capPeriodo = Math.max(0, (snap.qtd - snap.qtdMan)) * HORAS_POR_DIA * diasUteis;
                const horas = obraLogsMap.get(oid) || 0;
                const info = obraInfoMap.get(oid) || {};
                return {
                    obraId: oid,
                    obraNome: info.nome || '(sem obra)',
                    responsavel: info.responsavel_nome || null,
                    fiscal: info.fiscal_nome || null,
                    qtdVeiculos: snap.qtd,
                    capPeriodo,
                    horas_executadas: horas,
                    aproveitamento: capPeriodo > 0 ? (horas / capPeriodo) * 100 : 0,
                    horas_perdidas: Math.max(0, capPeriodo - horas),
                };
            }).sort((a, b) => a.aproveitamento - b.aproveitamento);
        }
    }

    // 6) Ranking por VEÍCULO (com obra atual)
    let veiculoParams = [startDate, endDate];
    let veiculoCondObra = '';
    if (!isGeral) { veiculoCondObra = ' AND l.obraId = ?'; veiculoParams.push(obraId); }
    const [veiculoLogs] = await db.query(`
        SELECT l.vehicleId, SUM(l.totalHours) as horas
        FROM daily_work_logs l
        WHERE l.date BETWEEN ? AND ?${veiculoCondObra}
        GROUP BY l.vehicleId
    `, veiculoParams);
    const veiculoHorasMap = new Map(veiculoLogs.map(r => [String(r.vehicleId), parseFloat(r.horas) || 0]));

    // Mapa obra→nome (para enriquecer)
    const obraIdsUnicos = Array.from(new Set(scopedVehicles.map(v => v.obraAtualId).filter(Boolean))).map(String);
    let obraNomeMap = new Map();
    if (obraIdsUnicos.length) {
        const ph = obraIdsUnicos.map(() => '?').join(',');
        const [rows] = await db.query(`SELECT id, nome FROM obras WHERE id IN (${ph})`, obraIdsUnicos);
        obraNomeMap = new Map(rows.map(r => [String(r.id), r.nome]));
    }

    const porVeiculo = scopedVehicles.map(v => {
        const emManutencao = v.estado_calculado === 'manutencao';
        const capPeriodo = emManutencao ? 0 : HORAS_POR_DIA * diasUteis;
        const horas = veiculoHorasMap.get(String(v.id)) || 0;
        return {
            id: v.id,
            registroInterno: v.registroInterno,
            modelo: v.modelo,
            tipo: v.tipo,
            estado: v.estado_calculado,
            obraId: v.obraAtualId ? String(v.obraAtualId) : null,
            obraNome: v.obraAtualId ? (obraNomeMap.get(String(v.obraAtualId)) || '—') : '—',
            capPeriodo,
            horas_executadas: horas,
            aproveitamento: capPeriodo > 0 ? (horas / capPeriodo) * 100 : 0,
            horas_perdidas: Math.max(0, capPeriodo - horas),
        };
    }).sort((a, b) => a.aproveitamento - b.aproveitamento);

    return {
        range: { startDate, endDate, diasTotais, diasUteis },
        summary: {
            qtdVeiculos,
            qtdManutencao,
            capDiariaBruta,
            capDiariaLiquida,
            capPeriodoLiquida,
            horasExecutadas,
            horasPerdidasManutencao,
            horasPerdidasTotal,
            aproveitamento,
            mediaExecutadaDiasUteis: diasUteis > 0 ? horasExecutadas / diasUteis : 0,
        },
        chartData,
        frotaPorTipo: frotaPorTipoArr,
        porObra,
        porVeiculo,
    };
}

exports.getAnalyticsData = async (req, res) => {
    try {
        let { obraId, startDate, endDate, dias } = req.query;

        // Compat: se vier `dias` (param antigo), monta janela rolante
        if ((!startDate || !endDate) && dias) {
            const end = new Date(); end.setHours(12, 0, 0, 0);
            const start = new Date(end); start.setDate(end.getDate() - (parseInt(dias) - 1));
            startDate = _fmtDate(start);
            endDate = _fmtDate(end);
        }
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
        }
        if (startDate > endDate) {
            return res.status(400).json({ error: 'startDate maior que endDate.' });
        }

        const atual = await _computeAnalyticsCore(obraId, startDate, endDate);

        // Período anterior de mesmo comprimento (para delta)
        const dur = _diffDays(startDate, endDate);
        const prevEnd = new Date(startDate + 'T12:00:00');
        prevEnd.setDate(prevEnd.getDate() - 1);
        const prevStart = new Date(prevEnd);
        prevStart.setDate(prevStart.getDate() - (dur - 1));
        const anterior = await _computeAnalyticsCore(obraId, _fmtDate(prevStart), _fmtDate(prevEnd));

        const comparativo = {
            anterior: {
                range: anterior.range,
                horasExecutadas: anterior.summary.horasExecutadas,
                aproveitamento: anterior.summary.aproveitamento,
                horasPerdidasTotal: anterior.summary.horasPerdidasTotal,
            },
            delta: {
                horasExecutadas: atual.summary.horasExecutadas - anterior.summary.horasExecutadas,
                aproveitamento: atual.summary.aproveitamento - anterior.summary.aproveitamento,
                horasPerdidasTotal: atual.summary.horasPerdidasTotal - anterior.summary.horasPerdidasTotal,
            },
        };

        res.json({ ...atual, comparativo });
    } catch (error) {
        console.error("Erro no BI Supervisor:", error);
        res.status(500).json({ error: error.message });
    }
};

// Drill-down: breakdown de uma data específica por máquina
exports.getAnalyticsDayDetail = async (req, res) => {
    try {
        const { date, obraId } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'date (YYYY-MM-DD) é obrigatório.' });
        }
        const isGeral = !obraId || obraId === 'geral';

        const [vehicles] = await db.query(`
            SELECT v.id, v.registroInterno, v.modelo, v.tipo, v.status, v.obraAtualId,
                   (CASE
                     WHEN v.status IN ('Em Manutenção', 'Aguardando Manutenção', 'Em Manutencao') THEN 'manutencao'
                     WHEN v.status = 'Sucata' THEN 'sucata'
                     ELSE 'ativo'
                   END) as estado_calculado
            FROM vehicles v
            WHERE v.tipo NOT IN (${TIPOS_EXCLUIDOS_PRODUTIVOS.map(() => '?').join(',')})
              AND (v.ativo IS NULL OR v.ativo != 0)
              AND (v.isOutsourced IS NULL OR v.isOutsourced != 1)
        `, TIPOS_EXCLUIDOS_PRODUTIVOS);

        const scoped = vehicles.filter(v => {
            if (v.estado_calculado === 'sucata') return false;
            if (isGeral) return true;
            return String(v.obraAtualId) === String(obraId);
        });

        // Logs do dia
        let params = [date];
        let condObra = '';
        if (!isGeral) { condObra = ' AND l.obraId = ?'; params.push(obraId); }
        const [logs] = await db.query(`
            SELECT l.vehicleId, l.obraId, l.totalHours, o.nome as obraNome
            FROM daily_work_logs l
            LEFT JOIN obras o ON o.id = l.obraId
            WHERE DATE(l.date) = ?${condObra}
        `, params);
        const logsMap = new Map(logs.map(r => [String(r.vehicleId), { horas: parseFloat(r.totalHours) || 0, obraNome: r.obraNome }]));

        const isBusiness = _isBusinessDay(date);

        const items = scoped.map(v => {
            const log = logsMap.get(String(v.id));
            let status;
            if (!isBusiness) status = 'nao_util';
            else if (v.estado_calculado === 'manutencao') status = 'manutencao';
            else if (log && log.horas > 0) status = 'produziu';
            else status = 'ocioso';
            return {
                id: v.id,
                registroInterno: v.registroInterno,
                modelo: v.modelo,
                tipo: v.tipo,
                obraNome: log?.obraNome || null,
                horas: log?.horas || 0,
                status,
            };
        });

        const totais = items.reduce((acc, it) => {
            acc[it.status] = (acc[it.status] || 0) + 1;
            acc.horas += it.horas;
            return acc;
        }, { horas: 0 });

        res.json({
            date,
            isBusinessDay: isBusiness,
            totais,
            items: items.sort((a, b) => {
                const order = { produziu: 0, ocioso: 1, manutencao: 2, nao_util: 3 };
                return (order[a.status] - order[b.status]) || (b.horas - a.horas);
            }),
        });
    } catch (error) {
        console.error("Erro no drill-down de dia:", error);
        res.status(500).json({ error: error.message });
    }
};

// ==================================================================================
// CONFIGURAÇÃO DO TICKET MÉDIO (PERSISTÊNCIA)
// ==================================================================================
exports.getTicketMedio = async (req, res) => {
    try {
        // Cria a tabela de forma segura caso o sistema seja recém atualizado
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_ticket_config (
                tipo VARCHAR(100) PRIMARY KEY, 
                valor DECIMAL(10,2)
            )
        `);
        const [rows] = await db.query('SELECT tipo, valor FROM vehicle_ticket_config');
        const tickets = {};
        rows.forEach(r => tickets[r.tipo] = parseFloat(r.valor));
        res.json(tickets);
    } catch (error) {
        console.error("Erro ao ler Ticket Médio:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.saveTicketMedio = async (req, res) => {
    try {
        const { tickets } = req.body;
        
        // Garante que a tabela existe
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_ticket_config (
                tipo VARCHAR(100) PRIMARY KEY, 
                valor DECIMAL(10,2)
            )
        `);
        
        // Grava os novos valores no banco (Insere ou Atualiza)
        for (const tipo of Object.keys(tickets)) {
            const valor = tickets[tipo];
            await db.query(`
                INSERT INTO vehicle_ticket_config (tipo, valor) 
                VALUES (?, ?) 
                ON DUPLICATE KEY UPDATE valor = ?
            `, [tipo, valor, valor]);
        }
        res.json({ success: true, message: "Tickets guardados com sucesso." });
    } catch (error) {
        console.error("Erro ao guardar Ticket Médio:", error);
        res.status(500).json({ error: error.message });
    }
};