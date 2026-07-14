// controllers/terceiroContratoController.js
// Contratos de terceirizados: 1 contrato = 1 terceiro (locador) + 1 obra, valor
// FECHADO. Horas executadas são acompanhamento físico; o saldo a pagar é
// calculado no frontend (utils/terceirizados.js) = valorTotal − diesel − adiantamentos.
const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateContratoPdf } = require('../services/contratoPdfGenerator');

const CONTRATOS_PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'contratos');

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

const normalizeMaquinas = (m) => {
    if (Array.isArray(m)) return m.filter(Boolean);
    if (typeof m === 'string') {
        try { const p = JSON.parse(m); return Array.isArray(p) ? p.filter(Boolean) : []; } catch { return []; }
    }
    return [];
};

// Impede que uma máquina fique vinculada a mais de um contrato (1 máquina : 1 contrato).
// `exceptId` ignora o próprio contrato na edição. Retorna array de vehicleIds em conflito.
const maquinasEmConflito = async (maquinas, exceptId = null) => {
    if (!maquinas.length) return [];
    const [rows] = await db.query(
        'SELECT id, maquinas FROM terceiro_contratos WHERE maquinas IS NOT NULL' +
        (exceptId ? ' AND id <> ?' : ''),
        exceptId ? [exceptId] : []
    );
    const usadas = new Set();
    rows.forEach((r) => normalizeMaquinas(r.maquinas).forEach((id) => usadas.add(id)));
    return maquinas.filter((id) => usadas.has(id));
};

// Gera número sequencial por ano: CT-AAAA-NNN (idempotente por UNIQUE no banco).
const gerarNumero = async () => {
    const ano = new Date().getFullYear();
    const prefixo = `CT-${ano}-`;
    const [rows] = await db.query(
        'SELECT numero FROM terceiro_contratos WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1',
        [`${prefixo}%`]
    );
    let seq = 1;
    if (rows.length > 0) {
        const ultimo = parseInt(String(rows[0].numero).split('-').pop(), 10);
        if (Number.isFinite(ultimo)) seq = ultimo + 1;
    }
    return `${prefixo}${String(seq).padStart(3, '0')}`;
};

const getTerceiroContratos = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM terceiro_contratos ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro ao listar contratos de terceirizados:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar contratos.' });
    }
};

const createTerceiroContrato = async (req, res) => {
    const {
        locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
        valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas, createdBy,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const horas = num(horasContratadas);
    const vHora = num(valorHora);
    // Valor total: usa o enviado; se ausente, deriva de horas × valor/hora.
    const vTotal = valorTotal != null && valorTotal !== '' ? num(valorTotal) : horas * vHora;
    const maqs = normalizeMaquinas(maquinas);

    const id = randomUUID();
    const criadoPor = createdBy?.userEmail || req.user?.email || null;

    try {
        const conflito = await maquinasEmConflito(maqs);
        if (conflito.length > 0) {
            return res.status(400).json({ error: 'Uma ou mais máquinas já estão vinculadas a outro contrato.' });
        }
        const numero = await gerarNumero();
        await db.execute(
            `INSERT INTO terceiro_contratos
                (id, numero, locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
                 valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas, created_by_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, numero, locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             JSON.stringify(maqs), criadoPor]
        );
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('❌ Erro ao criar contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao criar contrato.' });
    }
};

const updateTerceiroContrato = async (req, res) => {
    const { id } = req.params;
    const {
        locadorId, obraId, tipoMaquina, horasContratadas, valorHora,
        valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const horas = num(horasContratadas);
    const vHora = num(valorHora);
    const vTotal = valorTotal != null && valorTotal !== '' ? num(valorTotal) : horas * vHora;
    const maqs = normalizeMaquinas(maquinas);

    try {
        const conflito = await maquinasEmConflito(maqs, id);
        if (conflito.length > 0) {
            return res.status(400).json({ error: 'Uma ou mais máquinas já estão vinculadas a outro contrato.' });
        }
        const [result] = await db.execute(
            `UPDATE terceiro_contratos
                SET locadorId = ?, obraId = ?, tipoMaquina = ?, horasContratadas = ?, valorHora = ?,
                    valorTotal = ?, vigenciaInicio = ?, vigenciaFim = ?, status = ?, observacoes = ?, maquinas = ?
              WHERE id = ?`,
            [locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             JSON.stringify(maqs), id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json(rows[0]);
    } catch (error) {
        console.error('❌ Erro ao atualizar contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao atualizar contrato.' });
    }
};

const deleteTerceiroContrato = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.execute('DELETE FROM terceiro_contratos WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.status(204).end();
    } catch (error) {
        console.error('❌ Erro ao excluir contrato de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao excluir contrato.' });
    }
};

// Gera (ou regenera) o PDF do contrato, salva em public/uploads/contratos e
// grava a pdfUrl. Retorna { url }.
const gerarContratoPdf = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM terceiro_contratos WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
        const contrato = rows[0];

        const [locRows] = await db.query('SELECT * FROM partners WHERE id = ?', [contrato.locadorId]);
        const [obraRows] = await db.query('SELECT * FROM obras WHERE id = ?', [contrato.obraId]);
        const locador = locRows[0] || {};
        const obra = obraRows[0] || {};

        const buffer = await generateContratoPdf({ contrato, locador, obra });

        fs.mkdirSync(CONTRATOS_PDF_DIR, { recursive: true });
        const filename = `contrato_${String(contrato.numero || id).replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
        fs.writeFileSync(path.join(CONTRATOS_PDF_DIR, filename), buffer);
        const url = `/uploads/contratos/${filename}`;

        await db.execute('UPDATE terceiro_contratos SET pdfUrl = ? WHERE id = ?', [url, id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceiroContratos'] });
        res.json({ url });
    } catch (error) {
        console.error('❌ Erro ao gerar PDF do contrato:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao gerar PDF do contrato.' });
    }
};

module.exports = {
    getTerceiroContratos,
    createTerceiroContrato,
    updateTerceiroContrato,
    deleteTerceiroContrato,
    gerarContratoPdf,
};
