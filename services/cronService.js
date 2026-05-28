const cron = require('node-cron');
const db = require('../database');
const whatsappService = require('./whatsappService');
const { syncJourneyEvents, syncPositions, syncDailySummary } = require('./sigasulSyncService');

// ===================================================================================
// ⚙️ CONFIGURAÇÃO DE HORÁRIO DA ROTINA DIÁRIA (Fuso de Brasília GMT-3)
// ===================================================================================
const HORA_EXECUCAO = 8;    // Ex: 8 para 08:00, 9 para 09:00
const MINUTO_EXECUCAO = 0;  // Ex: 0 para exatos 08:00, 30 para 08:30

// ===================================================================================
// REGRAS DE NEGÓCIO DE VEÍCULOS
// ✅ Fonte única de verdade: importado de vehicleRules.js
//    Nunca edite os grupos aqui. Altere apenas em src/utils/vehicleRules.js
// ===================================================================================
const { vehicleGroups } = require('../utils/vehicleRules');

const getVehicleGroup = (tipoStr) => {
    if (!tipoStr) return 'Outros';
    for (const [groupName, types] of Object.entries(vehicleGroups)) {
        if (types.includes(tipoStr)) return groupName;
    }
    return 'Outros'; 
};

// ===================================================================================
// FUNÇÕES AUXILIARES PARA BLINDAR FUSO HORÁRIO E MENSAGENS
// ===================================================================================
const getGmt3Date = () => {
    return new Date(Date.now() - (3 * 3600000));
};

const getTzDateStr = (daysToAdd = 0) => {
    const d = getGmt3Date();
    d.setUTCDate(d.getUTCDate() + daysToAdd);
    
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const formatDateDb = (dbDate) => {
    if (!dbDate) return null;
    try {
        const d = new Date(dbDate);
        if(isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
    } catch(e) { return null; }
};

// Formatação Padrão de WhatsApp (Padronização Frotas MAK)
const formatMsgFuncionario = (msg) => {
    return `*Sistema de Frotas MAK*\n\n${msg}\n\n_Esta é uma mensagem automática, em caso de dúvida entre em contato com o setor responsável da Mak Serviços._`;
};

const formatMsgInterno = (msg) => {
    return `*Sistema de Frotas MAK*\n\n${msg}`;
};

// ===================================================================================
// ESTADO PERSISTENTE DO CRON
// Persiste no banco para sobreviver restarts e evitar duplicação em cluster mode.
// ===================================================================================
const CRON_LOCK_KEY = 'cron_lastDailyRunDate';

let _lastDailyRunDate = null; // cache em memória (fallback se DB falhar)

const initCronState = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        const [rows] = await db.query('SELECT value FROM system_settings WHERE `key` = ?', [CRON_LOCK_KEY]);
        if (rows.length > 0 && rows[0].value) {
            _lastDailyRunDate = rows[0].value;
            console.log(`✅ [CRON] Estado restaurado do banco: lastDailyRunDate = ${_lastDailyRunDate}`);
        }
    } catch (e) {
        console.warn('[CRON] Falha ao restaurar estado do banco (usando in-memory):', e.message);
    }
};

const getLastDailyRunDate = () => _lastDailyRunDate;

const setLastDailyRunDate = async (dateStr) => {
    _lastDailyRunDate = dateStr;
    try {
        await db.query(
            'INSERT INTO system_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
            [CRON_LOCK_KEY, dateStr, dateStr]
        );
    } catch (e) {
        console.warn('[CRON] Falha ao persistir lastDailyRunDate no banco:', e.message);
    }
};

initCronState();

const horaTeste = getGmt3Date();
console.log(`✅ [CRON] Inicializado. Horário atual calculado (GMT-3): ${String(horaTeste.getUTCHours()).padStart(2, '0')}:${String(horaTeste.getUTCMinutes()).padStart(2, '0')}`);
console.log(`✅ [CRON] Rotina diária de RH configurada para disparar às: ${String(HORA_EXECUCAO).padStart(2, '0')}:${String(MINUTO_EXECUCAO).padStart(2, '0')}`);

// item 12: rastreia sessões que já receberam aviso de timeout (sem schema change)
const chatbotTimeoutWarningsSent = new Set();

// ====================================================================
// O CRON RODA TODO MINUTO PARA GARANTIR A PRECISÃO (Agenda e Diário)
// ====================================================================
cron.schedule('* * * * *', async () => {
    try {
        const gmt3Date = getGmt3Date();
        const currentHour = gmt3Date.getUTCHours();
        const currentMinute = gmt3Date.getUTCMinutes();
        const todayStr = getTzDateStr(0);

        const isTimeForDailyRun = (currentHour > HORA_EXECUCAO) || (currentHour === HORA_EXECUCAO && currentMinute >= MINUTO_EXECUCAO);

        // ====================================================================
        // 1. ROTINA DIÁRIA (RH, WhatsApp, Manutenção, Férias)
        // ====================================================================
        if (isTimeForDailyRun && getLastDailyRunDate() !== todayStr) {
            console.log(`⏳ [CRON] Executando rotina diária principal (Dia ${todayStr})...`);
            await setLastDailyRunDate(todayStr);
            
            try {
                const daqui30DiasStr = getTzDateStr(30);
                const [gestores] = await db.query("SELECT id FROM users WHERE role IN ('admin', 'master', 'supervisor')");
                
                // --- A. ALERTAS DE AGENDA (CNH) ---
                if (gestores.length > 0) {
                    try {
                        const [cnhVencendo] = await db.query(`
                            SELECT id, nome, cnhVencimento as dataVencimento
                            FROM employees 
                            WHERE cnhVencimento = ? AND status = 'ativo'
                        `, [daqui30DiasStr]);

                        for (const emp of cnhVencendo) {
                            for (const gestor of gestores) {
                                try {
                                    await db.query(`
                                        INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, notification_status)
                                        VALUES (?, ?, ?, NOW(), ?, ?, ?, 'pending')
                                    `, [gestor.id, `⚠️ CNH Vencendo: ${emp.nome}`, `A CNH do funcionário ${emp.nome} vence em 30 dias.`, 'employee', emp.id, '#EF4444']);
                                } catch(e) { console.error('❌ Erro Insert Agenda CNH:', e.message); }
                            }
                        }
                    } catch (e) { console.error('❌ [CRON] Erro CNH Agenda:', e.message); }

                    // ---> B. FUNÇÃO DE MANUTENÇÃO (HODÔMETRO, HORÍMETRO E DATA) <---
                    try {
                        // Busca v.tipo para cruzar com nossa inteligência local
                        // Removida a verificação r.status, pois a tabela revisions não possui essa coluna
                        const [manutencoes] = await db.query(`
                            SELECT v.*, 
                                   r.proximaRevisaoOdometro, r.proximaRevisaoHorimetro, r.proximaRevisaoData 
                            FROM vehicles v
                            INNER JOIN revisions r ON v.id = r.vehicleId
                            WHERE v.status = 'Ativo'
                        `);

                        for (const v of manutencoes) {
                            let needsMaintenance = false;
                            let reasonStr = '';

                            // Descobre o grupo com base na coluna "tipo"
                            const grupo = getVehicleGroup(v.tipo);
                            
                            const isLeves = grupo === 'Veículos Leves';
                            const isTrecho = grupo === 'Caminhões de Trecho';
                            const isPesados = grupo === 'Caminhões' || grupo === 'Máquinas Pesadas';

                            const usaOdometro = isLeves || isTrecho;
                            const usaHorimetro = isPesados || (!usaOdometro); // Fallback seguro

                            // Definição de Rotas de WhatsApp por Grupo
                            let contatoInternoNumero = null;
                            let contatoInternoNome = null;

                            if (isLeves) {
                                contatoInternoNumero = whatsappService.CONTATOS_INTERNOS.ALMIR;
                                contatoInternoNome = 'Almir';
                            } else if (isTrecho) {
                                contatoInternoNumero = whatsappService.CONTATOS_INTERNOS.PLINIO;
                                contatoInternoNome = 'Plinio';
                            } else {
                                // Default para Máquinas e Caminhões pesados
                                contatoInternoNumero = whatsappService.CONTATOS_INTERNOS.SAULO;
                                contatoInternoNome = 'Saulo';
                            }

                            // 1. Verificação Odômetro (-1000km)
                            if (usaOdometro && v.proximaRevisaoOdometro && v.hodometro !== null) {
                                if (Number(v.hodometro) >= (Number(v.proximaRevisaoOdometro) - 1000)) {
                                    needsMaintenance = true;
                                    reasonStr = `O veículo ${v.placa} (Frota ${v.registroInterno || 'N/A'}) está com ${v.hodometro}km. A revisão está prevista para ${v.proximaRevisaoOdometro}km.`;
                                }
                            } 
                            // 2. Verificação Horímetro (-50h)
                            if (usaHorimetro && v.proximaRevisaoHorimetro && v.horimetro !== null && !needsMaintenance) {
                                if (Number(v.horimetro) >= (Number(v.proximaRevisaoHorimetro) - 50)) {
                                    needsMaintenance = true;
                                    reasonStr = `O equipamento ${v.placa} (Frota ${v.registroInterno || 'N/A'}) está com ${v.horimetro}h. A revisão está prevista para ${v.proximaRevisaoHorimetro}h.`;
                                }
                            }

                            // 3. Verificação Data Limite (Aviso 15 dias antes) - Válido para todos
                            if (!needsMaintenance && v.proximaRevisaoData) {
                                const revDate = new Date(v.proximaRevisaoData);
                                const limitDate = getGmt3Date();
                                limitDate.setUTCDate(limitDate.getUTCDate() + 15);
                                
                                if (revDate <= limitDate) {
                                    needsMaintenance = true;
                                    reasonStr = `O equipamento ${v.placa} (Frota ${v.registroInterno || 'N/A'}) atinge a data máxima de revisão em ${formatDateDb(v.proximaRevisaoData)}.`;
                                }
                            }

                            // Se atingiu o limite, grava na Agenda e envia WhatsApp
                            if (needsMaintenance) {
                                let enviouAgendaRecentemente = false;
                                
                                for (const gestor of gestores) {
                                    try {
                                        const [jaAvisou] = await db.query(`
                                            SELECT id FROM user_agenda 
                                            WHERE user_id = ? AND related_type = 'vehicle' AND related_id = ? 
                                              AND title LIKE '%Manutenção Próxima%' AND created_at >= NOW() - INTERVAL 7 DAY
                                        `, [gestor.id, v.id]);

                                        if (jaAvisou.length === 0) {
                                            await db.query(`
                                                INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, notification_status)
                                                VALUES (?, ?, ?, NOW(), ?, ?, ?, 'pending')
                                            `, [gestor.id, `🔧 Manutenção Próxima: ${v.placa}`, reasonStr, 'vehicle', v.id, '#EAB308']);
                                            
                                            enviouAgendaRecentemente = true;
                                        }
                                    } catch(e) { console.error('❌ Erro Insert Agenda Manutenção:', e.message); }
                                }

                                // Disparo de WhatsApp para o gestor responsável pelo grupo
                                if (enviouAgendaRecentemente && contatoInternoNumero && typeof whatsappService !== 'undefined') {
                                    try {
                                        await whatsappService.enviarMensagem(
                                            contatoInternoNumero, 
                                            contatoInternoNome, 
                                            'Aviso Manutenção Preventiva', 
                                            formatMsgInterno(`⚠️ *Aviso de Manutenção Preventiva*\n\n${reasonStr}`)
                                        );
                                    } catch(e) { console.error(`❌ Erro WPP Manutenção p/ ${contatoInternoNome}:`, e.message); }
                                }
                            }
                        }
                    } catch (e) { console.error('❌ [CRON] Erro Manutenções:', e.message); }
                }

                // --- C. ALERTAS DE RH VIA WHATSAPP E AUDITORIA ---
                try {
                    const [vencimentosRH] = await db.query(`
                        SELECT id, nome, contato, cnhVencimento, exameToxicologicoVencimento
                        FROM employees 
                        WHERE status = 'ativo' AND (
                            cnhVencimento = ? OR cnhVencimento = ? OR
                            exameToxicologicoVencimento = ? OR exameToxicologicoVencimento = ?
                        )
                    `, [daqui30DiasStr, todayStr, daqui30DiasStr, todayStr]);

                    for (const emp of vencimentosRH) {
                        const cnhVenc = formatDateDb(emp.cnhVencimento);
                        const toxVenc = formatDateDb(emp.exameToxicologicoVencimento);

                        if (emp.contato && typeof whatsappService !== 'undefined') {
                            if (cnhVenc === daqui30DiasStr) await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Alerta CNH 30 Dias', formatMsgFuncionario(`Olá ${emp.nome}, sua CNH vencerá em 30 dias. Por favor, programe a renovação.`)).catch(()=>{});
                            if (toxVenc === daqui30DiasStr) await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Alerta Toxicológico 30 Dias', formatMsgFuncionario(`Olá ${emp.nome}, seu Exame Toxicológico vencerá em 30 dias. Por favor, programe a renovação.`)).catch(()=>{});
                            if (cnhVenc === todayStr) {
                                await whatsappService.enviarMensagem(emp.contato, emp.nome, 'CNH Vencida Hoje', formatMsgFuncionario(`⚠️ Atenção ${emp.nome}, sua CNH vence HOJE. Entre em contato com o RH.`)).catch(()=>{});
                                await whatsappService.enviarMensagem(whatsappService.CONTATOS_INTERNOS.RH, 'RH', 'Aviso CNH Vencida', formatMsgInterno(`A CNH do funcionário *${emp.nome}* venceu hoje.`)).catch(()=>{});
                            }
                            if (toxVenc === todayStr) {
                                await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Toxicológico Vencido Hoje', formatMsgFuncionario(`⚠️ Atenção ${emp.nome}, seu Exame Toxicológico vence HOJE. Entre em contato com o RH.`)).catch(()=>{});
                                await whatsappService.enviarMensagem(whatsappService.CONTATOS_INTERNOS.RH, 'RH', 'Aviso Toxicológico Vencido', formatMsgInterno(`O Exame Toxicológico do funcionário *${emp.nome}* venceu hoje.`)).catch(()=>{});
                            }
                        }
                    }
                } catch (e) { console.error('❌ [CRON] Erro Whats RH:', e.message); }

                // --- D. RETORNO AUTOMÁTICO DE AFASTAMENTOS E FÉRIAS ---
                try {
                    const [afastados] = await db.query(`
                        SELECT id, nome, contato, statusAfastamentoTipo 
                        FROM employees 
                        WHERE statusAfastamentoTipo IS NOT NULL 
                          AND statusAfastamentoTermino <= ?
                          AND status = 'ativo'
                    `, [todayStr]);

                    for (const emp of afastados) {
                        try {
                            await db.query(`
                                UPDATE employees 
                                SET statusAfastamentoTipo = NULL, statusAfastamentoTermino = NULL, dataRetornoAfastamento = ?
                                WHERE id = ?
                            `, [todayStr, emp.id]);
                        } catch(e) { console.error(`Erro ao atualizar BD para retorno de ${emp.nome}`, e); }

                        for (const gestor of gestores) {
                            try {
                                await db.query(`
                                    INSERT INTO user_agenda (user_id, title, description, event_datetime, related_type, related_id, color_hex, notification_status)
                                    VALUES (?, ?, ?, NOW(), 'employee', ?, '#3B82F6', 'pending')
                                `, [gestor.id, `✅ Retorno de ${emp.statusAfastamentoTipo}: ${emp.nome}`, `O colaborador ${emp.nome} finalizou seu período de afastamento e retornou às atividades hoje.`, emp.id]);
                            } catch(e) { console.error(`Erro na Agenda Retorno Férias:`, e.message); }
                        }

                        if (typeof whatsappService !== 'undefined') {
                            try {
                                await whatsappService.enviarMensagem(whatsappService.CONTATOS_INTERNOS.RH, 'RH', 'Retorno Afastamento', formatMsgInterno(`✅ *Aviso de Retorno*\n\nO colaborador *${emp.nome}* finalizou seu afastamento e já se encontra "Disponível".`));
                            } catch(e) { console.error(`Erro Whats RH Férias:`, e.message); }
                            
                            if (emp.contato) {
                                try {
                                    await whatsappService.enviarMensagem(emp.contato, emp.nome, 'Fim de Afastamento', formatMsgFuncionario(`Olá, ${emp.nome}! Seu afastamento chegou ao fim e seu status no Frotas MAK está *Disponível*.\nBom retorno!`));
                                } catch(e) { console.error(`Erro Whats Funcionario Férias:`, e.message); }
                            }
                        }
                    }
                } catch (e) { console.error('❌ [CRON] Erro Retorno Afastamento:', e.message); }

                console.log('✅ [CRON] Rotina diária concluída com sucesso sem erros.');
            } catch (error) {
                console.error('❌ [CRON] Erro grave na rotina diária:', error);
                // Reseta para tentar novamente amanhã (não apaga o banco — só o cache em memória)
                _lastDailyRunDate = null;
            }
        }

        // ====================================================================
        // 2. LIMPEZA + AVISO DE TIMEOUT DO CHATBOT
        // ====================================================================
        // item 12: avisa sessões prestes a expirar (entre 25 e 29 min de inatividade)
        try {
            const [quaseExpirando] = await db.query(
                `SELECT id, phone_number, employee_name FROM whatsapp_chatbot_sessions
                 WHERE step NOT IN ('concluido', 'cancelado', 'processando')
                   AND last_activity BETWEEN DATE_SUB(NOW(), INTERVAL 29 MINUTE)
                                        AND DATE_SUB(NOW(), INTERVAL 25 MINUTE)`
            );
            for (const s of quaseExpirando) {
                if (!chatbotTimeoutWarningsSent.has(s.id)) {
                    chatbotTimeoutWarningsSent.add(s.id);
                    await whatsappService.enviarMensagem(
                        s.phone_number,
                        s.employee_name || 'Usuário',
                        'CHATBOT_TIMEOUT_AVISO',
                        `⏰ Sua solicitação de abastecimento será cancelada em 5 minutos por inatividade.\n\nResponda para continuar ou envie *cancelar* para encerrar.`
                    ).catch(e => console.error('[CRON] Erro ao enviar aviso timeout chatbot:', e.message));
                }
            }
            // Limpa o Set periodicamente para não crescer indefinidamente
            if (chatbotTimeoutWarningsSent.size > 500) chatbotTimeoutWarningsSent.clear();
        } catch (e) { console.error('❌ [CRON] Erro no aviso timeout chatbot:', e.message); }

        // Remove sessões inativas há mais de 30min que não foram concluídas
        try {
            await db.query(
                `UPDATE whatsapp_chatbot_sessions SET step = 'cancelado'
                 WHERE step NOT IN ('concluido', 'cancelado')
                   AND last_activity < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
            );
        } catch (e) { console.error('❌ [CRON] Erro ao limpar sessões chatbot:', e.message); }

        // ====================================================================
        // 3. ROTINA DE MINUTOS (Lembretes Agenda Real-Time)
        // Pré-filtrado no SQL: só eventos com reminders pendentes no próximo mês
        // ====================================================================
        const [eventos] = await db.query(`
            SELECT id, user_id, title, DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime_str, reminders
            FROM user_agenda
            WHERE is_completed = 0
              AND reminders IS NOT NULL
              AND event_datetime BETWEEN NOW() - INTERVAL 1 DAY AND NOW() + INTERVAL 1 MONTH
        `);

        if (eventos.length > 0) {
            const agora = Date.now();

            for (const evento of eventos) {
                if (!evento.reminders || !evento.event_datetime_str) continue;

                let reminders = [];
                try {
                    reminders = typeof evento.reminders === 'string' ? JSON.parse(evento.reminders) : evento.reminders;
                } catch (e) { continue; }

                if (!Array.isArray(reminders) || reminders.length === 0) continue;

                let atualizouBanco = false;
                const dataEventoMs = new Date(evento.event_datetime_str + '-03:00').getTime();

                for (let i = 0; i < reminders.length; i++) {
                    const rem = reminders[i];
                    if (rem.sent) continue;

                    let subtrairMs = 0;
                    if (rem.minutes !== undefined) {
                        subtrairMs = rem.minutes * 60000;
                    } else {
                        if (rem.unit === 'minutos') subtrairMs = rem.value * 60000;
                        else if (rem.unit === 'horas') subtrairMs = rem.value * 3600000;
                        else if (rem.unit === 'dias') subtrairMs = rem.value * 86400000;
                        else if (rem.unit === 'semanas') subtrairMs = rem.value * 604800000;
                        else if (rem.unit === 'meses') subtrairMs = rem.value * 2592000000;
                    }

                    const dataGatilhoMs = dataEventoMs - subtrairMs;

                    if (agora >= dataGatilhoMs) {
                        if (global.io) {
                            let msgTempo = rem.unit === 'na_hora' ? 'começará agora!' : (rem.label ? `começará em ${rem.label.replace(' antes', '')}.` : `começará em ${rem.value} ${rem.unit}.`);
                            global.io.emit('agenda:alerta', {
                                userId: evento.user_id,
                                eventId: evento.id,
                                title: 'Lembrete de Agenda',
                                message: `Lembrete: "${evento.title}" ${msgTempo}`
                            });
                        }
                        rem.sent = true;
                        atualizouBanco = true;
                    }
                }

                if (atualizouBanco) {
                    await db.query('UPDATE user_agenda SET reminders = ? WHERE id = ?', [JSON.stringify(reminders), evento.id]);
                }
            }
        }
        // ====================================================================
        // 4. SYNC INCREMENTAL SIGA SUL (jornadas, a cada minuto)
        // ====================================================================
        try {
            await syncJourneyEvents();
        } catch (e) { console.error('❌ [CRON] Erro syncJourneyEvents:', e.message); }

    } catch (error) {
        console.error('❌ [CRON] Erro crítico no Tick do Cron:', error);
    }
});

// ====================================================================
// CRON DIÁRIO — Sync de posições GPS Siga Sul (02:05 GMT-3)
// ====================================================================
cron.schedule('5 5 * * *', async () => {
    try {
        await syncPositions();
    } catch (e) {
        console.error('❌ [CRON] Erro syncPositions:', e.message);
    }
});

// ====================================================================
// CRON SEMANAL — Limpeza de arquivos de upload antigos (domingo 02:00)
// ====================================================================
cron.schedule('0 2 * * 0', () => {
    const { join } = require('path');
    const { readdir, stat, unlink } = require('fs');
    const uploadPath = join(__dirname, '../public/uploads/orders');
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias
    const now = Date.now();

    readdir(uploadPath, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = join(uploadPath, file);
            stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtime.getTime() > maxAge) {
                    unlink(filePath, () => {});
                }
            });
        });
    });
});

// ====================================================================
// CRON DIÁRIO — Sync resumo diário Siga Sul + Rotação de logs WhatsApp
// ====================================================================
cron.schedule('0 3 * * *', async () => {
    try {
        await syncDailySummary();
    } catch (e) {
        console.error('❌ [CRON] Erro syncDailySummary:', e.message);
    }
    try {
        await db.query(`DELETE FROM whatsapp_logs WHERE data_envio < DATE_SUB(NOW(), INTERVAL 6 MONTH)`);
    } catch (e) {
        console.error('❌ [CRON] Erro na limpeza de logs WhatsApp:', e.message);
    }
});

module.exports = cron;