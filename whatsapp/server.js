require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT    = process.env.PORT || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let clientStatus = 'DESCONECTADO';
let qrRaw        = null;
let client       = null;
let reconnectTimer = null;

// ─── PUPPETEER ARGS ───────────────────────────────────────────────────────────
const isWindows = process.platform === 'win32';
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    ...(!isWindows ? ['--disable-dev-shm-usage', '--no-zygote'] : []),
];

// ─── FUNÇÃO DE LIMPEZA PROFUNDA ───────────────────────────────────────────────
function limparPastaSessao() {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        console.log('🧹 [SISTEMA] Deletando pasta de sessão corrompida...');
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('✅ [SISTEMA] Pasta de sessão removida com sucesso.');
        } catch (err) {
            console.error('❌ [SISTEMA] Erro ao deletar pasta de auth:', err);
        }
    }
}

// ─── ROTA PÚBLICA ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send('🟢 Microsserviço WhatsApp FrotasMAK operando de forma segura.');
});

app.get('/health', (req, res) => res.send('OK'));

// ─── MIDDLEWARE DE AUTENTICAÇÃO API ───────────────────────────────────────────
app.use((req, res, next) => {
    const key = req.headers['apikey'] || req.headers['x-api-key'];
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'API Key inválida ou ausente.' });
    }
    next();
});

// ─── INICIALIZAÇÃO E CONTROLE DO CLIENTE WHATSAPP ─────────────────────────────
async function initClient() {
    if (client) {
        console.log('🔄 [SISTEMA] Destruindo instância anterior do Chromium...');
        try {
            await client.destroy();
        } catch (e) {
            console.log('⚠️ [SISTEMA] Aviso ao destruir Chromium:', e.message);
        }
    }

    clientStatus = 'DESCONECTADO';
    qrRaw = null;

    console.log('⏳ [WHATSAPP] Inicializando nova instância...');

    const puppeteerConfig = {
        args: PUPPETEER_ARGS,
        timeout: 120000,
        headless: true,
    };

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (execPath) puppeteerConfig.executablePath = execPath;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: puppeteerConfig,
    });

    client.on('qr', (qr) => {
        console.log('💡 [WHATSAPP] Novo QR Code gerado. Aguardando escaneamento...');
        qrRaw = qr;
        clientStatus = 'QR_PRONTO';
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ [WHATSAPP] Carregando: ${percent}% - ${message}`);
        clientStatus = 'AUTENTICANDO';
    });

    client.on('ready', () => {
        console.log('✅ [WHATSAPP] Cliente pronto e conectado!');
        clientStatus = 'PRONTO';
        qrRaw = null;
    });

    client.on('authenticated', () => {
        console.log('🔐 [WHATSAPP] Autenticado com sucesso! Baixando contatos e mensagens...');
        clientStatus = 'AUTENTICANDO';
        qrRaw = null;
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ [WHATSAPP] Falha na autenticação:', msg);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        limparPastaSessao();
        agendarReconexao(5000);
    });

    client.on('disconnected', (reason) => {
        console.log('❌ [WHATSAPP] WhatsApp desconectado pelo celular ou queda de rede!', reason);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        if (reason === 'NAVIGATION' || reason === 'CONFLICT') {
             limparPastaSessao();
        }
        agendarReconexao(5000);
    });

    // ─── HANDLER DE MENSAGENS RECEBIDAS ─────────────────────────────────────────
    client.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us') || msg.fromMe) return;

        const BACKEND_URL    = process.env.BACKEND_WEBHOOK_URL;
        const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
        if (!BACKEND_URL) return;

        try {
            let from = msg.from;

            // @lid é um identificador interno do WhatsApp — resolve para o número real
            if (from.endsWith('@lid')) {
                try {
                    const contact = await msg.getContact();
                    const resolved = contact?.id?._serialized;
                    if (resolved && !resolved.endsWith('@lid')) {
                        from = resolved;
                        console.log(`[CHATBOT] @lid resolvido via contact: ${msg.from} → ${from}`);
                    } else if (contact?.number) {
                        from = `${contact.number}@c.us`;
                        console.log(`[CHATBOT] @lid resolvido via number: ${msg.from} → ${from}`);
                    } else {
                        // Fallback: tenta pelo chat
                        const chat = await msg.getChat();
                        const chatResolved = chat?.id?._serialized;
                        if (chatResolved && !chatResolved.endsWith('@lid')) {
                            from = chatResolved;
                            console.log(`[CHATBOT] @lid resolvido via chat: ${msg.from} → ${from}`);
                        } else {
                            console.warn(`[CHATBOT] Não foi possível resolver @lid ${msg.from} — mensagem ignorada.`);
                            return;
                        }
                    }
                } catch (e) {
                    console.warn('[CHATBOT] Não foi possível resolver @lid:', e.message);
                    return;
                }
            }
            let mediaBase64 = null, mediaMimetype = null;

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media && media.mimetype?.startsWith('image/')) {
                        const MAX_BYTES = 2 * 1024 * 1024; // 2 MB após compressão
                        const original = Buffer.from(media.data, 'base64');
                        let finalBuffer = original;

                        if (original.length > MAX_BYTES) {
                            finalBuffer = await sharp(original)
                                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                                .jpeg({ quality: 80 })
                                .toBuffer();

                            // Se ainda acima do limite, reduz mais agressivamente
                            if (finalBuffer.length > MAX_BYTES) {
                                finalBuffer = await sharp(original)
                                    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                                    .jpeg({ quality: 65 })
                                    .toBuffer();
                            }

                            console.log(`[CHATBOT] Imagem comprimida: ${(original.length / 1024).toFixed(0)} KB → ${(finalBuffer.length / 1024).toFixed(0)} KB`);
                        }

                        mediaBase64 = finalBuffer.toString('base64');
                        mediaMimetype = 'image/jpeg';
                    } else if (media) {
                        mediaBase64 = media.data;
                        mediaMimetype = media.mimetype;
                    }
                } catch (_) {}
            }

            await fetch(`${BACKEND_URL}/api/whatsapp/webhook`, {
                method:  'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'x-webhook-secret': WEBHOOK_SECRET || '',
                },
                body: JSON.stringify({
                    from,
                    body:          msg.body || '',
                    hasMedia:      msg.hasMedia,
                    mediaBase64,
                    mediaMimetype,
                    timestamp:     msg.timestamp,
                }),
                timeout: 30000,
            });

            console.log(`📩 [CHATBOT] Mensagem de ${from} encaminhada ao backend.`);
        } catch (err) {
            console.error('[CHATBOT] Erro ao encaminhar mensagem:', err.message);
        }
    });

    try {
        await client.initialize();
    } catch (err) {
        console.error('🚨 [CRÍTICO] Erro fatal ao iniciar o Puppeteer:', err);
        clientStatus = 'DESCONECTADO';
        agendarReconexao(10000);
    }
}

function agendarReconexao(tempo = 10000) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        console.log('🔄 [SISTEMA] Tentando reconectar automaticamente...');
        initClient();
    }, tempo);
}

// ─── ROTAS DA API PROTEGIDAS ──────────────────────────────────────────────────

app.get('/status', (req, res) => {
    res.json({ status: clientStatus, qr: qrRaw });
});

app.post('/send', async (req, res) => {
    if (clientStatus !== 'PRONTO') {
        return res.status(503).json({ error: `WhatsApp não está pronto. Status atual: ${clientStatus}` });
    }

    const { number, message, documentUrl } = req.body;

    try {
        // Suporta @c.us — usa o sufixo original se já vier com @
        let chatId = number.includes('@') ? number : `${number}@c.us`;

        // @lid não pode ser usado no sendMessage — tenta resolver para @c.us
        if (chatId.endsWith('@lid')) {
            try {
                const contact = await client.getContactById(chatId);
                const resolved = contact?.id?._serialized;
                if (resolved && !resolved.endsWith('@lid')) {
                    console.log(`[SEND] @lid resolvido: ${chatId} → ${resolved}`);
                    chatId = resolved;
                } else if (contact?.number) {
                    chatId = `${contact.number}@c.us`;
                    console.log(`[SEND] @lid resolvido via number: ${number} → ${chatId}`);
                } else {
                    return res.status(400).json({ error: `Identificador @lid não pôde ser resolvido para um número válido.` });
                }
            } catch (lidErr) {
                console.warn(`⚠️ Não foi possível resolver @lid ${chatId}:`, lidErr.message);
                return res.status(400).json({ error: `Não foi possível resolver o identificador @lid para envio.` });
            }
        }

        // Verifica se o número está cadastrado no WhatsApp antes de enviar
        try {
            const isRegistered = await client.isRegisteredUser(chatId);
            if (!isRegistered) {
                console.warn(`⚠️ Número ${chatId} não está registrado no WhatsApp.`);
                return res.status(400).json({ error: `Número ${number} não possui conta no WhatsApp.` });
            }
        } catch (checkErr) {
            // Não bloqueia o envio se a verificação falhar
            console.warn('⚠️ Não foi possível verificar registro do número:', checkErr.message);
        }

        const resp = await client.sendMessage(chatId, message);
        const messageId = resp?.id?._serialized || null;

        if (documentUrl) {
            console.log(`📎 Baixando anexo de: ${documentUrl}`);
            const media = await MessageMedia.fromUrl(
                documentUrl,
                { unsafeMime: true }
            );
            media.filename = 'Documento_FrotasMAK.pdf';
            await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
        }

        console.log(`✅ Mensagem enviada para -> ${number}`);
        res.json({ success: true, messageId });

    } catch (err) {
        // whatsapp-web.js pode lançar valores não-padrão (strings minificadas como "t", "e", etc.)
        let errMsg;
        if (err instanceof Error) {
            errMsg = err.message;
        } else if (typeof err === 'string') {
            errMsg = err;
        } else {
            try { errMsg = JSON.stringify(err); } catch (_) { errMsg = String(err); }
        }

        // Se o erro é uma única letra, provavelmente é um erro minificado do WA Web
        if (errMsg && errMsg.length <= 2) {
            console.error(`❌ Erro ao enviar mensagem (código WA minificado "${errMsg}"):`, err);
            errMsg = `Erro interno do WhatsApp Web (código: "${errMsg}"). Verifique se o número existe e o cliente está estável.`;
        } else {
            console.error('❌ Erro ao enviar mensagem:', err);
        }

        res.status(500).json({ error: errMsg || 'Erro desconhecido ao enviar mensagem.' });
    }
});

app.post('/restart', async (req, res) => {
    console.log('🔄 Reinício manual solicitado.');
    if (reconnectTimer) clearTimeout(reconnectTimer);

    limparPastaSessao();

    setTimeout(() => { initClient(); }, 1000);

    res.json({ success: true, message: 'Sessões limpas. Reiniciando microsserviço...' });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
initClient();

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log(`║  🟢 FrotaMAK WhatsApp Service          ║`);
    console.log(`║  📡 Porta: ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════╝');
});
