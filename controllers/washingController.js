const db = require('../database');
const crypto = require('crypto');

// =========================================================
// --- PARCEIROS DE LAVAGEM (LAVA-JATOS)
// =========================================================

const getPartners = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM washing_partners ORDER BY nome ASC');
        res.json(rows);
    } catch (error) {
        console.error('Erro GET washing_partners:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiros de lavagem.' });
    }
};

const createPartner = async (req, res) => {
    try {
        const { nome, telefone, endereco } = req.body;
        const id = crypto.randomUUID();
        
        await db.execute(
            'INSERT INTO washing_partners (id, nome, telefone, endereco) VALUES (?, ?, ?, ?)',
            [id, nome, telefone || null, endereco || null]
        );
        
        req.io.emit('server:sync', { targets: ['washing_partners'] });
        res.status(201).json({ message: 'Parceiro cadastrado com sucesso', id });
    } catch (error) {
        console.error('Erro POST washing_partners:', error);
        res.status(500).json({ error: 'Erro ao cadastrar parceiro.' });
    }
};

const updatePartner = async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, telefone, endereco } = req.body;
        
        await db.execute(
            'UPDATE washing_partners SET nome = ?, telefone = ?, endereco = ? WHERE id = ?',
            [nome, telefone || null, endereco || null, id]
        );
        
        req.io.emit('server:sync', { targets: ['washing_partners'] });
        res.json({ message: 'Parceiro atualizado com sucesso' });
    } catch (error) {
        console.error('Erro PUT washing_partners:', error);
        res.status(500).json({ error: 'Erro ao atualizar parceiro.' });
    }
};

const deletePartner = async (req, res) => {
    try {
        await db.execute('DELETE FROM washing_partners WHERE id = ?', [req.params.id]);
        req.io.emit('server:sync', { targets: ['washing_partners'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro DELETE washing_partners:', error);
        res.status(500).json({ error: 'Erro ao excluir parceiro.' });
    }
};

// =========================================================
// --- REGISTROS DE LAVAGENS
// =========================================================

const getWashings = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM lavagens ORDER BY dataLavagem DESC, createdAt DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro GET lavagens:', error);
        res.status(500).json({ error: 'Erro ao buscar histórico de lavagens.' });
    }
};

const createWashing = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const { vehicleId, obraId, parceiroId, dataLavagem, valor, descricao } = req.body;
        const id = crypto.randomUUID();
        const safeValor = parseFloat(valor) || 0;

        // 1. Inserir a lavagem
        await connection.execute(
            `INSERT INTO lavagens (id, vehicleId, obraId, parceiroId, dataLavagem, valor, descricao) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, vehicleId, obraId || null, parceiroId || null, dataLavagem, safeValor, descricao || null]
        );

        // 2. Lançar a Despesa no Centro de Custo (Obra) automaticamente
        if (obraId && safeValor > 0 && obraId !== 'Patio') {
            const expId = crypto.randomUUID();
            let partnerName = 'Lavagem';
            
            if (parceiroId) {
                const [pRows] = await connection.execute('SELECT nome FROM washing_partners WHERE id = ?', [parceiroId]);
                if (pRows.length > 0) partnerName = `Lavagem: ${pRows[0].nome}`;
            }
            
            const expDesc = `${partnerName} ${descricao ? ` - ${descricao}` : ''}`;
            const dateObj = new Date(dataLavagem);

            await connection.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate) 
                 VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
                [expId, obraId, expDesc, safeValor, 'Lavagem', dateObj]
            );
        }

        await connection.commit();
        
        req.io.emit('server:sync', { targets: ['lavagens', 'expenses'] });
        res.status(201).json({ message: 'Lavagem registrada com sucesso!', id });
        
    } catch (error) {
        await connection.rollback();
        console.error('Erro POST lavagens:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

module.exports = {
    getPartners,
    createPartner,
    updatePartner, // Exportando a nova função
    deletePartner,
    getWashings,
    createWashing
};