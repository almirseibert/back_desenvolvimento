// controllers/partnerController.js
const db = require('../database');
const { parseJsonSafe } = require('../utils/parseJsonSafe'); 

// --- Função Auxiliar para Conversão de JSON ---
const parsePartnerJsonFields = (partner) => {
    if (!partner) return null;
    const newPartner = { ...partner };
    if (newPartner.ultima_alteracao) newPartner.ultima_alteracao = parseJsonSafe(newPartner.ultima_alteracao, 'ultima_alteracao');
    return newPartner;
};

// --- READ: Obter todos os parceiros ---
const getAllPartners = async (req, res) => {
    try {
        const [partnerRows] = await db.execute('SELECT * FROM partners');
        const [priceRows] = await db.execute('SELECT * FROM partner_fuel_prices');
        
        const partnersWithPrices = partnerRows.map(partner => {
            const parsedPartner = parsePartnerJsonFields(partner);
            const partnerPrices = priceRows.filter(p => p.partnerId === partner.id);
            
            parsedPartner.fuel_prices = partnerPrices.reduce((acc, priceEntry) => {
                acc[priceEntry.fuelType] = priceEntry.price;
                return acc;
            }, {});
            
            return parsedPartner;
        });
        
        res.json(partnersWithPrices);
    } catch (error) {
        console.error('Erro ao buscar parceiros:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiros' });
    }
};

// --- READ: Obter um único parceiro por ID ---
const getPartnerById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM partners WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Parceiro não encontrado' });
        }
        
        const partner = parsePartnerJsonFields(rows[0]);
        const [priceRows] = await db.execute('SELECT * FROM partner_fuel_prices WHERE partnerId = ?', [req.params.id]);
        
        partner.fuel_prices = priceRows.reduce((acc, priceEntry) => {
            acc[priceEntry.fuelType] = priceEntry.price;
            return acc;
        }, {});
        
        res.json(partner);
    } catch (error) {
        console.error('Erro ao buscar parceiro:', error);
        res.status(500).json({ error: 'Erro ao buscar parceiro' });
    }
};

// --- CREATE: Criar um novo parceiro ---
const createPartner = async (req, res) => {
    const allowedPartnerFields = [
        'id', 
        'razaoSocial',
        'cnpj',
        'inscricaoEstadual',
        'endereco',
        'telefone',
        'whatsapp',
        'email',
        'contatoResponsavel',
        'cidade',
        'status_operacional',
        'tipo_parceiro'
    ];

    const data = req.body;
    const fuelPrices = data.fuel_prices;
    
    const partnerData = {};
    Object.keys(data).forEach(key => {
        if (allowedPartnerFields.includes(key)) {
            partnerData[key] = data[key];
        }
    });

    // Se não enviar tipo, assume que é posto
    if (!partnerData.tipo_parceiro) {
        partnerData.tipo_parceiro = 'posto';
    }

    const fields = Object.keys(partnerData);
    const values = Object.values(partnerData);
    
    if (!partnerData.id || !partnerData.razaoSocial) {
        return res.status(400).json({ error: 'ID e Razão Social são obrigatórios.' });
    }
    
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO partners (${fields.join(', ')}) VALUES (${placeholders})`;

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        await connection.execute(query, values);
        const newPartnerId = partnerData.id; 

        if (fuelPrices && typeof fuelPrices === 'object' && partnerData.tipo_parceiro === 'posto') {
            const pricePromises = Object.entries(fuelPrices).map(([fuelType, price]) => {
                return connection.execute(
                    'INSERT INTO partner_fuel_prices (partnerId, fuelType, price) VALUES (?, ?, ?)',
                    [newPartnerId, fuelType, price || 0]
                );
            });
            await Promise.all(pricePromises);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['partners'] });
        res.status(201).json({ id: newPartnerId, ...req.body });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao criar parceiro:', error);
        res.status(500).json({ error: 'Erro ao criar parceiro' });
    } finally {
        connection.release();
    }
};

// --- UPDATE: Atualizar um parceiro existente ---
const updatePartner = async (req, res) => {
    const { id } = req.params;

    const allowedPartnerFields = [
        'razaoSocial',
        'cnpj',
        'inscricaoEstadual',
        'endereco',
        'telefone',
        'whatsapp',
        'email',
        'contatoResponsavel',
        'cidade',
        'status_operacional',
        'tipo_parceiro'
    ];

    const data = req.body;
    const partnerData = {};
    Object.keys(data).forEach(key => {
        if (allowedPartnerFields.includes(key) && key !== 'id') {
            partnerData[key] = data[key];
        }
    });
    
    const fields = Object.keys(partnerData);
    const values = fields.map(field => partnerData[field]);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    if (fields.length === 0) {
        return res.status(400).json({ message: 'Nenhum dado para atualizar.' });
    }
    
    const query = `UPDATE partners SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);
        req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: 'Parceiro atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar parceiro:', error);
        res.status(500).json({ error: 'Erro ao atualizar parceiro' });
    }
};

// --- UPDATE: Atualizar apenas os preços dos combustíveis ---
const updateFuelPrices = async (req, res) => {
    const { id } = req.params;
    const prices = req.body;
    
    if (!prices || typeof prices !== 'object' || Object.keys(prices).length === 0) {
        return res.status(400).json({ error: 'Dados de preços inválidos.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const priceUpdates = Object.entries(prices).map(([fuelType, price]) => {
            const query = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price) 
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            const numericPrice = parseFloat(price);
            return connection.execute(query, [id, fuelType, isNaN(numericPrice) ? 0 : numericPrice]);
        });
        
        await Promise.all(priceUpdates);
        await connection.commit();
        req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: 'Preços de combustível atualizados com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar preços:', error);
        res.status(500).json({ error: 'Erro ao atualizar os preços.' });
    } finally {
        connection.release();
    }
};

// --- UPDATE STATUS (Bloquear/Desbloquear) ---
const updatePartnerStatus = async (req, res) => {
    const { id } = req.params;
    const status = req.body.status || req.body.status_operacional; 

    if (!status) {
        return res.status(400).json({ error: "Status é obrigatório." });
    }

    try {
        await db.execute('UPDATE partners SET status_operacional = ? WHERE id = ?', [status, id]);
        req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: `Status do parceiro atualizado para ${status}.` });
    } catch (error) {
        console.error('Erro ao atualizar status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status do parceiro.' });
    }
};

// --- DELETE: Deletar um parceiro ---
const deletePartner = async (req, res) => {
    try {
        await db.execute('DELETE FROM partners WHERE id = ?', [req.params.id]);
        req.io.emit('server:sync', { targets: ['partners'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar parceiro:', error);
        res.status(500).json({ error: 'Erro ao deletar parceiro' });
    }
};

module.exports = {
    getAllPartners,
    getPartnerById,
    createPartner,
    updatePartner,
    updateFuelPrices,
    updatePartnerStatus,
    deletePartner,
};