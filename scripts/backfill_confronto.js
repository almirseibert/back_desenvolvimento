// Backfill da tabela billing_tracker_confronto.
// Uso:
//   node scripts/backfill_confronto.js                  # últimos 14 dias
//   node scripts/backfill_confronto.js 2026-05-29       # de 29/05 até ontem
//   node scripts/backfill_confronto.js 2026-05-29 2026-06-11
//
// Idempotente (ON DUPLICATE KEY UPDATE).

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../database');
const { processRange } = require('../services/confrontoService');

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

(async () => {
    const args = process.argv.slice(2);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    let startDate, endDate;
    if (args.length === 0) {
        const start = new Date();
        start.setDate(start.getDate() - 14);
        startDate = toISO(start);
        endDate = toISO(yesterday);
    } else if (args.length === 1) {
        startDate = args[0];
        endDate = toISO(yesterday);
    } else {
        startDate = args[0];
        endDate = args[1];
    }

    console.log(`\n⏳ Backfill confronto: ${startDate} → ${endDate}\n`);
    const t0 = Date.now();

    try {
        const result = await processRange(startDate, endDate, {
            onProgress: (done, total) => {
                const pct = Math.round((done / total) * 100);
                process.stdout.write(`\r  ${done}/${total} (${pct}%)`);
            },
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n\n✅ Concluído em ${dt}s`);
        console.log(`   Pares (placa,data) totais: ${result.total}`);
        console.log(`   Processados: ${result.processed}  |  Ignorados: ${result.skipped}\n`);
        console.log('   Distribuição por bucket:');
        console.table(result.byBucket);
    } catch (e) {
        console.error('\n❌ Erro:', e.message);
        process.exitCode = 1;
    } finally {
        try { await db.end(); } catch (_) {}
    }
})();
