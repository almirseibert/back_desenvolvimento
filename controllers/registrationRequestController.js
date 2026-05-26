// controllers/registrationRequestController.js
const db = require('../database');

const getAllRegistrationRequests = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM registration_requests');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar solicitações de cadastro:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações de cadastro' });
    }
};

const createRegistrationRequest = async (req, res) => {
    const data = req.body;
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO registration_requests (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        const [result] = await db.execute(query, values);

        // EMITIR EVENTO SOCKET.IO
        // Notifica o painel administrativo imediatamente
        req.io.emit('server:sync', { targets: ['admin_requests'] });

        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error('Erro ao criar solicitação de cadastro:', error);
        res.status(500).json({ error: 'Erro ao criar solicitação de cadastro' });
    }
};

const deleteRegistrationRequest = async (req, res) => {
    try {
        await db.execute('DELETE FROM registration_requests WHERE id = ?', [req.params.id]);

        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['admin_requests'] });

        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar solicitação de cadastro:', error);
        res.status(500).json({ error: 'Erro ao deletar solicitação de cadastro' });
    }
};

module.exports = {
    getAllRegistrationRequests,
    createRegistrationRequest,
    deleteRegistrationRequest,
};