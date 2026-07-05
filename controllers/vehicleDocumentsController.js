const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const listDocuments = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar documentos:', error);
        res.status(500).json({ error: 'Erro ao listar documentos' });
    }
};

const uploadDocument = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const { nome, tipo } = req.body;
    const url = `/uploads/${req.file.filename}`;
    const id = randomUUID();

    try {
        await db.execute(
            'INSERT INTO vehicle_documents (id, vehicle_id, nome, tipo, url, tamanho, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, req.params.id, nome || req.file.originalname, tipo || 'Outro', url, req.file.size, req.user?.id || null]
        );
        console.log(`📄 Documento adicionado ao veículo ${req.params.id}: ${nome}`);
        res.status(201).json({ id, url, nome, tipo });
    } catch (error) {
        console.error('❌ Erro ao salvar documento:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao salvar documento' });
    }
};

// Documentos dos veículos que estão na(s) obra(s) atual(is) do operador logado.
// Escopo: todas as obras onde o operador tem alocação ativa (dataSaida IS NULL),
// e todos os veículos atualmente nessas obras que possuam PDFs anexos.
const listMyObraDocuments = async (req, res) => {
    try {
        // req.user não traz employeeId — buscamos no banco.
        const [urows] = await db.execute('SELECT employeeId FROM users WHERE id = ?', [req.user.id]);
        const employeeId = urows[0]?.employeeId || null;
        if (!employeeId) {
            return res.json([]); // usuário sem funcionário vinculado → nenhuma obra
        }

        const [rows] = await db.execute(
            `SELECT vd.id, vd.vehicle_id, vd.nome, vd.tipo, vd.url, vd.tamanho, vd.created_at,
                    v.placa, v.modelo, v.registroInterno, v.tipo AS veiculo_tipo,
                    h.obraId, o.nome AS obra_nome
             FROM vehicle_documents vd
             JOIN vehicles v ON vd.vehicle_id = v.id
             JOIN obras_historico_veiculos h ON h.veiculoId = v.id AND h.dataSaida IS NULL
             LEFT JOIN obras o ON o.id = h.obraId
             WHERE h.obraId IN (
                 SELECT DISTINCT h2.obraId
                 FROM obras_historico_veiculos h2
                 WHERE h2.employeeId = ? AND h2.dataSaida IS NULL
             )
             ORDER BY o.nome, v.placa, vd.created_at DESC`,
            [employeeId]
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro ao listar documentos da obra do operador:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar documentos' });
    }
};

const deleteDocument = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT url FROM vehicle_documents WHERE id = ? AND vehicle_id = ?',
            [req.params.docId, req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Documento não encontrado.' });
        }

        const filePath = path.resolve(process.cwd(), 'public', rows[0].url.substring(1));
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            console.warn('[deleteDocument] Falha ao deletar arquivo físico:', e.message);
        }

        await db.execute('DELETE FROM vehicle_documents WHERE id = ?', [req.params.docId]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar documento:', error);
        res.status(500).json({ error: 'Erro ao deletar documento' });
    }
};

module.exports = { listDocuments, uploadDocument, deleteDocument, listMyObraDocuments };
