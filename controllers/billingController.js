const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// --- Listar logs por Obra (com filtros opcionais de data) ---
const getDailyLogs = async (req, res) => {
    let obraId = req.params.obraId || req.query.obraId;
    const { startDate, endDate, vehicleId } = req.query;

    try {
        let query = `
            SELECT l.*, v.modelo, v.registroInterno, v.tipo, e.nome as employeeName 
            FROM daily_work_logs l
            JOIN vehicles v ON l.vehicleId = v.id
            LEFT JOIN employees e ON l.employeeId = e.id 
        `;
        
        const params = [];
        const conditions = [];

        if (obraId && obraId !== 'all') {
            conditions.push('l.obraId = ?');
            params.push(obraId);
        }

        if (startDate && endDate) {
            conditions.push('l.date BETWEEN ? AND ?');
            params.push(startDate, endDate);
        }
        
        if (vehicleId) {
            conditions.push('l.vehicleId = ?');
            params.push(vehicleId);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        const [rows] = await db.query(query, params);

        const uniqueMap = new Map();
        rows.forEach(row => {
            let dateStr = row.date;
            if (row.date instanceof Date) {
                 dateStr = row.date.toISOString().split('T')[0];
            } else if (typeof row.date === 'string' && row.date.includes('T')) {
                 dateStr = row.date.split('T')[0];
            }
            const key = `${row.vehicleId}-${dateStr}`;
            uniqueMap.set(key, row);
        });

        const uniqueRows = Array.from(uniqueMap.values());

        uniqueRows.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            if (dateB - dateA !== 0) return dateB - dateA;
            const regA = a.registroInterno || '';
            const regB = b.registroInterno || '';
            return regA.localeCompare(regB);
        });

        res.json(uniqueRows);
    } catch (error) {
        console.error('Erro ao buscar logs diários:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// Planejamento: o 1º lançamento de horas ativa a obra (radar/planejada/mobilizacao → ativa).
// Evento único — apagar o lançamento não reverte o status.
const activateObraOnFirstLog = async (obraId, date, io) => {
    try {
        const [rows] = await db.query('SELECT nome, status FROM obras WHERE id = ?', [obraId]);
        const obra = rows[0];
        if (obra && ['radar', 'planejada', 'mobilizacao'].includes(obra.status)) {
            await db.execute(
                'UPDATE obras SET status = ?, dataInicio = COALESCE(dataInicio, ?) WHERE id = ?',
                ['ativa', date, obraId]
            );
            if (io) io.emit('server:sync', { targets: ['obras'] });
            console.log(`✅ Obra "${obra.nome}" ativada automaticamente (1º lançamento de horas).`);
        }
    } catch (e) {
        console.warn('⚠️ [planejamento] Falha ao ativar obra no 1º lançamento:', e.message);
    }
};

const upsertDailyLog = async (req, res) => {
    const data = req.body;
    
    if (!data.obraId || !data.vehicleId || !data.date) {
        return res.status(400).json({ error: 'Campos obrigatórios faltando (Obra, Veículo, Data).' });
    }

    try {
        let targetId = data.id;

        // Proteção extra contra duplicidade por falha de estado no front
        if (!targetId) {
            const checkQuery = 'SELECT id FROM daily_work_logs WHERE vehicleId = ? AND date = ? AND obraId = ? LIMIT 1';
            const [existing] = await db.query(checkQuery, [data.vehicleId, data.date, data.obraId]);
            if (existing && existing.length > 0) {
                targetId = existing[0].id;
            }
        }

        if (targetId) {
            const query = `
                UPDATE daily_work_logs
                SET vehicleId = ?, employeeId = ?, date = ?,
                    morningStart = ?, morningEnd = ?, afternoonStart = ?, afternoonEnd = ?,
                    totalHours = ?, observation = ?, justificativaTipo = ?
                WHERE id = ?
            `;
            await db.execute(query, [
                data.vehicleId,
                data.employeeId || null,
                data.date,
                data.morningStart || null,
                data.morningEnd || null,
                data.afternoonStart || null,
                data.afternoonEnd || null,
                data.totalHours || 0,
                data.observation || null,
                data.justificativaTipo || null,
                targetId
            ]);
            
            await activateObraOnFirstLog(data.obraId, data.date, req.io);
            if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });
            res.json({ message: 'Registro atualizado.', id: targetId });
        } else {
            const newId = uuidv4();
            const {
                obraId, vehicleId, employeeId, date,
                morningStart, morningEnd, afternoonStart, afternoonEnd, totalHours, observation, justificativaTipo
            } = data;

            const query = `
                INSERT INTO daily_work_logs
                (id, obraId, vehicleId, employeeId, date, morningStart, morningEnd, afternoonStart, afternoonEnd, totalHours, observation, justificativaTipo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await db.execute(query, [
                newId, obraId, vehicleId, employeeId || null, date,
                morningStart || null, morningEnd || null, afternoonStart || null, afternoonEnd || null,
                totalHours || 0, observation || null, justificativaTipo || null
            ]);
            
            await activateObraOnFirstLog(obraId, date, req.io);
            if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });
            res.status(201).json({ message: 'Registro criado.', id: newId });
        }
    } catch (error) {
        console.error('Erro ao salvar log diário:', error);
        res.status(500).json({ error: 'Erro ao salvar registro.' });
    }
};

const deleteDailyLog = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM daily_work_logs WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['dailyWorkLogs'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar log:', error);
        res.status(500).json({ error: 'Erro ao deletar.' });
    }
};

module.exports = { getDailyLogs, upsertDailyLog, deleteDailyLog };