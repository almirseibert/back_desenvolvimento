const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET: Listar Pneus
const getAllTires = async (req, res) => {
    try {
        const query = `
            SELECT t.*, v.placa as vehiclePlaca, v.registroInterno as vehicleRegistro 
            FROM tires t
            LEFT JOIN vehicles v ON t.currentVehicleId = v.id
            ORDER BY t.fireNumber ASC
        `;
        const [rows] = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar pneus:', error);
        res.status(500).json({ error: 'Erro ao buscar pneus.' });
    }
};

// POST: Cadastrar Pneu
const createTire = async (req, res) => {
    const data = req.body;
    if (!data.fireNumber || !data.brand || !data.size) {
        return res.status(400).json({ error: 'Marca de fogo, Marca e Tamanho são obrigatórios.' });
    }

    const id = uuidv4();
    const status = 'Estoque'; 

    const query = `
        INSERT INTO tires (id, fireNumber, brand, model, size, tireCondition, status, purchaseDate, price, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    try {
        await db.execute(query, [
            id, 
            data.fireNumber, 
            data.brand, 
            data.model || null, 
            data.size, 
            data.tireCondition || 'Novo', 
            status, 
            data.purchaseDate || null, 
            data.price || null, 
            'Almoxarifado'
        ]);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['tires'] });

        res.status(201).json({ message: 'Pneu cadastrado com sucesso!' });
    } catch (error) {
        console.error('Erro ao criar pneu:', error);
        res.status(500).json({ error: 'Erro ao criar pneu. Verifique se a Marca de Fogo já existe.' });
    }
};

// PUT: Editar Pneu
const updateTire = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    
    // Remove campos que não devem ser editados diretamente via PUT simples
    delete data.id;
    delete data.currentVehicleId;
    delete data.position;
    
    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map(field => `${field} = ?`).join(', ');

    const query = `UPDATE tires SET ${setClause} WHERE id = ?`;

    try {
        await db.execute(query, [...values, id]);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['tires'] });

        res.json({ message: 'Pneu atualizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar pneu.' });
    }
};

// POST: Movimentação (Instalar/Remover/Transferir/Manutenção/Sucata)
const registerTransaction = async (req, res) => {
    const { 
        tireId, 
        vehicleId = null, 
        type, // 'install', 'remove', 'transfer', 'maintenance', 'scrap', 'restock'
        position = null, 
        date = new Date(), 
        odometer = null, 
        horimeter = null, 
        observation = '',
        employeeName = null,
        obraName = null,
        vendorName = null 
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        if (type === 'install') {
            if (!vehicleId || !position) throw new Error("Veículo e Posição são obrigatórios para instalação.");
            
            // Verifica ocupação
            const [occupied] = await connection.execute(
                'SELECT id FROM tires WHERE currentVehicleId = ? AND position = ?',
                [vehicleId, position]
            );
            if (occupied.length > 0) {
                throw new Error(`A posição ${position} já possui um pneu instalado. Remova-o antes.`);
            }

            await connection.execute(
                `UPDATE tires SET status = 'Em Uso', currentVehicleId = ?, position = ?, location = 'Veículo' WHERE id = ?`,
                [vehicleId, position, tireId]
            );
        } else if (type === 'remove') {
            await connection.execute(
                `UPDATE tires SET status = 'Estoque', currentVehicleId = NULL, position = NULL, location = 'Almoxarifado' WHERE id = ?`,
                [tireId]
            );
        } else if (type === 'transfer') {
            const locDesc = `Obra: ${obraName || 'Desconhecida'}`;
            await connection.execute(
                `UPDATE tires SET status = 'Step/Reserva', currentVehicleId = NULL, position = NULL, location = ? WHERE id = ?`,
                [locDesc, tireId]
            );
        } else if (type === 'maintenance') {
            const locDesc = `Fornecedor: ${vendorName || 'Desconhecido'}`;
            await connection.execute(
                `UPDATE tires SET status = 'Recapagem', currentVehicleId = NULL, position = NULL, location = ? WHERE id = ?`,
                [locDesc, tireId]
            );
        } else if (type === 'restock') {
            await connection.execute(
                `UPDATE tires SET status = 'Estoque', location = 'Almoxarifado' WHERE id = ?`,
                [tireId]
            );
        } else if (type === 'scrap') {
            await connection.execute(
                `UPDATE tires SET status = 'Sucata', currentVehicleId = NULL, position = NULL, location = 'Descarte' WHERE id = ?`,
                [tireId]
            );
        }

        // Histórico do Pneu
        const transId = uuidv4();
        await connection.execute(
            `INSERT INTO tire_transactions (id, tireId, vehicleId, type, position, date, odometer, horimeter, observation, employeeName)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [transId, tireId, vehicleId, type, position, date, odometer, horimeter, observation, employeeName]
        );

        // --- ATUALIZAÇÃO DA LEITURA DO VEÍCULO (UNIFICADO) ---
        // Se uma leitura foi informada durante a troca, atualizamos o veículo
        if (vehicleId && (odometer || horimeter)) {
            const [vehicles] = await connection.execute('SELECT mediaCalculo FROM vehicles WHERE id = ?', [vehicleId]);
            if (vehicles.length > 0) {
                const vehicle = vehicles[0];
                let updateV = '';
                let val = 0;

                const isHourBased = vehicle.mediaCalculo === 'horimetro';

                if (isHourBased && horimeter) {
                    // Atualiza horimetro e limpa legados
                    updateV = 'UPDATE vehicles SET horimetro = ?, horimetroDigital = NULL, horimetroAnalogico = NULL WHERE id = ?';
                    val = parseFloat(horimeter);
                } else if (!isHourBased && odometer) {
                    updateV = 'UPDATE vehicles SET odometro = ? WHERE id = ?';
                    val = parseFloat(odometer);
                }

                if (updateV && val > 0) {
                    await connection.execute(updateV, [val, vehicleId]);
                }
            }
        }

        await connection.commit();

        // EMITIR EVENTO SOCKET.IO
        // Movimentação impacta pneus e possivelmente km/horímetro de veículos
        req.io.emit('server:sync', { targets: ['tires', 'vehicles'] });

        res.json({ message: 'Movimentação registrada com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Pneu Transaction:", error);
        res.status(500).json({ error: error.message || 'Erro interno ao registrar movimentação.' });
    } finally {
        connection.release();
    }
};

// GET: Histórico de um Pneu
const getTireHistory = async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT tt.*, v.placa, v.registroInterno 
            FROM tire_transactions tt
            LEFT JOIN vehicles v ON tt.vehicleId = v.id
            WHERE tt.tireId = ?
            ORDER BY tt.date DESC
        `;
        const [rows] = await db.query(query, [id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico.' });
    }
};

// GET: Histórico de Pneus de um VEÍCULO
const getVehicleTireHistory = async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const query = `
            SELECT tt.*, t.fireNumber, t.brand, t.model, t.size
            FROM tire_transactions tt
            JOIN tires t ON tt.tireId = t.id
            WHERE tt.vehicleId = ?
            ORDER BY tt.date DESC, tt.createdAt DESC
        `;
        const [rows] = await db.query(query, [vehicleId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico do veículo.' });
    }
};

module.exports = {
    getAllTires,
    createTire,
    updateTire,
    registerTransaction,
    getTireHistory,
    getVehicleTireHistory
};