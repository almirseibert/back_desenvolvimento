const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { dispatchAsync } = require('../services/notificationDispatcher');

// ===================================================================================
// FUNÇÃO AUXILIAR DE PARSE SEGURO
// ===================================================================================
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string' || (!field.startsWith('{') && !field.startsWith('['))) {
        return defaultValue; 
    }

    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
    } catch (e) {
        console.warn(`[JSON Parse Warning] Campo '${key}' não é JSON. Valor problemático:`, field);
        return defaultValue;
    }
};

const parseObraJsonFields = (obra) => {
    if (!obra) return null;
    const newObra = { ...obra };
    const fieldsToParse = ['horasContratadasPorTipo', 'valoresPorTipo', 'sectors', 'alocadoEm', 'ultimaAlteracao'];
    fieldsToParse.forEach(field => {
        if (obra.hasOwnProperty(field)) {
            newObra[field] = parseJsonSafe(obra[field], field);
        }
    });
    return newObra;
};

// --- GET ALL OBRAS ---
const getAllObras = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM obras');
        const [historyRows] = await db.query('SELECT * FROM obras_historico_veiculos');

        const [billingRows] = await db.query(`
            SELECT obraId, SUM(totalHours) as totalHorasRealizadas 
            FROM daily_work_logs 
            GROUP BY obraId
        `);

        const billingMap = {};
        billingRows.forEach(row => {
            billingMap[row.obraId] = parseFloat(row.totalHorasRealizadas) || 0;
        });

        const obras = rows.map(obra => {
            const parsedObra = parseObraJsonFields(obra);
            parsedObra.historicoVeiculos = historyRows
                .filter(h => h.obraId === parsedObra.id)
                .sort((a, b) => new Date(b.dataEntrada) - new Date(a.dataEntrada));
            parsedObra.totalHorasRealizadas = billingMap[parsedObra.id] || 0;
            return parsedObra;
        });
        
        res.json(obras);
    } catch (error) {
        console.error('Erro ao buscar obras:', error);
        res.status(500).json({ error: 'Erro ao buscar obras' });
    }
};

// --- GET OBRA BY ID ---
const getObraById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM obras WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Obra não encontrada' });
        }
        
        const [historyRows] = await db.query(
            'SELECT * FROM obras_historico_veiculos WHERE obraId = ? ORDER BY dataEntrada DESC', 
            [req.params.id]
        );

        const [billingByTypeRows] = await db.query(`
            SELECT v.tipo, SUM(l.totalHours) as totalHoras
            FROM daily_work_logs l
            JOIN vehicles v ON l.vehicleId = v.id
            WHERE l.obraId = ?
            GROUP BY v.tipo
        `, [req.params.id]);

        const realizadoPorTipo = {};
        let totalRealizadoGeral = 0;

        billingByTypeRows.forEach(row => {
            realizadoPorTipo[row.tipo] = parseFloat(row.totalHoras) || 0;
            totalRealizadoGeral += parseFloat(row.totalHoras) || 0;
        });
        
        const obra = parseObraJsonFields(rows[0]);
        obra.historicoVeiculos = historyRows; 
        obra.realizadoPorTipo = realizadoPorTipo; 
        obra.totalHorasRealizadas = totalRealizadoGeral;

        res.json(obra);
    } catch (error) {
        console.error('Erro ao buscar obra por ID:', error);
        res.status(500).json({ error: 'Erro ao buscar obra' });
    }
};

// --- CREATE OBRA ---
const createObra = async (req, res) => {
    const data = { ...req.body };
    data.id = uuidv4();

    delete data.historicoVeiculos; 
    delete data.realizadoPorTipo;
    delete data.totalHorasRealizadas;

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.valoresPorTipo) data.valoresPorTipo = JSON.stringify(data.valoresPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);
    
    if (data.latitude === '') data.latitude = null;
    if (data.longitude === '') data.longitude = null;
    if (data.responsavel === '') data.responsavel = null;
    if (data.fiscal === '') data.fiscal = null;

    if (data.kmContratadoPrancha === '') data.kmContratadoPrancha = 0;
    if (data.valorKmPrancha === '') data.valorKmPrancha = 0;
    if (data.valorTotalContrato === '') data.valorTotalContrato = 0;

    data.status = 'ativa';

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO obras (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['obras'] });

        // Notificação configurável (Fase 3.2)
        dispatchAsync('obra_criada', {
            nome: data.nome,
            orgao_contratante: data.orgao_contratante || data.orgaoContratante || null,
            regiao: data.regiao || null,
        });

        res.status(201).json({ message: 'Obra criada com sucesso' });
    } catch (error) {
        console.error('Erro ao criar obra:', error);
        res.status(500).json({ error: 'Erro ao criar obra.', details: error.message });
    }
};

// --- UPDATE OBRA ---
const updateObra = async (req, res) => {
    const { id } = req.params;
    const data = { ...req.body };
    
    delete data.historicoVeiculos;
    delete data.realizadoPorTipo;
    delete data.totalHorasRealizadas;
    delete data.id;

    if (data.horasContratadasPorTipo) data.horasContratadasPorTipo = JSON.stringify(data.horasContratadasPorTipo);
    if (data.valoresPorTipo) data.valoresPorTipo = JSON.stringify(data.valoresPorTipo);
    if (data.sectors) data.sectors = JSON.stringify(data.sectors);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.stringify(data.ultimaAlteracao);

    if (data.latitude === '') data.latitude = null;
    if (data.longitude === '') data.longitude = null;
    if (data.responsavel === '') data.responsavel = null;
    if (data.fiscal === '') data.fiscal = null;

    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    if(fields.length === 0){
        return res.status(400).json({ error: 'Nenhum dado para atualizar.' });
    }
    
    const query = `UPDATE obras SET ${setClause} WHERE id = ?`;

    try {
        // Snapshot anterior para detectar cruzamento de marcos de progresso
        let pctAntes = null;
        const newPct = req.body.percentualConcluido ?? req.body.progresso;
        if (newPct != null) {
            try {
                const [prevRows] = await db.query('SELECT nome, percentualConcluido FROM obras WHERE id = ?', [id]);
                if (prevRows[0]) pctAntes = Number(prevRows[0].percentualConcluido) || 0;
            } catch { /* coluna pode não existir — ignora */ }
        }

        await db.execute(query, [...values, id]);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['obras'] });

        // Notificação configurável (Fase 3.2) — marcos 30/50/70%
        if (newPct != null && pctAntes != null) {
            const pctDepois = Number(newPct) || 0;
            const marcos = [30, 50, 70];
            for (const m of marcos) {
                if (pctAntes < m && pctDepois >= m) {
                    const [r] = await db.query('SELECT nome FROM obras WHERE id = ?', [id]);
                    dispatchAsync('obra_progresso', { obra: r[0]?.nome || '—', pct: m });
                    break;
                }
            }
        }

        res.json({ message: 'Obra atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar obra:', error);
        res.status(500).json({ error: 'Erro ao atualizar obra' });
    }
};

// --- DELETE OBRA ---
const deleteObra = async (req, res) => {
    const obraId = req.params.id;
    let connection;

    try {
        connection = await db.getConnection(); 
        await connection.beginTransaction();

        await connection.execute('DELETE FROM daily_work_logs WHERE obraId = ?', [obraId]);
        await connection.execute('DELETE FROM obras_historico_veiculos WHERE obraId = ?', [obraId]);
        
        const [result] = await connection.execute('DELETE FROM obras WHERE id = ?', [obraId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Obra não encontrada para exclusão.' });
        }

        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        // Sincroniza 'vehicles' também, pois o histórico foi apagado, o que pode impactar visualização
        req.io.emit('server:sync', { targets: ['obras', 'vehicles'] });

        res.status(204).end();
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Erro ao deletar obra:', error);
        res.status(500).json({ error: 'Erro ao deletar obra', details: error.message });
    } finally {
        if (connection) connection.release();
    }
};

// --- FINISH OBRA ---
const finishObra = async (req, res) => {
    const { id } = req.params;
    const { dataFim } = req.body;
    const finalDate = dataFim ? new Date(dataFim) : new Date();

    try {
        const [result] = await db.execute(
            "UPDATE obras SET status = 'finalizada', dataFim = ? WHERE id = ?",
            [finalDate, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Obra não encontrada.' });
        }

        // EMITIR EVENTO SOCKET.IO
        // Importante: Ao finalizar, veículos podem mudar de status logicamente, então atualizamos 'vehicles'
        req.io.emit('server:sync', { targets: ['obras', 'vehicles'] });

        res.json({ message: 'Obra finalizada com sucesso.' });
    } catch (error) {
        console.error('Erro ao finalizar obra:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// --- UPDATE HISTORICO (SINCRONIZADO E ROBUSTO) ---
const updateObraHistoryEntry = async (req, res) => {
    const { historyId } = req.params;
    const { dataEntrada, dataSaida, employeeId, leituraEntrada, leituraSaida } = req.body;

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Busca registro atual para saber quem era o veículo e operador anterior
        const [currentRows] = await connection.execute('SELECT * FROM obras_historico_veiculos WHERE id = ?', [historyId]);
        if (currentRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Histórico não encontrado.' });
        }
        
        const currentEntry = currentRows[0];
        const veiculoId = currentEntry.veiculoId;
        const oldEmployeeId = currentEntry.employeeId;
        const obraId = currentEntry.obraId;

        // 2. Busca nome do novo funcionário (se mudou)
        let employeeName = currentEntry.employeeName;
        if (employeeId && String(employeeId) !== String(oldEmployeeId)) {
            const [empRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
            if (empRows.length > 0) employeeName = empRows[0].nome;
        } else if (!employeeId) {
            employeeName = null;
        }

        // 3. Prepara valores de leitura (mantém o que já existia ou atualiza)
        let odometroEntrada = currentEntry.odometroEntrada;
        let horimetroEntrada = currentEntry.horimetroEntrada;
        let odometroSaida = currentEntry.odometroSaida;
        let horimetroSaida = currentEntry.horimetroSaida;

        // Se o registro original tinha odômetro ou se a nova leitura veio e não há horímetro
        if (currentEntry.odometroEntrada !== null || (leituraEntrada && !currentEntry.horimetroEntrada)) {
            odometroEntrada = leituraEntrada ? parseFloat(leituraEntrada) : null;
            odometroSaida = leituraSaida ? parseFloat(leituraSaida) : null;
        } else {
            horimetroEntrada = leituraEntrada ? parseFloat(leituraEntrada) : null;
            horimetroSaida = leituraSaida ? parseFloat(leituraSaida) : null;
        }

        // 4. ATUALIZA 'obras_historico_veiculos'
        const queryUpdate = `
            UPDATE obras_historico_veiculos 
            SET dataEntrada=?, dataSaida=?, employeeId=?, employeeName=?, odometroEntrada=?, odometroSaida=?, horimetroEntrada=?, horimetroSaida=?
            WHERE id=?
        `;
        
        await connection.execute(queryUpdate, [
            dataEntrada || null, 
            dataSaida || null, 
            employeeId || null, 
            employeeName, 
            odometroEntrada, 
            odometroSaida, 
            horimetroEntrada, 
            horimetroSaida, 
            historyId
        ]);

        // 5. Propaga leitura máxima (entrada ou saída) para vehicles
        {
            const [[vRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [veiculoId]);
            if (vRow) {
                const maxOdo = Math.max(odometroEntrada || 0, odometroSaida || 0);
                const maxHor = Math.max(horimetroEntrada || 0, horimetroSaida || 0);
                const readingVal = maxOdo > 0 ? maxOdo : (maxHor > 0 ? maxHor : null);
                if (readingVal) {
                    await updateVehicleReading(connection, veiculoId, vRow.tipo, readingVal, 'auto');
                }
            }
        }

        // 6. PROPAGAÇÃO DE MUDANÇAS (Sincronização)

        // Verifica se é uma alocação ATIVA (sem data de saída)
        const isActiveAllocation = (!dataSaida && !currentEntry.dataSaida);

        if (isActiveAllocation) {
            // A) Sincroniza com 'vehicle_history' (Tabela Unificada)
            // Busca o registro aberto mais recente deste veículo
            const [vhRows] = await connection.execute(
                `SELECT id, details FROM vehicle_history 
                 WHERE vehicleId = ? AND historyType = 'obra' AND endDate IS NULL 
                 ORDER BY startDate DESC LIMIT 1`, 
                [veiculoId]
            );

            if (vhRows.length > 0) {
                const vhEntry = vhRows[0];
                let details = typeof vhEntry.details === 'string' ? JSON.parse(vhEntry.details) : (vhEntry.details || {});
                
                // Atualiza os detalhes unificados
                details.employeeId = employeeId;
                details.employeeName = employeeName;
                if (odometroEntrada) details.odometroEntrada = odometroEntrada;
                if (horimetroEntrada) details.horimetroEntrada = horimetroEntrada;
                
                await connection.execute(
                    'UPDATE vehicle_history SET startDate = ?, details = ? WHERE id = ?',
                    [dataEntrada, JSON.stringify(details), vhEntry.id]
                );
            }

            // B) Sincroniza com 'employees' (Troca de alocação de funcionário)
            if (String(oldEmployeeId) !== String(employeeId)) {
                // Libera o funcionário antigo
                if (oldEmployeeId) {
                    await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [oldEmployeeId]);
                }
                // Aloca o novo funcionário
                if (employeeId) {
                    const employeeAllocation = JSON.stringify({ veiculoId: veiculoId, assignmentType: 'obra' });
                    await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [employeeAllocation, employeeId]);
                }
            }
            
            // Nota: Não precisamos atualizar a tabela 'vehicles' aqui a menos que o nome da obra mudasse (o que não acontece nesta rota)
            // O vínculo veículo->obra continua o mesmo (obraAtualId).
        } else {
            // É um registro histórico PASSADO (tem dataSaida)
            // Tenta atualizar o vehicle_history correspondente pela data de início (apenas melhor esforço)
            // Isso evita inconsistência no histórico global
            if (currentEntry.dataEntrada) {
                 const [vhRows] = await connection.execute(
                    `SELECT id, details FROM vehicle_history 
                     WHERE vehicleId = ? AND historyType = 'obra' AND startDate = ? LIMIT 1`, 
                    [veiculoId, currentEntry.dataEntrada]
                );
                
                if (vhRows.length > 0) {
                     const vhEntry = vhRows[0];
                     let details = typeof vhEntry.details === 'string' ? JSON.parse(vhEntry.details) : (vhEntry.details || {});
                     
                     // Atualiza dados históricos
                     details.employeeId = employeeId;
                     details.employeeName = employeeName;
                     details.odometroSaida = odometroSaida;
                     details.horimetroSaida = horimetroSaida;
                     
                     await connection.execute(
                        'UPDATE vehicle_history SET startDate = ?, endDate = ?, details = ? WHERE id = ?',
                        [dataEntrada, dataSaida, JSON.stringify(details), vhEntry.id]
                    );
                }
            }
        }

        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['obras', 'vehicles'] });

        res.json({ message: 'Histórico e vínculos atualizados com sucesso.' });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Erro ao atualizar histórico:', error);
        res.status(500).json({ error: 'Erro ao atualizar histórico.', details: error.message });
    } finally {
        if (connection) connection.release();
    }
};

// --- DELETE HISTORICO (Remove alocação incorreta) ---
const deleteObraHistoryEntry = async (req, res) => {
    const { historyId } = req.params;

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT * FROM obras_historico_veiculos WHERE id = ?', [historyId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Registro não encontrado.' });
        }

        const entry = rows[0];
        const isActive = !entry.dataSaida;

        if (isActive) {
            // Libera veículo e funcionário
            await connection.execute(
                'UPDATE vehicles SET obraAtualId = NULL, status = ?, alocadoEm = NULL WHERE id = ?',
                ['Disponível', entry.veiculoId]
            );
            if (entry.employeeId) {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [entry.employeeId]);
            }
            // Remove registro aberto no vehicle_history
            await connection.execute(
                'DELETE FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
                [entry.veiculoId, 'obra']
            );
        } else if (entry.dataEntrada) {
            // Remove registro encerrado no vehicle_history pela data de início
            await connection.execute(
                'DELETE FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND startDate = ?',
                [entry.veiculoId, 'obra', entry.dataEntrada]
            );
        }

        await connection.execute('DELETE FROM obras_historico_veiculos WHERE id = ?', [historyId]);

        await connection.commit();
        req.io.emit('server:sync', { targets: ['obras', 'vehicles'] });

        res.json({ message: 'Registro de alocação excluído com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Erro ao excluir histórico:', error);
        res.status(500).json({ error: 'Erro ao excluir registro.', details: error.message });
    } finally {
        if (connection) connection.release();
    }
};

module.exports = {
    getAllObras,
    getObraById,
    createObra,
    updateObra,
    deleteObra,
    finishObra,
    updateObraHistoryEntry,
    deleteObraHistoryEntry
};