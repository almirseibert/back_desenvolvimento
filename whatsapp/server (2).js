require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

const PORT    = process.env.PORT || 3002;
const API_KEY = process.env.WHATSAPP_API_KEY;

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let clientStatus = 'DESCONECTADO';
let qrRaw        = null;   
let client       = null;
let reconnectTimer = null;

// ─── PUPPETEER ARGS (Ultra Otimizados para Docker/Linux) ──────────────────────
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Crítico para Docker (evita crash de memória RAM)
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process', // Ajuda na estabilidade em VPS menores
    '--disable-extensions'
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
    // 1. Garante que o cliente anterior foi totalmente destruído (await é crucial)
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
    
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: PUPPETEER_ARGS,
            timeout: 60000 // Dá mais tempo para o navegador abrir no Docker
        }
    });

    // Eventos principais de Estado
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
        clientStatus = 'AUTENTICANDO'; // Mantém como autenticando até o 'ready' disparar
        qrRaw = null;
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ [WHATSAPP] Falha na autenticação:', msg);
        clientStatus = 'DESCONECTADO';
        qrRaw = null;
        limparPastaSessao(); // Remove a sessão estragada para forçar novo QR
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

    const { number, message, documentUrl, documentFilename } = req.body;

    try {
        const chatId = `${number}@c.us`;

        const resp = await client.sendMessage(chatId, message);
        const messageId = resp?.id?._serialized || null;

        if (documentUrl) {
            console.log(`📎 Baixando anexo de: ${documentUrl}`);
            const media = await MessageMedia.fromUrl(
                documentUrl.replace('http://', 'https://'),
                { unsafeMime: true }
            );
            // Prioriza o nome enviado pelo backend (ex: Autorizacao_<n>_<RI>_<data>.pdf).
            // Senão tenta extrair do final da URL. Como ultimo fallback, nome generico.
            const fromUrl = (() => {
                try {
                    const tail = decodeURIComponent(documentUrl.split('?')[0].split('/').pop() || '');
                    return tail && tail.toLowerCase().endsWith('.pdf') ? tail : null;
                } catch { return null; }
            })();
            media.filename = documentFilename || fromUrl || 'Documento_FrotasMAK.pdf';
            await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
        }

        console.log(`✅ Mensagem enviada para -> ${number}`);
        res.json({ success: true, messageId });

    } catch (err) {
        console.error('❌ Erro ao enviar mensagem:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/restart', async (req, res) => {
    console.log('🔄 Reinício manual solicitado.');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    limparPastaSessao(); // Sempre limpa no restart manual para garantir aba limpa
    
    // Inicia processo assíncrono para não travar a resposta da requisição HTTP
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