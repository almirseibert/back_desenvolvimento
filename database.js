const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// Local: .env.local carregado primeiro com override (banco de teste)
// Easypanel: arquivos .env não existem no container, process.env já vem
//            com as variáveis de produção injetadas nativamente
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
}
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
}

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 30000,
});

(async () => {
    try {
        const [[{ bancoConectado }]] = await db.query('SELECT DATABASE() AS bancoConectado');
        console.log(`✅ Banco de dados conectado: ${bancoConectado} (${process.env.DB_HOST})`);
    } catch (err) {
        console.error('❌ Erro ao verificar conexão com o banco:', err.message);
    }
})();

module.exports = db;
