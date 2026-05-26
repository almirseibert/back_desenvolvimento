// database.js — VERSÃO DE DIAGNÓSTICO DEFINITIVO
//
// Esta versão:
//   1. Limpa explicitamente process.env das chaves DB_* ANTES de carregar dotenv,
//      garantindo que nenhum require anterior de dotenv contamine os valores.
//   2. Carrega .env.local PRIMEIRO com `override: true` (força sobrescrita).
//   3. Carrega .env depois SEM override (só preenche o que faltou).
//   4. Cria o pool e IMEDIATAMENTE faz uma query SELECT DATABASE() real para
//      provar em qual banco está conectado.
//   5. Imprime tudo de forma bem clara no console.

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

const colors = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', bold: '\x1b[1m', bgRed: '\x1b[41m', bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
};

// ----------------------------------------------------------------------------
// PASSO 1: Limpar process.env das chaves DB_* antes de carregar qualquer .env
// (caso server.js já tenha chamado dotenv antes deste arquivo)
// ----------------------------------------------------------------------------
const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE'];

console.log('');
console.log(colors.cyan + colors.bold + '┌─── DATABASE.JS DIAGNÓSTICO ───────────────────────────────────┐' + colors.reset);

// Mostra o que estava em process.env ANTES da nossa limpeza
const valoresAntes = {};
DB_KEYS.forEach(k => { valoresAntes[k] = process.env[k]; });
console.log(colors.cyan + '│' + colors.reset + ' Valores em process.env ANTES de limpar:');
DB_KEYS.forEach(k => {
    const v = valoresAntes[k];
    if (k === 'DB_PASSWORD' && v) {
        console.log(`│   ${k} = ${'*'.repeat(Math.min(v.length, 8))} (${v.length} chars)`);
    } else {
        console.log(`│   ${k} = ${v || colors.yellow + '(indefinido)' + colors.reset}`);
    }
});

// Limpa as variáveis DB_* (mas guarda backup pra restaurar se algo der errado)
DB_KEYS.forEach(k => { delete process.env[k]; });

// ----------------------------------------------------------------------------
// PASSO 2: Carregar .env.local com override (vence sobre qualquer coisa)
// ----------------------------------------------------------------------------
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

const envLocalExists = fs.existsSync(envLocalPath);
const envExists = fs.existsSync(envPath);

console.log(colors.cyan + '│' + colors.reset + ` .env.local existe? ${envLocalExists ? 'SIM' : 'NÃO'} (${envLocalPath})`);
console.log(colors.cyan + '│' + colors.reset + ` .env existe?       ${envExists ? 'SIM' : 'NÃO'} (${envPath})`);

let envLocalResult = null;
if (envLocalExists) {
    envLocalResult = dotenv.config({ path: envLocalPath, override: true });
    const parsed = envLocalResult.parsed || {};
    const dbKeysNoLocal = Object.keys(parsed).filter(k => DB_KEYS.includes(k));
    console.log(colors.cyan + '│' + colors.reset + ` .env.local carregou ${Object.keys(parsed).length} variáveis (das quais ${dbKeysNoLocal.length} são DB_*)`);
    if (dbKeysNoLocal.length === 0) {
        console.log(colors.bgYellow + colors.bold + ' ⚠️  ATENÇÃO: .env.local existe mas NÃO contém variáveis DB_*! ' + colors.reset);
        console.log(colors.cyan + '│' + colors.reset + ' Conteúdo do .env.local (chaves apenas):');
        Object.keys(parsed).forEach(k => console.log(`│   - ${k}`));
    } else {
        console.log(colors.cyan + '│' + colors.reset + ` DB_* encontradas em .env.local: ${dbKeysNoLocal.join(', ')}`);
    }
}

// ----------------------------------------------------------------------------
// PASSO 3: Carregar .env só pra preencher o que faltou
// ----------------------------------------------------------------------------
if (envExists) {
    dotenv.config({ path: envPath, override: false });
}

// ----------------------------------------------------------------------------
// PASSO 4: Mostrar o que VAI ser usado
// ----------------------------------------------------------------------------
console.log(colors.cyan + '│' + colors.reset);
console.log(colors.cyan + '│' + colors.reset + ' Valores FINAIS que serão usados pelo pool:');
DB_KEYS.forEach(k => {
    const v = process.env[k];
    if (k === 'DB_PASSWORD' && v) {
        console.log(`│   ${k} = ${'*'.repeat(Math.min(v.length, 8))} (${v.length} chars)`);
    } else {
        console.log(`│   ${k} = ${v || colors.red + '(VAZIO!)' + colors.reset}`);
    }
});

console.log(colors.cyan + colors.bold + '└────────────────────────────────────────────────────────────────┘' + colors.reset);
console.log('');

// ----------------------------------------------------------------------------
// PASSO 5: Criar pool e fazer query de PROVA
// ----------------------------------------------------------------------------
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// PROVA REAL: Executa uma query e mostra o que o servidor MySQL responde
(async () => {
    try {
        const [rows] = await db.query(`
            SELECT 
                DATABASE() AS bancoConectado,
                @@hostname AS hostnameDoServidor,
                @@port AS portaDoServidor,
                CURRENT_USER() AS usuarioConectado,
                NOW() AS horaAtual
        `);
        const r = rows[0];

        // Tenta executar a query do teste pra ver se as obras têm o prefixo 🧪 TESTE -
        const [obras] = await db.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN nome LIKE '🧪 TESTE -%' THEN 1 ELSE 0 END) AS comMarca FROM obras`);
        const obrasInfo = obras[0];

        const ehTeste = obrasInfo.comMarca > 0;
        const cor = ehTeste ? colors.bgGreen : colors.bgRed;
        const label = ehTeste ? ' BANCO DE TESTE (CONFIRMADO POR QUERY!) ' : ' BANCO DE PRODUÇÃO (CONFIRMADO POR QUERY!) ';

        console.log(colors.cyan + colors.bold + '┌─── PROVA REAL VIA SELECT (não confia em .env) ──────────────────┐' + colors.reset);
        console.log(`│ Banco conectado : ${r.bancoConectado}`);
        console.log(`│ Hostname MySQL  : ${r.hostnameDoServidor}`);
        console.log(`│ Porta do servidor: ${r.portaDoServidor}`);
        console.log(`│ Usuário         : ${r.usuarioConectado}`);
        console.log(`│ Hora servidor   : ${r.horaAtual}`);
        console.log(`│ Obras totais    : ${obrasInfo.total}`);
        console.log(`│ Obras com '🧪 TESTE -': ${obrasInfo.comMarca}`);
        console.log('│');
        console.log(`│ VEREDITO: ${cor + colors.bold + label + colors.reset}`);
        console.log(colors.cyan + colors.bold + '└────────────────────────────────────────────────────────────────┘' + colors.reset);
        console.log('');
    } catch (err) {
        console.error(colors.red + colors.bold + '❌ FALHA AO EXECUTAR QUERY DE PROVA:' + colors.reset, err.message);
    }
})();

module.exports = db;
