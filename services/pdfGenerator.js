// services/pdfGenerator.js
// Geração server-side de PDFs de Autorização de Abastecimento.
// Espelha o layout do PDF cliente (jsPDF) usado em ComboioPage / RefuelingPage.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOGO_URL = 'https://i.postimg.cc/pVnwyfRq/MAK-Servi-os-Logotipo.png';
const LOGO_CACHE_PATH = path.join(__dirname, '..', 'public', 'mak-logo-cache.png');

// Baixa o logo uma vez e cacheia em disco — silenciosamente ignorado se falhar.
const ensureLogo = () => new Promise((resolve) => {
    if (fs.existsSync(LOGO_CACHE_PATH)) return resolve(LOGO_CACHE_PATH);
    const file = fs.createWriteStream(LOGO_CACHE_PATH);
    https.get(LOGO_URL, (res) => {
        if (res.statusCode !== 200) { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); return resolve(null); }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(LOGO_CACHE_PATH)));
    }).on('error', () => { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); resolve(null); });
});

// ─── Formatação ─────────────────────────────────────────────────────────────
const fmtFuel = (f) => {
    const map = { dieselS10: 'Diesel S10', dieselS500: 'Diesel S500', dieselComum: 'Diesel Comum',
                  gasolinaComum: 'Gasolina Comum', gasolinaAditivada: 'Gasolina Aditivada',
                  etanol: 'Etanol', arla32: 'Arla 32' };
    return map[f] || f || 'N/A';
};

const fmtDate = (d) => {
    if (!d) return 'N/A';
    try {
        const date = new Date(d);
        if (isNaN(date.getTime())) return 'N/A';
        return date.toLocaleDateString('pt-BR');
    } catch { return 'N/A'; }
};

// ─── Builder ────────────────────────────────────────────────────────────────
// Recebe um objeto `order` com os mesmos campos usados em orderNotifier.buildOrderText
// + extras opcionais. Retorna uma Promise<Buffer>.
const generateOrderPdf = async (order = {}) => {
    const logoPath = await ensureLogo();

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pageWidth = doc.page.width;
        const margin = 40;

        // ── Cabeçalho ────────────────────────────────────────────────
        if (logoPath) {
            try { doc.image(logoPath, margin, 35, { width: 130 }); } catch (_) {}
        }
        doc.font('Helvetica-Bold').fontSize(18)
            .text('Autorização de Abastecimento', 0, 40, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica').fontSize(12)
            .text(`Nº ${String(order.authNumber || '0').padStart(6, '0')}`, 0, 62, { align: 'right', width: pageWidth - margin });

        // ── Tabela de dados ──────────────────────────────────────────
        const rows = [
            ['Data de Emissão',         fmtDate(order.date)],
            ['Funcionário Autorizado',  order.employeeName || 'Não especificado'],
            ['Veículo Autorizado',      order.vehicleLabel || 'N/A'],
            ['Modelo',                  order.vehicleModelo || ''],
            [order.readingLabel || 'Leitura', String(order.readingValue ?? 'N/A')],
            ['Posto Autorizado',        order.partnerName || (order.tipo === 'saida' ? 'Comboio Interno' : 'N/A')],
            ['Combustível Autorizado',  fmtFuel(order.fuelType)],
            ['Litros Liberados',        `${parseFloat(order.liters || 0).toFixed(2)} L`],
        ];
        if (order.pricePerLiter) rows.push(['Valor por Litro', `R$ ${parseFloat(order.pricePerLiter).toFixed(3)}`]);
        if (order.valorTotal)    rows.push(['Valor Total',     `R$ ${parseFloat(order.valorTotal).toFixed(2)}`]);
        if (order.invoiceNumber) rows.push(['Nota Fiscal (NF)', String(order.invoiceNumber)]);
        if (order.obraName)      rows.push(['Obra/Centro de Custo', order.obraName]);
        if (order.needsArla) {
            rows.push(['Arla 32 Autorizado',
                order.isFillUpArla ? 'Completar Tanque' : `${parseFloat(order.litrosLiberadosArla || 0).toFixed(2)} L`]);
        }
        if (order.outros) {
            const valor = order.outrosValor ? ` (R$ ${parseFloat(order.outrosValor).toFixed(2)})` : '';
            rows.push(['Outros Itens/Observação', `${order.outros}${valor}`]);
        }
        if (order.observacao)    rows.push(['Observação', order.observacao]);
        rows.push(['Emitido por', order.issuer || 'Sistema MAK Frotas']);

        const tableTop = 105;
        const labelWidth = 160;
        const valueWidth = pageWidth - margin * 2 - labelWidth;
        const rowHeight = 18;
        const fontSize = 9;

        rows.forEach((r, i) => {
            const y = tableTop + i * rowHeight;
            // Zebra
            if (i % 2 === 0) {
                doc.rect(margin, y, pageWidth - margin * 2, rowHeight).fill('#f3f4f6').fillColor('black');
            }
            doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#374151')
                .text(r[0], margin + 6, y + 5, { width: labelWidth - 12 });
            doc.font('Helvetica').fontSize(fontSize).fillColor('#111827')
                .text(String(r[1] || ''), margin + labelWidth, y + 5, { width: valueWidth - 6 });
        });

        // ── Rodapé / Disclaimers ─────────────────────────────────────
        const footerY = tableTop + rows.length * rowHeight + 8;
        doc.font('Helvetica-Oblique').fontSize(7).fillColor('#4b5563');
        doc.text(
            '*A presente ordem de abastecimento é válida exclusivamente para a placa/RE indicada e para o tipo de combustível previamente autorizado.',
            margin, footerY, { width: pageWidth - margin * 2 }
        );
        doc.text(
            '*Estão autorizados somente os itens discriminados acima.',
            margin, footerY + 14, { width: pageWidth - margin * 2 }
        );

        // Linha tracejada de corte (meio da página)
        const cutY = doc.page.height / 2;
        doc.moveTo(0, cutY).lineTo(pageWidth, cutY)
            .dash(3, { space: 2 }).strokeColor('#9ca3af').stroke();

        doc.end();
    });
};

module.exports = { generateOrderPdf };
