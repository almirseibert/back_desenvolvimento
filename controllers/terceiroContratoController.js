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

const FOROS_VALIDOS = ['Santa Maria', 'Lajeado'];

// Cláusulas jurídicas parametrizáveis: aplica default do contrato-modelo quando
// o campo não vier preenchido (contratos antigos, ou criação rápida).
const clausulasJuridicas = (body) => ({
    prazoPagamentoDias: body.prazoPagamentoDias != null && body.prazoPagamentoDias !== '' ? parseInt(body.prazoPagamentoDias, 10) || 30 : 30,
    percentualJurosMora: body.percentualJurosMora != null && body.percentualJurosMora !== '' ? num(body.percentualJurosMora) : 1,
    percentualMultaMora: body.percentualMultaMora != null && body.percentualMultaMora !== '' ? num(body.percentualMultaMora) : 1,
    prazoSubstituicaoHoras: body.prazoSubstituicaoHoras != null && body.prazoSubstituicaoHoras !== '' ? parseInt(body.prazoSubstituicaoHoras, 10) || 48 : 48,
    prazoInicioServicoHoras: body.prazoInicioServicoHoras != null && body.prazoInicioServicoHoras !== '' ? parseInt(body.prazoInicioServicoHoras, 10) || 48 : 48,
    percentualMultaInadimplemento: body.percentualMultaInadimplemento != null && body.percentualMultaInadimplemento !== '' ? num(body.percentualMultaInadimplemento) : 0.5,
    avisoPrevioRescisaoDias: body.avisoPrevioRescisaoDias != null && body.avisoPrevioRescisaoDias !== '' ? parseInt(body.avisoPrevioRescisaoDias, 10) || 2 : 2,
    foroComarca: FOROS_VALIDOS.includes(body.foroComarca) ? body.foroComarca : 'Santa Maria',
});

const normalizeMaquinas = (m) => {
    if (Array.isArray(m)) return m.filter(Boolean);
    if (typeof m === 'string') {
        try { const p = JSON.parse(m); return Array.isArray(p) ? p.filter(Boolean) : []; } catch { return []; }
    }
    return [];
};

// Normaliza os itens do plano de trabalho ([{ type, hours, price }]).
const normalizeItens = (itens) => {
    let arr = itens;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((i) => i && i.type)
        .map((i) => ({ type: String(i.type), hours: num(i.hours), price: num(i.price) }));
};

// A partir do plano, calcula horas totais e valor total (por horas) ou usa o valor fechado.
const derivarAgregados = ({ contractType, itens, horasContratadas, valorHora, valorTotal }) => {
    if (contractType === 'fechado') {
        return {
            horas: num(horasContratadas),
            vHora: 0,
            vTotal: valorTotal != null && valorTotal !== '' ? num(valorTotal) : 0,
            itens: [],
        };
    }
    // 'horas': se vier plano de itens, ele é a fonte de verdade; senão cai no par simples.
    if (itens.length > 0) {
        const horas = itens.reduce((a, i) => a + i.hours, 0);
        const vTotal = itens.reduce((a, i) => a + i.hours * i.price, 0);
        const vHora = horas > 0 ? Math.round((vTotal / horas) * 100) / 100 : 0;
        return { horas, vHora, vTotal, itens };
    }
    const horas = num(horasContratadas);
    const vHora = num(valorHora);
    const vTotal = valorTotal != null && valorTotal !== '' ? num(valorTotal) : horas * vHora;
    return { horas, vHora, vTotal, itens: [] };
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
        contractType, itensContratados,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const tipoContrato = contractType === 'fechado' ? 'fechado' : 'horas';
    const itens = normalizeItens(itensContratados);
    const { horas, vHora, vTotal, itens: itensFinal } = derivarAgregados({
        contractType: tipoContrato, itens, horasContratadas, valorHora, valorTotal,
    });
    const maqs = normalizeMaquinas(maquinas);
    const clausulas = clausulasJuridicas(req.body);

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
                 valorTotal, vigenciaInicio, vigenciaFim, status, observacoes, maquinas,
                 contractType, itensContratados, created_by_email,
                 prazoPagamentoDias, percentualJurosMora, percentualMultaMora,
                 prazoSubstituicaoHoras, prazoInicioServicoHoras, percentualMultaInadimplemento,
                 avisoPrevioRescisaoDias, foroComarca)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, numero, locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             JSON.stringify(maqs), tipoContrato, JSON.stringify(itensFinal), criadoPor,
             clausulas.prazoPagamentoDias, clausulas.percentualJurosMora, clausulas.percentualMultaMora,
             clausulas.prazoSubstituicaoHoras, clausulas.prazoInicioServicoHoras, clausulas.percentualMultaInadimplemento,
             clausulas.avisoPrevioRescisaoDias, clausulas.foroComarca]
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
        contractType, itensContratados,
    } = req.body;

    if (!locadorId) return res.status(400).json({ error: 'Terceiro (locador) é obrigatório.' });
    if (!obraId) return res.status(400).json({ error: 'Obra é obrigatória.' });

    const tipoContrato = contractType === 'fechado' ? 'fechado' : 'horas';
    const itens = normalizeItens(itensContratados);
    const { horas, vHora, vTotal, itens: itensFinal } = derivarAgregados({
        contractType: tipoContrato, itens, horasContratadas, valorHora, valorTotal,
    });
    const maqs = normalizeMaquinas(maquinas);
    const clausulas = clausulasJuridicas(req.body);

    try {
        const conflito = await maquinasEmConflito(maqs, id);
        if (conflito.length > 0) {
            return res.status(400).json({ error: 'Uma ou mais máquinas já estão vinculadas a outro contrato.' });
        }
        const [result] = await db.execute(
            `UPDATE terceiro_contratos
                SET locadorId = ?, obraId = ?, tipoMaquina = ?, horasContratadas = ?, valorHora = ?,
                    valorTotal = ?, vigenciaInicio = ?, vigenciaFim = ?, status = ?, observacoes = ?, maquinas = ?,
                    contractType = ?, itensContratados = ?,
                    prazoPagamentoDias = ?, percentualJurosMora = ?, percentualMultaMora = ?,
                    prazoSubstituicaoHoras = ?, prazoInicioServicoHoras = ?, percentualMultaInadimplemento = ?,
                    avisoPrevioRescisaoDias = ?, foroComarca = ?
              WHERE id = ?`,
            [locadorId, obraId, tipoMaquina || null, horas, vHora, vTotal,
             vigenciaInicio || null, vigenciaFim || null, status || 'ativo', observacoes || null,
             JSON.stringify(maqs), tipoContrato, JSON.stringify(itensFinal),
             clausulas.prazoPagamentoDias, clausulas.percentualJurosMora, clausulas.percentualMultaMora,
             clausulas.prazoSubstituicaoHoras, clausulas.prazoInicioServicoHoras, clausulas.percentualMultaInadimplemento,
             clausulas.avisoPrevioRescisaoDias, clausulas.foroComarca, id]
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
