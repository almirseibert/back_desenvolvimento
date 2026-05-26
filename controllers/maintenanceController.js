const db = require('../database');
const crypto = require('crypto');

// =========================================================
// --- MANUTENÇÕES PROGRAMADAS (RELATOS)
// =========================================================

const getProgramadas = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM manutencoes_programadas ORDER BY status DESC, dataRelato DESC, createdAt DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro GET manutencoes_programadas:', error);
        res.status(500).json({ error: 'Erro ao buscar relatos.' });
    }
};

const createProgramada = async (req, res) => {
    try {
        const { vehicleId, dataRelato, descricao, relator } = req.body;
        const id = crypto.randomUUID();
        
        await db.execute(
            'INSERT INTO manutencoes_programadas (id, vehicleId, dataRelato, descricao, relator, status) VALUES (?, ?, ?, ?, ?, ?)',
            [id, vehicleId, dataRelato, descricao, relator || null, 'Pendente']
        );
        
        req.io.emit('server:sync', { targets: ['manutencoes_programadas'] });
        res.status(201).json({ message: 'Relato criado com sucesso', id });
    } catch (error) {
        console.error('Erro POST manutencoes_programadas:', error);
        res.status(500).json({ error: 'Erro ao criar relato.' });
    }
};

// =========================================================
// --- MANUTENÇÕES EXECUTADAS
// =========================================================

const getExecutadas = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM manutencoes_executadas ORDER BY dataManutencao DESC, createdAt DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro GET manutencoes_executadas:', error);
        res.status(500).json({ error: 'Erro ao buscar manutenções executadas.' });
    }
};

const createExecutada = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const { vehicleId, obraId, programadaId, dataManutencao, valor, oficina, descricao, pecasTrocadas } = req.body;
        const id = crypto.randomUUID();
        const safeValor = parseFloat(valor) || 0;

        // 1. Inserir a manutenção executada
        await connection.execute(
            `INSERT INTO manutencoes_executadas (id, vehicleId, obraId, programadaId, dataManutencao, valor, oficina, descricao, pecasTrocadas) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, vehicleId, obraId || null, programadaId || null, dataManutencao, safeValor, oficina || null, descricao, pecasTrocadas || null]
        );

        // 2. Se a manutenção veio de um relato programado, atualiza o status dele para 'Executado'
        if (programadaId) {
            await connection.execute(
                'UPDATE manutencoes_programadas SET status = "Executado" WHERE id = ?',
                [programadaId]
            );
        }

        // 3. Lançar a Despesa no Centro de Custo (Obra) automaticamente
        if (obraId && safeValor > 0 && obraId !== 'Patio') {
            const expId = crypto.randomUUID();
            const expDesc = `Manutenção: ${descricao}${oficina ? ` - ${oficina}` : ''}`;
            const dateObj = new Date(dataManutencao);
            
            await connection.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate) 
                 VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
                [expId, obraId, expDesc, safeValor, 'Manutenção', dateObj]
            );
        }

        await connection.commit();
        
        req.io.emit('server:sync', { targets: ['manutencoes_executadas', 'manutencoes_programadas', 'expenses'] });
        res.status(201).json({ message: 'Manutenção registrada com sucesso!', id });
        
    } catch (error) {
        await connection.rollback();
        console.error('Erro POST manutencoes_executadas:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

module.exports = {
    getProgramadas,
    createProgramada,
    getExecutadas,
    createExecutada
};