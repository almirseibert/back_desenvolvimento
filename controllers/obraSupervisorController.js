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
        const [allObras] = await db.query('SELECT * FROM obras WHERE status = "ativa"');
        
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
                horas_executadas: horasExecutadas
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
exports.getAnalyticsData = async (req, res) => {
    const { obraId, dias = 15 } = req.query;

    try {
        const isGeral = !obraId || obraId === 'geral';

        // Filtros aplicados: Exclui inativos (ativo = 0), terceirizados (isOutsourced = 1) e tipos complementares
        let vehiclesQuery = `
            SELECT id, tipo, status, obraAtualId,
                   (CASE 
                     WHEN status = 'Ativo' AND obraAtualId IS NOT NULL THEN 'em_obra'
                     WHEN status = 'Disponível' OR status = 'Ativo' THEN 'disponivel'
                     WHEN status IN ('Em Manutenção', 'Aguardando Manutenção', 'Em Manutencao') THEN 'manutencao'
                     WHEN status = 'Sucata' THEN 'sucata'
                     ELSE 'disponivel'
                   END) as estado_calculado
            FROM vehicles 
            WHERE tipo NOT IN ('Leve', 'Passeio', 'Utilitario', 'Moto', 'Administrativo', 'Carro', 'Automóvel', 'Camionete', 'Semirreboques', 'Caminhão Carroceria', 'Caminhão Prancha')
              AND (ativo IS NULL OR ativo != 0)
              AND (isOutsourced IS NULL OR isOutsourced != 1)
        `;
        const [vehicles] = await db.query(vehiclesQuery);

        let capEmObra = 0, capDisponivel = 0, capManutencao = 0;
        const frotaPorTipo = {};

        vehicles.forEach(v => {
            let countIt = false;
            if (!isGeral) {
                if (v.obraAtualId == obraId) countIt = true;
            } else {
                countIt = true;
            }

            if (countIt) {
                if (v.estado_calculado === 'em_obra') capEmObra += 8;
                else if (v.estado_calculado === 'disponivel' && isGeral) capDisponivel += 8; 
                else if (v.estado_calculado === 'manutencao') capManutencao += 8;

                if (v.estado_calculado !== 'sucata') {
                    if (!frotaPorTipo[v.tipo]) frotaPorTipo[v.tipo] = { qtd: 0, cap: 0, horas_executadas: 0 };
                    frotaPorTipo[v.tipo].qtd += 1;
                    frotaPorTipo[v.tipo].cap += 8;
                }
            }
        });

        let logsQuery = `
            SELECT DATE_FORMAT(l.date, '%Y-%m-%d') as data_log, SUM(l.totalHours) as horas
            FROM daily_work_logs l
            WHERE l.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        `;
        let queryParams = [parseInt(dias)];

        if (!isGeral) {
            logsQuery += ` AND l.obraId = ?`;
            queryParams.push(obraId);
        }
        logsQuery += ` GROUP BY data_log ORDER BY data_log ASC`;

        const [logs] = await db.query(logsQuery, queryParams);

        const chartData = [];
        const today = new Date();
        today.setHours(12, 0, 0, 0); 
        
        for (let i = parseInt(dias) - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            
            const logFound = logs.find(l => l.data_log === dateStr);
            chartData.push({
                date: dateStr,
                horas_faturadas: logFound ? parseFloat(logFound.horas) : 0,
                capacidade_alocada: capEmObra,
                capacidade_disponivel: isGeral ? capDisponivel : 0,
                capacidade_manutencao: capManutencao
            });
        }

        let typeQuery = `
            SELECT v.tipo, SUM(l.totalHours) as horas
            FROM daily_work_logs l
            JOIN vehicles v ON l.vehicleId = v.id
            WHERE l.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        `;
        let typeParams = [parseInt(dias)];
        if (!isGeral) {
            typeQuery += ` AND l.obraId = ?`;
            typeParams.push(obraId);
        }
        typeQuery += ` GROUP BY v.tipo`;

        const [typeLogs] = await db.query(typeQuery, typeParams);

        typeLogs.forEach(t => {
            const tipoStr = t.tipo || 'Outros';
            if (frotaPorTipo[tipoStr]) {
                frotaPorTipo[tipoStr].horas_executadas = parseFloat(t.horas) || 0;
            } else {
                frotaPorTipo[tipoStr] = { qtd: 0, cap: 0, horas_executadas: parseFloat(t.horas) || 0 };
            }
        });

        const totalExecutado = chartData.reduce((acc, c) => acc + c.horas_faturadas, 0);
        const mediaExecutada = totalExecutado / parseInt(dias);

        res.json({
            chartData,
            summary: {
                capEmObra,
                capDisponivel: isGeral ? capDisponivel : 0,
                capManutencao,
                mediaExecutada: parseFloat(mediaExecutada.toFixed(1))
            },
            frotaPorTipo
        });

    } catch (error) {
        console.error("Erro no BI Supervisor:", error);
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