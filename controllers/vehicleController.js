const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureComboioPartner, deactivateComboioPartner } = require('../utils/ensureComboioPartner');
const { openPeriod: openComboioPeriod, closeActivePeriod: closeComboioPeriod } = require('../utils/comboioPeriodo');

// --- FUNÇÕES AUXILIARES ---

const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; 
    
    if (typeof field === 'string' && (field.startsWith('{') || field.startsWith('['))) {
        try {
            const parsed = JSON.parse(field);
            return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
        } catch (e) {
            console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
            return defaultValue; 
        }
    }
    return defaultValue;
};

const parseVehicleJsonFields = (vehicle) => {
    if (!vehicle) return null;
    const newVehicle = { ...vehicle };
    
    newVehicle.fuelLevels = parseJsonSafe(newVehicle.fuelLevels, 'fuelLevels');
    newVehicle.alocadoEm = parseJsonSafe(newVehicle.alocadoEm, 'alocadoEm');
    newVehicle.maintenanceLocation = parseJsonSafe(newVehicle.maintenanceLocation, 'maintenanceLocation');
    newVehicle.operationalAssignment = parseJsonSafe(newVehicle.operationalAssignment, 'operationalAssignment');
    
    return newVehicle;
};

// --- CRUD BÁSICO ---

const getAllVehicles = async (req, res) => {
    try {
        // LEFT JOIN + subquery agrupada: O(V + C) em vez de O(V × C)
        const query = `
            SELECT v.*, COALESCE(cc.cnt, 0) AS checklistCount
            FROM vehicles v
            LEFT JOIN (
                SELECT vehicle_id, COUNT(*) AS cnt FROM checklists GROUP BY vehicle_id
            ) cc ON cc.vehicle_id = v.id
            ORDER BY v.registroInterno ASC, v.placa ASC
        `;
        const [rows] = await db.execute(query);
        const vehicles = rows.map(parseVehicleJsonFields);

        // Vínculos ativos (reboque/acessório atrelado a um veículo principal).
        // Uma query auxiliar + mapas em JS — evita JSON_ARRAYAGG e é O(V + L).
        const [links] = await db.execute(
            'SELECT id, parent_vehicle_id, child_vehicle_id, tipo_vinculo FROM vehicle_links WHERE ativo = 1'
        );
        const childToParent = new Map();   // childId → { linkId, parentId, tipo_vinculo }
        const parentToChildren = new Map(); // parentId → [{ linkId, id, tipo_vinculo }]
        for (const l of links) {
            childToParent.set(l.child_vehicle_id, {
                linkId: l.id, parentId: l.parent_vehicle_id, tipo_vinculo: l.tipo_vinculo,
            });
            if (!parentToChildren.has(l.parent_vehicle_id)) parentToChildren.set(l.parent_vehicle_id, []);
            parentToChildren.get(l.parent_vehicle_id).push({
                linkId: l.id, id: l.child_vehicle_id, tipo_vinculo: l.tipo_vinculo,
            });
        }
        for (const v of vehicles) {
            const parent = childToParent.get(v.id);
            v.linkedParentId  = parent ? parent.parentId : null;
            v.linkId          = parent ? parent.linkId : null;
            v.linkVinculoTipo = parent ? parent.tipo_vinculo : null;
            v.linkedChildren  = parentToChildren.get(v.id) || [];
        }

        res.json(vehicles);
    } catch (error) {
        console.error('Erro ao buscar veículos:', error);
        res.status(500).json({ error: 'Erro ao buscar veículos' });
    }
};

const getVehicleById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Veículo não encontrado' });
        }
        
        const vehicle = parseVehicleJsonFields(rows[0]);
        
        const [historyRows] = await db.execute('SELECT * FROM vehicle_history WHERE vehicleId = ? ORDER BY startDate DESC LIMIT 50', [req.params.id]);
        vehicle.history = historyRows.map(h => ({
            ...h,
            details: parseJsonSafe(h.details, 'history.details')
        }));
        
        res.json(vehicle);
    } catch (error) {
        console.error('Erro ao buscar veículo:', error);
        res.status(500).json({ error: 'Erro ao buscar veículo' });
    }
};

// Garante que veículo comboio tem entrada correspondente em partners
const syncComboioPartner = async (vehicleId, registroInterno, placa, ativo) => {
    try {
        const nome = `Comboio ${registroInterno || placa || vehicleId}`;
        const status = ativo ? 'ativo' : 'inativo';
        const { randomUUID } = require('crypto');
        const [[existing]] = await db.execute('SELECT id FROM partners WHERE vehicle_id = ?', [vehicleId]);
        if (existing) {
            await db.execute('UPDATE partners SET razaoSocial = ?, status_operacional = ? WHERE vehicle_id = ?', [nome, status, vehicleId]);
        } else {
            const partnerId = randomUUID();
            await db.execute(
                `INSERT INTO partners (id, razaoSocial, tipo_parceiro, status_operacional, vehicle_id) VALUES (?, ?, 'comboio', ?, ?)`,
                [partnerId, nome, status, vehicleId]
            );
        }
    } catch (err) {
        console.warn('[syncComboioPartner]', err.message);
    }
};

const createVehicle = async (req, res) => {
    const data = req.body;
    
    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    delete data.history; 
    delete data.checklistCount; // Remove campo virtual se vier no body

    data.id = randomUUID();
    
    Object.keys(data).forEach(key => data[key] === undefined && delete data[key]);

    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO vehicles (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await db.execute(query, values);
        // Se for veículo comboio, garante o registro correspondente em `partners`
        if (data.isComboioVehicle == 1 || data.isComboioVehicle === true) {
            try { await ensureComboioPartner(db, data.id); }
            catch (e) { console.warn('[ensureComboioPartner createVehicle]', e.message); }
        }
        req.io.emit('server:sync', { targets: ['vehicles', 'partners'] });
        res.status(201).json({ ...req.body, id: data.id });
    } catch (error) {
        console.error('Erro ao criar veículo:', error);
        res.status(500).json({ error: 'Erro ao criar veículo: ' + error.message });
    }
};

// Whitelist de colunas permitidas em UPDATE — evita SQL injection por nome de campo.
// Mantida em sincronia com os campos enviados por VehicleModal e as colunas reais
// da tabela `vehicles` (validade*, ano_*, fuelCapacity, mediaCalculo, rastreador,
// nomeEmpresaTerceiro, contratoTerceiro, canCirculate). Campos legados (vencimento*,
// apolice etc.) ficam por ora para não quebrar fluxos antigos.
const ALLOWED_VEHICLE_FIELDS = new Set([
    'placa', 'registroInterno', 'tipo', 'sub_tipo', 'marca', 'modelo',
    'anoFabricacao', 'anoCombustivel', 'ano_fabricacao', 'ano_modelo',
    'status', 'localizacaoAtual', 'obraAtualId', 'fotoURL', 'cor', 'renavam', 'chassi',
    'proprietario', 'seguradora', 'apolice', 'vencimentoSeguro', 'vencimentoCRLV',
    'vencimentoLicenca', 'vencimentoExtintor', 'vencimentoTacografo',
    'validadeTacografo', 'validadeAET_DAER', 'validadeAET_DNIT',
    'canCirculate', 'rastreador', 'nomeEmpresaTerceiro', 'contratoTerceiro',
    'fuelLevels', 'fuelCapacity', 'alocadoEm', 'maintenanceLocation', 'operationalAssignment',
    'odometro', 'horimetro', 'hodometro', 'capacidade', 'capacidadeTanque', 'tipoCombustivel',
    'mediaCalculo', 'observacoes', 'avisoTexto', 'possuiAviso',
    'proximaRevisaoOdometro', 'proximaRevisaoHorimetro', 'proximaRevisaoData',
    'tamanho', 'capacidadeCarga', 'numeroPneus', 'numeroEixos',
    'media_consumo', 'percentual_tolerancia',
    'isComboioVehicle', 'ativo', 'isSucata', 'isOutsourced',
    'permiteMultiplosAbastecimentos',
    // Contrato de locação (equipamento terceirizado)
    'locadorId', 'locacaoHorasContratadas', 'locacaoValorTotal',
    'locacaoVigenciaInicio', 'locacaoVigenciaFim',
]);

const updateVehicle = async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    if (data.fuelLevels) data.fuelLevels = JSON.stringify(data.fuelLevels);
    if (data.alocadoEm) data.alocadoEm = JSON.stringify(data.alocadoEm);
    if (data.maintenanceLocation) data.maintenanceLocation = JSON.stringify(data.maintenanceLocation);
    if (data.operationalAssignment) data.operationalAssignment = JSON.stringify(data.operationalAssignment);

    const fields = Object.keys(data).filter(key => key !== 'id' && ALLOWED_VEHICLE_FIELDS.has(key));
    const values = fields.map(field => data[field]);
    const setClause = fields.map(field => `\`${field}\` = ?`).join(', ');
    const query = `UPDATE vehicles SET ${setClause} WHERE id = ?`;

    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum dado para atualizar.' });

    try {
        await db.execute(query, [...values, id]);
        // Sincroniza o partner espelho do comboio conforme a flag enviada.
        // Se ela não foi tocada nesta requisição, não fazemos nada (preserva estado atual).
        if ('isComboioVehicle' in data) {
            try {
                if (data.isComboioVehicle == 1 || data.isComboioVehicle === true) {
                    await ensureComboioPartner(db, id);
                } else {
                    await deactivateComboioPartner(db, id);
                }
            } catch (e) {
                console.warn('[ensureComboioPartner updateVehicle]', e.message);
            }
        }
        req.io.emit('server:sync', { targets: ['vehicles', 'partners'] });
        res.json({ message: 'Veículo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar veículo:', error);
        res.status(500).json({ error: 'Erro ao atualizar veículo: ' + error.message });
    }
};

const uploadVehicleImage = async (req, res) => {
    const { id } = req.params; 
    
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
    }

    const fotoURL = `/uploads/${req.file.filename}`; 
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT fotoURL FROM vehicles WHERE id = ?', [id]);
        
        if (rows.length > 0 && rows[0].fotoURL) {
            const oldFotoURL = rows[0].fotoURL; 
            const oldLocalPath = path.resolve(process.cwd(), 'public', oldFotoURL.substring(1)); 

            try {
                if (fs.existsSync(oldLocalPath)) {
                    fs.unlinkSync(oldLocalPath); 
                }
            } catch (unlinkError) {
                console.warn(`[Upload] Aviso: Falha ao deletar imagem antiga.`, unlinkError.message);
            }
        }

        await connection.execute('UPDATE vehicles SET fotoURL = ? WHERE id = ?', [fotoURL, id]);
        await connection.commit();

        req.io.emit('server:sync', { targets: ['vehicles'] });
        res.json({ message: 'Upload bem-sucedido!', fotoURL: fotoURL });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar URL da imagem no banco:', error);
        res.status(500).json({ error: 'Erro ao salvar a imagem.' });
    } finally {
        connection.release();
    }
};

const deleteVehicle = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
        const [revisions] = await connection.execute('SELECT id FROM revisions WHERE vehicleId = ?', [req.params.id]);
        if (revisions.length > 0) {
            const revisionIds = revisions.map(r => r.id);
            const placeholders = revisionIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM revisions_history WHERE revisionId IN (${placeholders})`, revisionIds);
            await connection.execute(`DELETE FROM revisions WHERE id IN (${placeholders})`, revisionIds);
        }
        
        // Também deleta checklists associados para manter integridade
        await connection.execute('DELETE FROM checklists WHERE vehicle_id = ?', [req.params.id]);

        await connection.execute('DELETE FROM vehicles WHERE id = ?', [req.params.id]);

        // Desativa (mas não deleta) o partner-espelho do comboio, se houver,
        // para preservar referências históricas em refuelings/comboio_transactions.
        try { await deactivateComboioPartner(connection, req.params.id); }
        catch (e) { console.warn('[deactivateComboioPartner deleteVehicle]', e.message); }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles', 'revisions', 'partners'] });
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro ao deletar veículo:', error);
        res.status(500).json({ error: 'Erro ao deletar veículo' });
    } finally {
        connection.release();
    }
};

// --- ALOCAÇÃO EM OBRA ---

const allocateToObra = async (req, res) => {
    const { id } = req.params; 
    const { obraId, employeeId, dataEntrada, readingType, readingValue, observacoes } = req.body;
    
    if (!obraId || !employeeId) {
        return res.status(400).json({ error: "IDs de Obra e Funcionário são obrigatórios." });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const obraIdStr = String(obraId);
        const employeeIdStr = String(employeeId);
        const readingVal = parseFloat(readingValue) || 0;

        const [obraRows] = await connection.execute('SELECT nome, status, dataInicio FROM obras WHERE id = ?', [obraIdStr]);
        const [employeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeIdStr]);
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);

        const obra = obraRows[0];
        const employee = employeeRows[0];
        const vehicle = vehicleRows[0];

        if (!obra || !employee || !vehicle) {
            throw new Error("Obra, Funcionário ou Veículo não encontrado (ID inválido).");
        }
        
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: new Date(dataEntrada || new Date()),
            endDate: null,
            details: JSON.stringify({ 
                obraId: obraIdStr,
                obraNome: obra.nome,
                employeeId: employeeIdStr,
                employeeName: employee.nome,
                [`${readingType}Entrada`]: readingVal,
                observacoes: observacoes
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', '); 

        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        const vehicleUpdateData = {
            obraAtualId: obraIdStr,
            status: 'Em Obra',
            localizacaoAtual: obra.nome,
            operationalAssignment: null, 
            maintenanceLocation: null, 
            alocadoEm: JSON.stringify({
                type: 'obra',
                id: obraIdStr,
                nome: obra.nome
            }),
            [readingType]: readingVal 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        try {
            await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'obra' }), employeeIdStr]);
        } catch (empError) {
            console.warn("Aviso: Falha ao atualizar funcionário:", empError.message);
        }

        const newObraHistoryEntryData = {
            id: randomUUID(),
            obraId: obraIdStr,
            veiculoId: vehicle.id,
            tipo: vehicle.tipo || 'Desconhecido', 
            registroInterno: vehicle.registroInterno || '',
            placa: vehicle.placa || '',
            modelo: `${vehicle.marca || ''} ${vehicle.modelo || ''}`.trim() || 'Modelo N/A',
            employeeId: employeeIdStr,
            employeeName: employee.nome || 'Funcionário',
            dataEntrada: new Date(dataEntrada || new Date()),
            dataSaida: null,
            odometroEntrada: readingType === 'odometro' ? readingVal : 0,
            odometroSaida: 0, 
            horimetroEntrada: readingType === 'horimetro' ? readingVal : 0,
            horimetroSaida: 0, 
            observacoes: observacoes || ''
        };
        
        const obraHistoryFields = Object.keys(newObraHistoryEntryData);
        const obraHistoryValues = Object.values(newObraHistoryEntryData);
        const obraHistoryPlaceholders = obraHistoryFields.map(() => '?').join(', '); 

        await connection.execute(
            `INSERT INTO obras_historico_veiculos (${obraHistoryFields.join(', ')}) VALUES (${obraHistoryPlaceholders})`,
            obraHistoryValues
        );

        // Planejamento: 1ª alocação de equipamento leva a obra para 'mobilizacao'.
        // A ativação ('ativa') só acontece no 1º lançamento de horas (billingController).
        // Evento único — remover a alocação não reverte.
        if (['radar', 'planejada'].includes(obra.status)) {
            await connection.execute(
                'UPDATE obras SET status = ? WHERE id = ?',
                ['mobilizacao', obraIdStr]
            );
            console.log(`✅ Obra "${obra.nome}" em mobilização (1ª alocação de equipamento).`);
        }

        // Fase 2.6 — Se for comboio, abre novo período de obra
        // (fecha qualquer anterior automaticamente)
        if (vehicle.isComboioVehicle == 1 || vehicle.isComboioVehicle === true) {
            try {
                await openComboioPeriod(connection, id, obraIdStr, new Date(dataEntrada || new Date()));
            } catch (e) {
                console.warn('[comboioPeriodo openPeriod allocateToObra]', e.message);
            }
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles', 'obras'] });
        res.status(200).json({ message: 'Veículo alocado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro CRÍTICO ao alocar (Obra):", error);
        res.status(500).json({ error: 'Falha ao alocar veículo.', details: error.message });
    } finally {
        connection.release();
    }
};

const deallocateFromObra = async (req, res) => {
    const { id } = req.params; 
    const { dataSaida, readingType, readingValue, location, shouldFinalizeObra, dataFimObra, observacoes, obraId } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const exitTimestamp = new Date(dataSaida || new Date());
        const readingVal = parseFloat(readingValue) || 0;

        let targetObraId = obraId ? String(obraId) : null;
        if (!targetObraId) {
            const [vRows] = await connection.execute('SELECT obraAtualId FROM vehicles WHERE id = ?', [id]);
            if (vRows.length > 0) targetObraId = vRows[0].obraAtualId;
        }

        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'obra']
        );
        
        let employeeIdToRelease = null;

        if (historyRows && historyRows.length > 0) {
            const activeHistory = historyRows[0];
            const historyDetails = parseJsonSafe(activeHistory.details, 'history.details') || {};
            employeeIdToRelease = historyDetails.employeeId;

            if (!targetObraId && historyDetails.obraId) targetObraId = String(historyDetails.obraId);

            const newDetails = {
                ...historyDetails,
                [`${readingType}Saida`]: readingVal,
                observacoesSaida: observacoes
            };
            
            await connection.execute(
                'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
                [exitTimestamp, JSON.stringify(newDetails), activeHistory.id]
            );
        }

        const vehicleUpdateData = {
            obraAtualId: null, 
            status: 'Disponível', 
            localizacaoAtual: location || 'Pátio', 
            alocadoEm: null,
            [readingType]: readingVal, 
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');
        
        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );

        if (employeeIdToRelease) {
             try {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [employeeIdToRelease]);
             } catch (e) { console.warn("Erro ao liberar funcionário", e.message); }
        }
        
        if (targetObraId) {
            const obraHistoryUpdateFields = ['dataSaida = ?'];
            const obraHistoryUpdateValues = [exitTimestamp];

            if (readingType === 'odometro') {
                obraHistoryUpdateFields.push('odometroSaida = ?');
                obraHistoryUpdateValues.push(readingVal);
            } else {
                obraHistoryUpdateFields.push('horimetroSaida = ?');
                obraHistoryUpdateValues.push(readingVal);
            }

            if (observacoes) {
                obraHistoryUpdateFields.push('observacoes = CONCAT(COALESCE(observacoes, ""), " | Saída: ", ?)');
                obraHistoryUpdateValues.push(observacoes);
            }

            obraHistoryUpdateValues.push(id); 
            obraHistoryUpdateValues.push(targetObraId);

            await connection.execute(
                `UPDATE obras_historico_veiculos 
                 SET ${obraHistoryUpdateFields.join(', ')} 
                 WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
                obraHistoryUpdateValues
            );
        }
        
        if (shouldFinalizeObra && targetObraId) {
            const obraUpdate = { 
                status: 'finalizada', 
                dataFim: new Date(dataFimObra || new Date())
            };
            const obraUpdateFields = Object.keys(obraUpdate);
            const obraUpdateValues = Object.values(obraUpdate);
            const obraSetClause = obraUpdateFields.map(field => `${field} = ?`).join(', ');

            await connection.execute(
                `UPDATE obras SET ${obraSetClause} WHERE id = ?`,
                [...obraUpdateValues, targetObraId]
            );
        }

        // Fase 2.6 — Se for comboio, fecha o período de obra ativo
        try {
            const [[vRow]] = await connection.execute('SELECT isComboioVehicle FROM vehicles WHERE id = ?', [id]);
            if (vRow && (vRow.isComboioVehicle == 1 || vRow.isComboioVehicle === true)) {
                await closeComboioPeriod(connection, id, exitTimestamp);
            }
        } catch (e) {
            console.warn('[comboioPeriodo closePeriod deallocateFromObra]', e.message);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles', 'obras'] });
        res.status(200).json({ message: 'Veículo desalocado com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro CRÍTICO ao desalocar:", error);
        res.status(500).json({ error: 'Falha ao desalocar veículo.', details: error.message });
    } finally {
        connection.release();
    }
};

// --- ESTADIA RETROATIVA (split da alocação atual) ---
// Registra uma passagem passada por outra obra (Obra B) sem tirar o veículo
// da obra atual (Obra A). Faz o "split": fecha a A na saída p/ B, insere a
// estadia fechada em B, e reabre um novo período da A a partir da volta.
// Comboio está fora de escopo (não mexe em comboio_periodos_obra).
const registrarEstadiaRetroativa = async (req, res) => {
    const { id } = req.params;
    const {
        obraId,            // Obra B (destino da estadia retroativa)
        employeeId,        // operador da estadia B (obrigatório)
        dataEntrada,       // entrada em B / saída da A
        dataSaida,         // saída de B / volta para A
        readingType,       // 'odometro' | 'horimetro'
        leituraPartida,    // leitura ao sair da A (= entrada em B)
        leituraVolta,      // leitura ao sair de B (= volta para A)
        observacoes,
        substituirConflitos = false // se true, apara/divide períodos antigos sobrepostos
    } = req.body;

    if (!obraId || !employeeId || !dataEntrada || !dataSaida) {
        return res.status(400).json({ error: 'Obra, operador, data de entrada e data de saída são obrigatórios.' });
    }
    if (readingType !== 'odometro' && readingType !== 'horimetro') {
        return res.status(400).json({ error: "readingType deve ser 'odometro' ou 'horimetro'." });
    }

    const entradaB = new Date(dataEntrada);
    const saidaB = new Date(dataSaida);
    if (isNaN(entradaB.getTime()) || isNaN(saidaB.getTime())) {
        return res.status(400).json({ error: 'Datas inválidas.' });
    }
    if (entradaB >= saidaB) {
        return res.status(400).json({ error: 'A data de entrada em B deve ser anterior à data de saída.' });
    }
    if (saidaB > new Date()) {
        return res.status(400).json({ error: 'A data de saída não pode estar no futuro.' });
    }

    const partida = parseFloat(leituraPartida) || 0;
    const volta = parseFloat(leituraVolta) || 0;
    if (volta < partida) {
        return res.status(400).json({ error: 'A leitura de volta não pode ser menor que a de partida.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const obraBIdStr = String(obraId);
        const employeeBIdStr = String(employeeId);

        const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraBIdStr]);
        const [employeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeBIdStr]);
        const [vehicleRows] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [id]);

        const obraB = obraRows[0];
        const employeeB = employeeRows[0];
        const vehicle = vehicleRows[0];

        if (!obraB || !employeeB || !vehicle) {
            throw new Error('Obra, Funcionário ou Veículo não encontrado (ID inválido).');
        }

        // Período ABERTO atual da obra (Obra A), se houver — é o que será fatiado.
        // Se o veículo está DISPONÍVEL (sem obra vigente), não há split: apenas
        // inserimos a estadia fechada na Obra B, sem tocar no estado atual.
        const [openHistRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL ORDER BY startDate DESC LIMIT 1',
            [id, 'obra']
        );
        const openHist = (openHistRows && openHistRows.length > 0) ? openHistRows[0] : null;
        const openDetails = openHist ? (parseJsonSafe(openHist.details, 'history.details') || {}) : {};
        const obraAId = openHist
            ? (openDetails.obraId ? String(openDetails.obraId) : (vehicle.obraAtualId ? String(vehicle.obraAtualId) : null))
            : null;

        if (openHist) {
            // Split só é válido se a estadia couber dentro do período aberto da A.
            if (entradaB < new Date(openHist.startDate)) {
                throw new Error('A entrada na obra da estadia é anterior ao início da alocação atual. Verifique as datas.');
            }
            if (String(obraAId) === obraBIdStr) {
                throw new Error('A obra da estadia retroativa é a mesma da alocação atual.');
            }
        }

        const entradaKey = `${readingType}Entrada`;
        const saidaKey = `${readingType}Saida`;
        const readColEntrada = readingType === 'odometro' ? 'odometroEntrada' : 'horimetroEntrada';
        const readColSaida = readingType === 'odometro' ? 'odometroSaida' : 'horimetroSaida';

        // --- DETECÇÃO DE SOBREPOSIÇÃO ---
        // Procura períodos de obra da mesma máquina que colidam com [entradaB, saidaB].
        // Exclui o período aberto atual (openHist) — ele é tratado via split, não é conflito.
        // Regra de sobreposição: início < saidaB E (fim IS NULL OU fim > entradaB).
        const excludeId = openHist ? openHist.id : null;
        const conflictSql = `
            SELECT * FROM vehicle_history
            WHERE vehicleId = ? AND historyType = 'obra'
              AND startDate < ? AND (endDate IS NULL OR endDate > ?)
              ${excludeId ? 'AND id <> ?' : ''}
            ORDER BY startDate ASC`;
        const conflictParams = excludeId ? [id, saidaB, entradaB, excludeId] : [id, saidaB, entradaB];
        const [conflictRows] = await connection.execute(conflictSql, conflictParams);

        if (conflictRows.length > 0 && !substituirConflitos) {
            // Não commita: devolve os conflitos para o frontend avisar o usuário.
            await connection.rollback();
            const conflicts = conflictRows.map(r => {
                const d = parseJsonSafe(r.details, 'history.details') || {};
                return {
                    obraId: d.obraId || null,
                    obraNome: d.obraNome || 'Obra não identificada',
                    dataEntrada: r.startDate,
                    dataSaida: r.endDate, // null = ainda aberto (obra atual)
                    aberto: !r.endDate
                };
            });
            return res.status(409).json({
                error: 'A máquina já possui registro em obra no período informado.',
                code: 'PERIODO_SOBREPOSTO',
                conflicts
            });
        }

        // --- RESOLUÇÃO DE SOBREPOSIÇÃO (substituirConflitos = true) ---
        // "Só os dias em conflito": o novo período vence nos dias sobrepostos;
        // o período antigo é aparado/dividido e os dias fora da sobreposição
        // são preservados. A leitura no ponto de corte é a da estadia (partida/volta).
        for (const p of conflictRows) {
            const Ps = new Date(p.startDate);
            const Pe = p.endDate ? new Date(p.endDate) : null; // null = aberto
            const coversStart = entradaB <= Ps;
            const coversEnd = Pe ? (saidaB >= Pe) : false; // aberto nunca é "coberto no fim"
            const pDetails = parseJsonSafe(p.details, 'history.details') || {};
            const pObraId = pDetails.obraId ? String(pDetails.obraId) : null;

            if (coversStart && coversEnd) {
                // Antigo inteiramente contido no novo → remove.
                await connection.execute('DELETE FROM vehicle_history WHERE id = ?', [p.id]);
                if (pObraId) {
                    await connection.execute(
                        'DELETE FROM obras_historico_veiculos WHERE veiculoId = ? AND obraId = ? AND dataEntrada = ?',
                        [id, pObraId, p.startDate]
                    );
                }
            } else if (coversStart && !coversEnd) {
                // Novo cobre o início → apara o começo do antigo para saidaB.
                await connection.execute(
                    'UPDATE vehicle_history SET startDate = ?, details = ? WHERE id = ?',
                    [saidaB, JSON.stringify({ ...pDetails, [entradaKey]: volta }), p.id]
                );
                if (pObraId) {
                    await connection.execute(
                        `UPDATE obras_historico_veiculos SET dataEntrada = ?, ${readColEntrada} = ?
                         WHERE veiculoId = ? AND obraId = ? AND dataEntrada = ?`,
                        [saidaB, volta, id, pObraId, p.startDate]
                    );
                }
            } else if (!coversStart && coversEnd) {
                // Novo cobre o fim → apara o fim do antigo para entradaB.
                await connection.execute(
                    'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
                    [entradaB, JSON.stringify({ ...pDetails, [saidaKey]: partida }), p.id]
                );
                if (pObraId) {
                    await connection.execute(
                        `UPDATE obras_historico_veiculos SET dataSaida = ?, ${readColSaida} = ?
                         WHERE veiculoId = ? AND obraId = ? AND dataEntrada = ?`,
                        [entradaB, partida, id, pObraId, p.startDate]
                    );
                }
            } else {
                // Novo estritamente dentro do antigo → divide em dois:
                // [Ps, entradaB] (fecha em partida) + [saidaB, Pe] (reabre em volta).
                await connection.execute(
                    'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
                    [entradaB, JSON.stringify({ ...pDetails, [saidaKey]: partida }), p.id]
                );
                const tailEntry = {
                    vehicleId: id,
                    historyType: 'obra',
                    startDate: saidaB,
                    endDate: Pe, // preserva o fim original (pode ser null = segue aberto)
                    details: JSON.stringify({ ...pDetails, [entradaKey]: volta })
                };
                const tFields = Object.keys(tailEntry);
                await connection.execute(
                    `INSERT INTO vehicle_history (${tFields.join(', ')}) VALUES (${tFields.map(() => '?').join(', ')})`,
                    Object.values(tailEntry)
                );
                if (pObraId) {
                    // Captura o registro de obra original ANTES de aparar, para copiar
                    // dados (funcionário, leitura de saída) na parte final.
                    const [ohRows] = await connection.execute(
                        'SELECT * FROM obras_historico_veiculos WHERE veiculoId = ? AND obraId = ? AND dataEntrada = ? LIMIT 1',
                        [id, pObraId, p.startDate]
                    );
                    const base = ohRows[0] || {};
                    // Fecha a parte inicial do registro de obra.
                    await connection.execute(
                        `UPDATE obras_historico_veiculos SET dataSaida = ?, ${readColSaida} = ?
                         WHERE veiculoId = ? AND obraId = ? AND dataEntrada = ?`,
                        [entradaB, partida, id, pObraId, p.startDate]
                    );
                    const tailObra = {
                        id: randomUUID(),
                        obraId: pObraId,
                        veiculoId: vehicle.id,
                        tipo: vehicle.tipo || 'Desconhecido',
                        registroInterno: vehicle.registroInterno || '',
                        placa: vehicle.placa || '',
                        modelo: `${vehicle.marca || ''} ${vehicle.modelo || ''}`.trim() || 'Modelo N/A',
                        employeeId: base.employeeId || (pDetails.employeeId ? String(pDetails.employeeId) : null),
                        employeeName: base.employeeName || pDetails.employeeName || 'Funcionário',
                        dataEntrada: saidaB,
                        dataSaida: Pe,
                        odometroEntrada: readingType === 'odometro' ? volta : 0,
                        odometroSaida: (readingType === 'odometro' && base.odometroSaida) ? base.odometroSaida : 0,
                        horimetroEntrada: readingType === 'horimetro' ? volta : 0,
                        horimetroSaida: (readingType === 'horimetro' && base.horimetroSaida) ? base.horimetroSaida : 0,
                        observacoes: base.observacoes || ''
                    };
                    const toFields = Object.keys(tailObra);
                    await connection.execute(
                        `INSERT INTO obras_historico_veiculos (${toFields.join(', ')}) VALUES (${toFields.map(() => '?').join(', ')})`,
                        Object.values(tailObra)
                    );
                }
            }
        }

        // 1) FECHA o período da Obra A na saída para B (só se houver obra vigente).
        if (openHist) {
            const closedDetails = {
                ...openDetails,
                [saidaKey]: partida,
                observacoesSaida: observacoes ? `[Estadia retroativa em ${obraB.nome}] ${observacoes}` : `Saída para estadia retroativa em ${obraB.nome}`
            };
            await connection.execute(
                'UPDATE vehicle_history SET endDate = ?, details = ? WHERE id = ?',
                [entradaB, JSON.stringify(closedDetails), openHist.id]
            );
            if (obraAId) {
                await connection.execute(
                    `UPDATE obras_historico_veiculos SET dataSaida = ?, ${readColSaida} = ?
                     WHERE veiculoId = ? AND obraId = ? AND dataSaida IS NULL`,
                    [entradaB, partida, id, obraAId]
                );
            }
        }

        // 2) INSERE a estadia FECHADA na Obra B (sempre).
        const bHistEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: entradaB,
            endDate: saidaB,
            details: JSON.stringify({
                obraId: obraBIdStr,
                obraNome: obraB.nome,
                employeeId: employeeBIdStr,
                employeeName: employeeB.nome,
                [entradaKey]: partida,
                [saidaKey]: volta,
                observacoes: observacoes || '',
                retroativa: true
            })
        };
        const bFields = Object.keys(bHistEntry);
        await connection.execute(
            `INSERT INTO vehicle_history (${bFields.join(', ')}) VALUES (${bFields.map(() => '?').join(', ')})`,
            Object.values(bHistEntry)
        );

        const bObraHist = {
            id: randomUUID(),
            obraId: obraBIdStr,
            veiculoId: vehicle.id,
            tipo: vehicle.tipo || 'Desconhecido',
            registroInterno: vehicle.registroInterno || '',
            placa: vehicle.placa || '',
            modelo: `${vehicle.marca || ''} ${vehicle.modelo || ''}`.trim() || 'Modelo N/A',
            employeeId: employeeBIdStr,
            employeeName: employeeB.nome || 'Funcionário',
            dataEntrada: entradaB,
            dataSaida: saidaB,
            odometroEntrada: readingType === 'odometro' ? partida : 0,
            odometroSaida: readingType === 'odometro' ? volta : 0,
            horimetroEntrada: readingType === 'horimetro' ? partida : 0,
            horimetroSaida: readingType === 'horimetro' ? volta : 0,
            observacoes: observacoes || ''
        };
        const bohFields = Object.keys(bObraHist);
        await connection.execute(
            `INSERT INTO obras_historico_veiculos (${bohFields.join(', ')}) VALUES (${bohFields.map(() => '?').join(', ')})`,
            Object.values(bObraHist)
        );

        // 3) REABRE novo período da Obra A a partir da volta (vira o vigente).
        //    Só quando havia obra vigente — veículo disponível não tem A para reabrir.
        //    Mantém obra e operador originais da A; obraAtualId/status do veículo não mudam.
        if (openHist) {
        const reopenDetails = {
            obraId: openDetails.obraId,
            obraNome: openDetails.obraNome,
            employeeId: openDetails.employeeId,
            employeeName: openDetails.employeeName,
            [entradaKey]: volta,
            observacoes: `Retorno da estadia retroativa em ${obraB.nome}`
        };
        const reopenEntry = {
            vehicleId: id,
            historyType: 'obra',
            startDate: saidaB,
            endDate: null,
            details: JSON.stringify(reopenDetails)
        };
        const rFields = Object.keys(reopenEntry);
        await connection.execute(
            `INSERT INTO vehicle_history (${rFields.join(', ')}) VALUES (${rFields.map(() => '?').join(', ')})`,
            Object.values(reopenEntry)
        );

        if (obraAId) {
            // Recupera dados do funcionário original da A para o novo registro.
            const reopenObraHist = {
                id: randomUUID(),
                obraId: obraAId,
                veiculoId: vehicle.id,
                tipo: vehicle.tipo || 'Desconhecido',
                registroInterno: vehicle.registroInterno || '',
                placa: vehicle.placa || '',
                modelo: `${vehicle.marca || ''} ${vehicle.modelo || ''}`.trim() || 'Modelo N/A',
                employeeId: openDetails.employeeId ? String(openDetails.employeeId) : null,
                employeeName: openDetails.employeeName || 'Funcionário',
                dataEntrada: saidaB,
                dataSaida: null,
                odometroEntrada: readingType === 'odometro' ? volta : 0,
                odometroSaida: 0,
                horimetroEntrada: readingType === 'horimetro' ? volta : 0,
                horimetroSaida: 0,
                observacoes: `Retorno da estadia retroativa em ${obraB.nome}`
            };
            const rohFields = Object.keys(reopenObraHist);
            await connection.execute(
                `INSERT INTO obras_historico_veiculos (${rohFields.join(', ')}) VALUES (${rohFields.map(() => '?').join(', ')})`,
                Object.values(reopenObraHist)
            );
        }
        } // fim do split (if openHist)

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles', 'obras'] });
        res.status(200).json({ message: 'Estadia retroativa registrada com sucesso.' });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro ao registrar estadia retroativa:', error);
        res.status(500).json({ error: 'Falha ao registrar estadia retroativa.', details: error.message });
    } finally {
        connection.release();
    }
};

const assignToOperational = async (req, res) => {
    const { id } = req.params;
    const { subGroup, employeeId, observacoes } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        if (!employeeId) throw new Error('ID do funcionário não pode ser vazio.');
        const now = new Date();
        
        await connection.execute(
            'UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL',
            [now, id]
        );
        
        const employeeIdStr = String(employeeId);
        const [selectedEmployeeRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeIdStr]);
        const employeeName = selectedEmployeeRows[0]?.nome;
        
        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'operacional',
            startDate: now,
            endDate: null,
            details: JSON.stringify({
                subGroup,
                employeeId: employeeIdStr,
                employeeName,
                observacoes,
            })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        const operationalAssignment = { 
            subGroup, 
            employeeId: employeeIdStr, 
            employeeName, 
            startDate: now 
        };

        const vehicleUpdateData = {
            operationalAssignment: JSON.stringify(operationalAssignment),
            status: 'Em Operação',
            obraAtualId: null,
            maintenanceLocation: null,
            alocadoEm: JSON.stringify({
                type: 'operacional',
                subGroup: subGroup,
                employeeName: employeeName
            }),
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(
            `UPDATE vehicles SET ${setClause} WHERE id = ?`,
            [...updateValues, id]
        );
        
        await connection.execute('UPDATE employees SET alocadoEm = ? WHERE id = ?', [JSON.stringify({ veiculoId: id, assignmentType: 'operacional' }), employeeIdStr]);

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles'] });
        res.status(200).json({ message: 'Veículo alocado para operação.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao alocar operacional:", error); 
        res.status(500).json({ error: 'Falha ao alocar o veículo.', details: error.message });
    } finally {
        connection.release();
    }
};

const unassignFromOperational = async (req, res) => {
    const { id } = req.params; 
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        const [historyRows] = await connection.execute(
            'SELECT * FROM vehicle_history WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL',
            [id, 'operacional']
        );
        const activeHistory = historyRows[0];
        
        if (activeHistory) { 
            await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE id = ?', [now, activeHistory.id]);
        }

        const vehicleUpdateData = { 
            operationalAssignment: null, 
            status: 'Disponível', 
            localizacaoAtual: location, 
            alocadoEm: null,
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

        if (activeHistory?.details) {
             const details = parseJsonSafe(activeHistory.details, 'history.details'); 
             if (details?.employeeId) {
                await connection.execute('UPDATE employees SET alocadoEm = NULL WHERE id = ?', [details.employeeId]);
             }
        }
        
        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles'] });
        res.status(200).json({ message: 'Alocação operacional finalizada.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar alocação:", error);
        res.status(500).json({ error: 'Falha ao finalizar a alocação.', details: error.message });
    } finally {
        connection.release();
    }
};

const startMaintenance = async (req, res) => {
    const { id } = req.params; 
    const { status, location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        
        await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND endDate IS NULL', [now, id]);

        const newHistoryEntry = {
            vehicleId: id,
            historyType: 'manutencao',
            startDate: now,
            endDate: null,
            details: JSON.stringify({ status: status, location: location })
        };
        
        const historyFields = Object.keys(newHistoryEntry);
        const historyValues = Object.values(newHistoryEntry);
        const historyPlaceholders = historyFields.map(() => '?').join(', ');
        
        await connection.execute(
            `INSERT INTO vehicle_history (${historyFields.join(', ')}) VALUES (${historyPlaceholders})`,
            historyValues
        );
        
        const maintenanceLocation = {
            type: location === 'Pátio MAK Lajeado' || location === 'Pátio MAK Santa Maria' ? 'Pátio' : 'Outros',
            details: location,
        };

        const vehicleUpdateData = {
            status: status,
            maintenanceLocation: JSON.stringify(maintenanceLocation),
            obraAtualId: null,
            operationalAssignment: null,
            alocadoEm: JSON.stringify({ type: 'manutencao', location: location, status: status }),
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles'] });
        res.status(200).json({ message: 'Status de manutenção atualizado.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao iniciar manutenção:", error);
        res.status(500).json({ error: 'Falha ao iniciar a manutenção.', details: error.message });
    } finally {
        connection.release();
    }
};

const endMaintenance = async (req, res) => {
    const { id } = req.params; 
    const { location } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const now = new Date();
        await connection.execute('UPDATE vehicle_history SET endDate = ? WHERE vehicleId = ? AND historyType = ? AND endDate IS NULL', [now, id, 'manutencao']);

        const vehicleUpdateData = {
            status: 'Disponível',
            maintenanceLocation: null,
            localizacaoAtual: location,
            alocadoEm: null,
        };
        
        const updateFields = Object.keys(vehicleUpdateData);
        const updateValues = Object.values(vehicleUpdateData);
        const setClause = updateFields.map(field => `${field} = ?`).join(', ');

        await connection.execute(`UPDATE vehicles SET ${setClause} WHERE id = ?`, [...updateValues, id]);

        await connection.commit();
        req.io.emit('server:sync', { targets: ['vehicles'] });
        res.status(200).json({ message: 'Manutenção finalizada.' });
    } catch (error) {
        await connection.rollback();
        console.error("Erro ao finalizar manutenção:", error);
        res.status(500).json({ error: 'Falha ao finalizar a manutenção.', details: error.message });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllVehicles,
    getVehicleById,
    createVehicle,
    updateVehicle,
    uploadVehicleImage,
    deleteVehicle,
    allocateToObra,
    deallocateFromObra,
    registrarEstadiaRetroativa,
    assignToOperational,
    unassignFromOperational,
    startMaintenance,
    endMaintenance,
};