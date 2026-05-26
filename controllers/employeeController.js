const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

// ===================================================================================
// FUNÇÕES AUXILIARES
// ===================================================================================

const parseJsonSafe = (field) => {
    if (!field) return null;
    if (typeof field === 'object') return field;
    try {
        return JSON.parse(field);
    } catch (e) {
        return field;
    }
};

const cleanCpf = (cpf) => cpf ? cpf.replace(/\D/g, '') : '';

const toDateOrNull = (dateStr) => {
    if (!dateStr || dateStr === '') return null;
    return dateStr;
};

const valOrNull = (val) => {
    if (val === undefined || val === '') return null;
    return val;
};

// ===================================================================================
// CONTROLLERS
// ===================================================================================

// --- LISTAR TODOS ---
const getAllEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees ORDER BY nome ASC');

        let allocationMap = {};
        try {
            const [activeObraAllocations] = await db.query(`
                SELECT h.employeeId, v.registroInterno, v.modelo, v.placa, o.nome as obraNome
                FROM obras_historico_veiculos h
                INNER JOIN vehicles v ON h.veiculoId = v.id
                LEFT JOIN obras o ON h.obraId = o.id
                WHERE h.dataSaida IS NULL
            `);

            const [activeOpAllocations] = await db.query(`
                SELECT a.employeeId, v.registroInterno, v.modelo, v.placa, 'Operacional' as subGroup
                FROM vehicle_operational_assignment a
                INNER JOIN vehicles v ON a.vehicleId = v.id
            `);

            [...activeObraAllocations, ...activeOpAllocations].forEach(alloc => {
                const desc = alloc.registroInterno ? `${alloc.registroInterno}` : (alloc.placa || alloc.modelo);
                if (!allocationMap[alloc.employeeId]) { allocationMap[alloc.employeeId] = []; }
                if (!allocationMap[alloc.employeeId].includes(desc)) { allocationMap[alloc.employeeId].push(desc); }
            });
        } catch (err) { console.warn("Aviso: Erro ao buscar alocações ativas:", err.message); }

        let lastObraDates = [];
        let lastOpDates = [];
        try {
            const [obraRes] = await db.query(`SELECT employeeId, MAX(dataSaida) as lastDate FROM obras_historico_veiculos WHERE dataSaida IS NOT NULL GROUP BY employeeId`);
            lastObraDates = obraRes;
        } catch (err) { }

        try {
            const [opRes] = await db.query(`SELECT employeeId, MAX(endDate) as lastDate FROM vehicle_operational_assignment WHERE endDate IS NOT NULL GROUP BY employeeId`);
            lastOpDates = opRes;
        } catch (err) { }

        const getLastAllocationDate = (empId) => {
            const obraDateStr = lastObraDates.find(x => String(x.employeeId) === String(empId))?.lastDate;
            const opDateStr = lastOpDates.find(x => String(x.employeeId) === String(empId))?.lastDate;
            if (!obraDateStr && !opDateStr) return null;
            const obraDate = obraDateStr ? new Date(obraDateStr) : new Date(0);
            const opDate = opDateStr ? new Date(opDateStr) : new Date(0);
            return obraDate > opDate ? obraDate : opDate;
        };
        
        const cleanRows = rows.map(emp => {
            let statusLimpo = emp.status;
            if (statusLimpo && typeof statusLimpo === 'string' && statusLimpo.includes('{')) {
                try { statusLimpo = JSON.parse(statusLimpo).status || 'ativo'; } catch(e) { statusLimpo = 'ativo'; }
            }

            const currentAllocations = allocationMap[emp.id];
            const allocationData = {
                isAllocated: !!currentAllocations,
                description: currentAllocations ? currentAllocations.join(', ') : null
            };

            return {
                ...emp,
                status: statusLimpo || 'ativo',
                lastAllocationEnd: getLastAllocationDate(emp.id),
                alocacaoAtual: allocationData,
                alocadoEm: parseJsonSafe(emp.alocadoEm),
                aso: parseJsonSafe(emp.aso),
                epi: parseJsonSafe(emp.epi),
                cnh: parseJsonSafe(emp.cnh) || { 
                    numero: emp.cnhNumero,
                    categoria: emp.cnhCategoria,
                    validade: emp.cnhVencimento
                },
                certificados: parseJsonSafe(emp.certificados) || []
            };
        });

        res.json(cleanRows);
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

// --- BUSCAR POR ID ---
const getEmployeeById = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado' });
        
        const emp = rows[0];
        res.json({
            ...emp,
            aso: parseJsonSafe(emp.aso),
            epi: parseJsonSafe(emp.epi),
            cnh: parseJsonSafe(emp.cnh) || { numero: emp.cnhNumero, categoria: emp.cnhCategoria, validade: emp.cnhVencimento },
            certificados: parseJsonSafe(emp.certificados)
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar funcionário.' });
    }
};

// --- CRIAR FUNCIONÁRIO ---
const createEmployee = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const newId = uuidv4();
        
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        const cnhObj = data.cnh || {};
        const cnhJson = JSON.stringify(cnhObj);
        
        const cnhNumero = valOrNull(data.cnhNumero || cnhObj.numero);
        const cnhCategoria = valOrNull(data.cnhCategoria || cnhObj.categoria);
        const cnhVencimento = toDateOrNull(data.cnhVencimento || cnhObj.validade);

        // Novos Campos de RH
        const cnhEmissao = toDateOrNull(data.cnhEmissao);
        let exameToxicologicoVencimento = toDateOrNull(data.exameToxicologicoVencimento);

        // Lógica: Sugerir vencimento de toxicológico 2 anos e meio (30 meses) após emissão
        if (cnhEmissao && !exameToxicologicoVencimento) {
            const dataEmissaoObj = new Date(cnhEmissao);
            dataEmissaoObj.setMonth(dataEmissaoObj.getMonth() + 30);
            exameToxicologicoVencimento = dataEmissaoObj.toISOString().split('T')[0];
        }

        const dataNascimento = toDateOrNull(data.dataNascimento);
        const dataAdmissao = toDateOrNull(data.dataAdmissao);
        const dataContratacao = dataAdmissao; 

        const status = 'ativo';

        const values = [
            newId, 
            valOrNull(data.nome), 
            valOrNull(data.vulgo), 
            valOrNull(data.registroInterno), 
            valOrNull(data.cpf), 
            valOrNull(data.rg), 
            dataNascimento, 
            valOrNull(data.funcao), 
            valOrNull(data.contato), 
            valOrNull(data.email),
            valOrNull(data.endereco), 
            valOrNull(data.cidade), 
            dataAdmissao, 
            dataContratacao, 
            status,
            cnhNumero, 
            cnhCategoria, 
            cnhVencimento,
            cnhEmissao,
            exameToxicologicoVencimento,
            aso, 
            epi, 
            cnhJson, 
            certificados
        ];

        // Query sem a coluna telefone, mas com as novas colunas
        await connection.execute(
            `INSERT INTO employees (
                id, nome, vulgo, registroInterno, cpf, rg, dataNascimento, funcao, contato, email, 
                endereco, cidade, dataAdmissao, dataContratacao, status, 
                cnhNumero, cnhCategoria, cnhVencimento, cnhEmissao, exameToxicologicoVencimento,
                aso, epi, cnh, certificados
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values
        );

        const cpfLimpo = cleanCpf(data.cpf);
        if (cpfLimpo && cpfLimpo.length > 5) {
            const userEmail = `${cpfLimpo}@frotamak.com`;
            const [existingUsers] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
            
            if (existingUsers.length === 0) {
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(cpfLimpo, salt);
                const newUserId = uuidv4();

                await connection.execute(
                    `INSERT INTO users (
                        id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [newUserId, data.nome, userEmail, hashedPassword, 'operador', 'operador', 'ativo', 1, newId]
                );
            }
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['employees'] });
        res.status(201).json({ message: 'Funcionário criado com sucesso.', id: newId });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE employee:', error);
        res.status(500).json({ 
            error: error.message,
            sqlMessage: error.sqlMessage 
        });
    } finally {
        connection.release();
    }
};

// --- ATUALIZAR FUNCIONÁRIO ---
const updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const aso = JSON.stringify(data.aso || {});
        const epi = JSON.stringify(data.epi || {});
        const certificados = JSON.stringify(data.certificados || []);
        
        const cnhObj = data.cnh || {};
        const cnhJson = JSON.stringify(cnhObj);
        const cnhNumero = valOrNull(data.cnhNumero || cnhObj.numero);
        const cnhCategoria = valOrNull(data.cnhCategoria || cnhObj.categoria);
        const cnhVencimento = toDateOrNull(data.cnhVencimento || cnhObj.validade);

        // Novos Campos RH
        const cnhEmissao = toDateOrNull(data.cnhEmissao);
        let exameToxicologicoVencimento = toDateOrNull(data.exameToxicologicoVencimento);

        if (cnhEmissao && !exameToxicologicoVencimento) {
            const dataEmissaoObj = new Date(cnhEmissao);
            dataEmissaoObj.setMonth(dataEmissaoObj.getMonth() + 30);
            exameToxicologicoVencimento = dataEmissaoObj.toISOString().split('T')[0];
        }

        const dataNascimento = toDateOrNull(data.dataNascimento);
        const dataAdmissao = toDateOrNull(data.dataAdmissao);
        const dataDesligamento = toDateOrNull(data.dataDesligamento);

        let statusUpdateClause = "";
        
        let params = [
            valOrNull(data.nome), 
            valOrNull(data.vulgo), 
            valOrNull(data.registroInterno), 
            valOrNull(data.cpf), 
            valOrNull(data.rg), 
            dataNascimento, 
            valOrNull(data.funcao), 
            valOrNull(data.contato), 
            valOrNull(data.email), 
            valOrNull(data.endereco), 
            valOrNull(data.cidade), 
            dataAdmissao, 
            cnhNumero, 
            cnhCategoria, 
            cnhVencimento,
            cnhEmissao,
            exameToxicologicoVencimento,
            aso, 
            epi, 
            cnhJson, 
            certificados, 
            dataDesligamento
        ];

        if (data.status && typeof data.status === 'string' && !data.status.includes('{')) {
             statusUpdateClause = ", status = ?";
             params.push(data.status);
        }

        params.push(id);

        await connection.execute(
            `UPDATE employees SET 
                nome=?, vulgo=?, registroInterno=?, cpf=?, rg=?, dataNascimento=?, funcao=?, 
                contato=?, email=?, endereco=?, cidade=?, 
                dataAdmissao=?, 
                cnhNumero=?, cnhCategoria=?, cnhVencimento=?, cnhEmissao=?, exameToxicologicoVencimento=?,
                aso=?, epi=?, cnh=?, certificados=?, dataDesligamento=?
                ${statusUpdateClause}
             WHERE id=?`,
            params
        );

        if (data.status === 'inativo') {
            await connection.execute(`UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`, [id]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Funcionário atualizado.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE employee:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const deleteEmployee = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM employees WHERE id = ?', [id]);
        await db.execute('DELETE FROM users WHERE employeeId = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Funcionário excluído.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir funcionário.' });
    }
};

// --- HISTÓRICO COMPLETO ---
const getEmployeeHistory = async (req, res) => {
    const { id } = req.params;
    try {
        let obraHistory = [];
        let operationalHistory = [];

        try {
            const [rows] = await db.execute(
                `SELECT h.*, o.nome as obraNome, v.placa, v.modelo, v.registroInterno as veiculoRegistro
                 FROM obras_historico_veiculos h
                 LEFT JOIN obras o ON h.obraId = o.id
                 LEFT JOIN vehicles v ON h.veiculoId = v.id
                 WHERE h.employeeId = ? 
                 ORDER BY h.dataEntrada DESC`, [id]
            );
            obraHistory = rows;
        } catch (e) { console.warn("Erro ao buscar histórico obras:", e.message); }

        try {
            const [rows] = await db.execute(
                `SELECT a.*, v.placa, v.modelo, v.registroInterno 
                 FROM vehicle_operational_assignment a
                 LEFT JOIN vehicles v ON a.vehicleId = v.id
                 WHERE a.employeeId = ?
                 ORDER BY a.startDate DESC`, [id]
            );
            operationalHistory = rows;
        } catch (e) { console.warn("Erro ao buscar histórico operacional:", e.message); }

        const unifiedHistory = {
            obras: obraHistory.map(h => ({
                id: h.id,
                type: 'obra',
                obraNome: h.obraNome || 'Obra Desconhecida',
                role: h.tipo || 'Alocação',
                vehicleInfo: h.modelo ? `${h.veiculoRegistro || 'S/N'} - ${h.modelo}` : null,
                startDate: h.dataEntrada,
                endDate: h.dataSaida
            })),
            veiculos: operationalHistory.map(h => ({
                id: h.id,
                type: 'veiculo',
                modelo: h.modelo,
                placa: h.placa,
                registroInterno: h.registroInterno,
                assignedAt: h.startDate,
                subGroup: h.subGroup
            }))
        };
        res.json(unifiedHistory);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar histórico completo." });
    }
};

// --- ATUALIZAR STATUS ---
const updateEmployeeStatus = async (req, res) => {
    const { id } = req.params;
    const { status, date } = req.body;
    if (!status || !date) return res.status(400).json({ message: "Status e Data obrigatórios." });

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        let queryEmployee = '';
        let paramsEmployee = [];
        let eventType = '';
        let notes = '';

        if (status === 'ativo') {
            queryEmployee = 'UPDATE employees SET status = ?, dataAdmissao = ?, dataDesligamento = NULL WHERE id = ?';
            paramsEmployee = ['ativo', date, id];
            eventType = 'readmissao';
            notes = 'Funcionário readmitido via Sistema.';
        } else {
            queryEmployee = 'UPDATE employees SET status = ?, dataDesligamento = ? WHERE id = ?';
            paramsEmployee = ['inativo', date, id];
            eventType = 'desligamento';
            notes = 'Funcionário desligado via Sistema.';
        }

        await connection.execute(queryEmployee, paramsEmployee);
        const eventId = uuidv4();
        await connection.execute(
            `INSERT INTO employee_events_history (id, employeeId, eventType, eventDate, notes) VALUES (?, ?, ?, ?, ?)`,
            [eventId, id, eventType, date, notes]
        );

        if (status === 'inativo') {
            await connection.execute(`UPDATE users SET status = 'inativo', canAccessRefueling = 0 WHERE employeeId = ?`, [id]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: `Status atualizado para ${status}.` });

    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Erro ao atualizar status.' });
    } finally {
        connection.release();
    }
};

// --- SINCRONIZAR USUÁRIOS ---
const syncActiveEmployeesToUsers = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [employees] = await connection.query("SELECT * FROM employees WHERE status = 'ativo'");
        let count = 0;
        for (const emp of employees) {
            const cpfLimpo = cleanCpf(emp.cpf);
            if (!cpfLimpo || cpfLimpo.length < 5) continue; 
            
            const userEmail = `${cpfLimpo}@frotamak.com`;
            const [exists] = await connection.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
            
            if (exists.length === 0) {
                const newUserId = uuidv4();
                const hash = await bcrypt.hash(cpfLimpo, 10);
                await connection.execute(
                    `INSERT INTO users (id, name, email, password, role, user_type, status, canAccessRefueling, employeeId, data_criacao) 
                     VALUES (?, ?, ?, ?, 'operador', 'operador', 'ativo', 1, ?, NOW())`,
                    [newUserId, emp.nome, userEmail, hash, emp.id]
                );
                count++;
            }
        }
        await connection.commit();
        res.json({ message: `Sincronização concluída. ${count} usuários criados.` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- REGISTRAR NOVO EXAME TOXICOLÓGICO (NOVO) ---
const registerExamUpdate = async (req, res) => {
    const { id } = req.params;
    const { dataExame, proximoVencimento } = req.body;

    if (!dataExame || !proximoVencimento) {
        return res.status(400).json({ error: "Data do exame e próximo vencimento são obrigatórios." });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Atualiza no cadastro do funcionário
        await connection.execute(
            `UPDATE employees SET exameToxicologicoVencimento = ? WHERE id = ?`,
            [proximoVencimento, id]
        );

        // Insere log de auditoria na nova tabela criada
        const logId = uuidv4();
        await connection.execute(
            `INSERT INTO employee_exam_logs (id, employeeId, dataExame, proximoVencimento, registradoPor) VALUES (?, ?, ?, ?, ?)`,
            [logId, id, dataExame, proximoVencimento, req.user ? req.user.name : 'Sistema']
        );

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['employees'] });
        res.json({ message: 'Exame toxicológico atualizado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro registerExamUpdate:", error);
        res.status(500).json({ error: 'Erro ao atualizar exame.' });
    } finally {
        connection.release();
    }
};

// --- ALTERAR STATUS DE AFASTAMENTO / FÉRIAS (NOVO) ---
const updateLeaveStatus = async (req, res) => {
    const { id } = req.params;
    const { tipo, dataTermino } = req.body;

    // Usando transação para garantir que a mudança de status e a desocupação de veículos ocorram juntas
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        if (!tipo) {
            // Cancelar ou remover afastamento
            await connection.execute(
                `UPDATE employees SET statusAfastamentoTipo = NULL, statusAfastamentoTermino = NULL, dataRetornoAfastamento = CURDATE() WHERE id = ?`,
                [id]
            );
        } else {
            // Inserir afastamento
            if (!['ferias', 'atestado'].includes(tipo) || !dataTermino) {
                return res.status(400).json({ error: "Tipo inválido ou data de término não informada." });
            }
            await connection.execute(
                `UPDATE employees SET statusAfastamentoTipo = ?, statusAfastamentoTermino = ? WHERE id = ?`,
                [tipo, dataTermino, id]
            );

            // DESALOCAÇÃO AUTOMÁTICA
            // Registra a data/hora exata atual para fechar a alocação do funcionário
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

            // 1. Remove o funcionário de qualquer veículo alocado em Obra
            await connection.execute(`
                UPDATE obras_historico_veiculos 
                SET dataSaida = ? 
                WHERE employeeId = ? AND dataSaida IS NULL
            `, [now, id]);

            // 2. Remove o funcionário de qualquer veículo em uso Operacional
            await connection.execute(`
                UPDATE vehicle_operational_assignment 
                SET endDate = ? 
                WHERE employeeId = ? AND endDate IS NULL
            `, [now, id]);
        }

        await connection.commit();
        
        // Dispara o socket para atualizar também os veículos (que agora ficarão livres) e obras
        if (req.io) req.io.emit('server:sync', { targets: ['employees', 'vehicles', 'obras'] });
        res.json({ message: 'Status atualizado e funcionário desalocado de veículos/obras.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro updateLeaveStatus:", error);
        res.status(500).json({ error: 'Erro ao atualizar afastamento.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllEmployees,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    getEmployeeHistory,
    updateEmployeeStatus,
    syncActiveEmployeesToUsers,
    registerExamUpdate,
    updateLeaveStatus
};