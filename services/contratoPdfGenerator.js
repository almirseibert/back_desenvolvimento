// services/contratoPdfGenerator.js
// Geração server-side do PDF de Contrato de Prestação de Serviço / Locação de
// Equipamento com Operador (terceirizados). Reaproveita o cache de logo do
// pdfGenerator de abastecimento.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOGO_URL = 'https://i.postimg.cc/pVnwyfRq/MAK-Servi-os-Logotipo.png';
const LOGO_CACHE_PATH = path.join(__dirname, '..', 'public', 'mak-logo-cache.png');

const ensureLogo = () => new Promise((resolve) => {
    if (fs.existsSync(LOGO_CACHE_PATH)) return resolve(LOGO_CACHE_PATH);
    const file = fs.createWriteStream(LOGO_CACHE_PATH);
    https.get(LOGO_URL, (res) => {
        if (res.statusCode !== 200) { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); return resolve(null); }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(LOGO_CACHE_PATH)));
    }).on('error', () => { file.close(); fs.unlink(LOGO_CACHE_PATH, () => {}); resolve(null); });
});

const fmtBRL = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtNum = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDate = (d) => {
    if (!d) return '____/____/______';
    try {
        const date = new Date(d);
        if (isNaN(date.getTime())) return '____/____/______';
        return date.toLocaleDateString('pt-BR');
    } catch { return '____/____/______'; }
};

/**
 * Gera o PDF do contrato. Recebe { contrato, locador, obra }.
 * Retorna Promise<Buffer>.
 */
const generateContratoPdf = async ({ contrato = {}, locador = {}, obra = {} } = {}) => {
    const logoPath = await ensureLogo();

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const margin = 50;
        const pageWidth = doc.page.width;
        const contentWidth = pageWidth - margin * 2;

        // ── Cabeçalho ────────────────────────────────────────────────
        if (logoPath) {
            try { doc.image(logoPath, margin, 40, { width: 120 }); } catch (_) {}
        }
        doc.font('Helvetica-Bold').fontSize(15)
            .text('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', 0, 48, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica').fontSize(11)
            .text('Locação de equipamento com operador', 0, 68, { align: 'right', width: pageWidth - margin });
        doc.font('Helvetica-Bold').fontSize(11)
            .text(`Nº ${contrato.numero || '—'}`, 0, 84, { align: 'right', width: pageWidth - margin });

        doc.moveTo(margin, 110).lineTo(pageWidth - margin, 110).stroke('#cccccc');
        doc.y = 124;

        const paragraph = (text) => {
            doc.font('Helvetica').fontSize(10.5).fillColor('#000')
                .text(text, margin, doc.y, { width: contentWidth, align: 'justify', lineGap: 2 });
            doc.moveDown(0.6);
        };
        const heading = (text) => {
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
                .text(text, margin, doc.y, { width: contentWidth });
            doc.moveDown(0.2);
        };

        // ── Qualificação das partes ──────────────────────────────────
        paragraph(
            `CONTRATANTE: MAK SERVIÇOS, pessoa jurídica de direito privado, doravante ` +
            `denominada simplesmente CONTRATANTE.`
        );
        paragraph(
            `CONTRATADA: ${locador.razaoSocial || locador.nome || '___________________________'}` +
            `${locador.cnpj ? `, inscrita no CNPJ sob nº ${locador.cnpj}` : ''}` +
            `${locador.telefone ? `, telefone ${locador.telefone}` : ''}, doravante denominada ` +
            `simplesmente CONTRATADA.`
        );

        // ── Objeto ───────────────────────────────────────────────────
        heading('CLÁUSULA 1ª — DO OBJETO');
        paragraph(
            `O presente contrato tem por objeto a prestação de serviços de execução de horas de ` +
            `máquina do tipo ${contrato.tipoMaquina || '________________'}, pela CONTRATADA, na obra ` +
            `"${obra.nome || obra.nome_obra || '________________'}"${obra.regiao ? ` (${obra.regiao})` : ''}, ` +
            `mediante equipamento próprio com operador.`
        );

        // ── Volume e preço ───────────────────────────────────────────
        heading('CLÁUSULA 2ª — DO VOLUME E DO PREÇO');
        let itens = contrato.itensContratados;
        if (typeof itens === 'string') { try { itens = JSON.parse(itens); } catch { itens = []; } }
        if (!Array.isArray(itens)) itens = [];

        if (contrato.contractType === 'fechado') {
            paragraph(
                `A CONTRATADA executará o objeto pelo valor global e fechado de ` +
                `${fmtBRL(contrato.valorTotal)}, independentemente do volume de horas efetivamente executado.`
            );
        } else if (itens.length > 0) {
            paragraph(
                `A CONTRATADA executará os seguintes volumes de máquina, cujo somatório perfaz o valor ` +
                `global e fechado de ${fmtBRL(contrato.valorTotal)}:`
            );
            itens.forEach((i) => {
                const h = Number(i.hours) || 0;
                const p = Number(i.price) || 0;
                paragraph(
                    `• ${i.type || '—'}: ${fmtNum(h)} h × ${fmtBRL(p)}/h = ${fmtBRL(h * p)}.`
                );
            });
        } else {
            paragraph(
                `A CONTRATADA executará o total de ${fmtNum(contrato.horasContratadas)} horas de máquina, ` +
                `ao valor de ${fmtBRL(contrato.valorHora)} por hora, totalizando o valor global e fechado de ` +
                `${fmtBRL(contrato.valorTotal)}.`
            );
        }
        paragraph(
            `As horas efetivamente executadas serão apuradas pelo Relatório de Horas da CONTRATANTE, ` +
            `servindo de acompanhamento físico da execução, sem alterar o valor global ora ajustado.`
        );

        // ── Abatimentos ──────────────────────────────────────────────
        heading('CLÁUSULA 3ª — DOS ABATIMENTOS');
        paragraph(
            `Serão descontados do valor global os adiantamentos pagos pela CONTRATANTE, bem como o ` +
            `combustível fornecido pela CONTRATANTE aos equipamentos da CONTRATADA, valorado pelo preço ` +
            `efetivo de cada abastecimento. O saldo a pagar corresponde ao valor global deduzido de tais ` +
            `abatimentos.`
        );

        // ── Vigência ─────────────────────────────────────────────────
        heading('CLÁUSULA 4ª — DA VIGÊNCIA');
        paragraph(
            `O presente contrato vigora de ${fmtDate(contrato.vigenciaInicio)} a ` +
            `${fmtDate(contrato.vigenciaFim)}, podendo ser prorrogado mediante acordo entre as partes.`
        );

        if (contrato.observacoes) {
            heading('CLÁUSULA 5ª — DAS DISPOSIÇÕES GERAIS');
            paragraph(String(contrato.observacoes));
        }

        // ── Assinaturas ──────────────────────────────────────────────
        doc.moveDown(2);
        const sigY = Math.min(doc.y, doc.page.height - 130);
        doc.y = sigY;
        doc.font('Helvetica').fontSize(10)
            .text(`Local e data: ______________________, ${fmtDate(new Date())}`, margin, doc.y, { width: contentWidth });
        doc.moveDown(3);

        const colW = (contentWidth - 30) / 2;
        const lineY = doc.y;
        doc.moveTo(margin, lineY).lineTo(margin + colW, lineY).stroke('#000');
        doc.moveTo(margin + colW + 30, lineY).lineTo(pageWidth - margin, lineY).stroke('#000');
        doc.font('Helvetica-Bold').fontSize(9)
            .text('CONTRATANTE — MAK Serviços', margin, lineY + 4, { width: colW, align: 'center' });
        doc.text(`CONTRATADA — ${locador.razaoSocial || locador.nome || ''}`, margin + colW + 30, lineY + 4, { width: colW, align: 'center' });

        doc.end();
    });
};

module.exports = { generateContratoPdf };
