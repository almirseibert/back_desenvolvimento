const https = require('https');

const SIGASUL_BASE = 'https://gestao.sigasul.com.br';
const agent = new https.Agent({ rejectUnauthorized: false }); // SigaSul usa cert auto-assinado

const sigasulFetch = async (path) => {
    const token = process.env.SIGASUL_TOKEN;
    if (!token) throw new Error('SIGASUL_TOKEN não configurado no servidor.');

    const res = await fetch(`${SIGASUL_BASE}${path}`, {
        headers: {
            'x-auth-token': token,
            'Cache-Control': 'no-cache',
        },
        agent,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SigaSul retornou ${res.status}: ${text}`);
    }

    return res.json();
};

// GET /api/sigasul/positions
const getPositions = async (req, res) => {
    try {
        const data = await sigasulFetch('/api/positions/all');
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getPositions:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// GET /api/sigasul/positions/period?from=...&to=...
const getPositionsByPeriod = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });
    try {
        const data = await sigasulFetch(`/api/v1/positions/data/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getPositionsByPeriod:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// GET /api/sigasul/positions/vehicle/:plate?from=...&to=...
const getPositionsByPlate = async (req, res) => {
    const { plate } = req.params;
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });
    try {
        const data = await sigasulFetch(`/api/positions/veiculo/placa/${encodeURIComponent(plate)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getPositionsByPlate:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// GET /api/sigasul/journeys
const getJourneys = async (req, res) => {
    try {
        const data = await sigasulFetch('/api/jornadas/events/control');
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getJourneys:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// GET /api/sigasul/journeys/simplified?from=...&to=...
const getJourneysSimplified = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });
    try {
        const data = await sigasulFetch(`/api/jornadas/simplificada/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getJourneysSimplified:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// GET /api/sigasul/journeys/aggregate?from=...&to=...
// Divide o período em janelas de 24h e agrega tempoLigado + distancia por placa.
// Necessário porque o endpoint SigaSul aceita no máximo 24h por chamada.
const getJourneysAggregate = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });

    const hmsToMs = (hms) => {
        if (!hms) return 0;
        const [h, m, s] = hms.split(':').map(Number);
        return ((h * 3600) + (m * 60) + (s || 0)) * 1000;
    };

    try {
        const start = new Date(from.replace(' ', 'T'));
        const end   = new Date(to.replace(' ', 'T'));

        if (isNaN(start) || isNaN(end) || end <= start) {
            return res.status(400).json({ message: 'Período inválido.' });
        }

        const pad  = (n) => String(n).padStart(2, '0');
        const fmt  = (d) =>
            `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        // Divide em janelas de ≤ 24h
        const windows = [];
        let cursor = new Date(start);
        while (cursor < end) {
            const windowEnd = new Date(Math.min(cursor.getTime() + 24 * 3600 * 1000, end.getTime()));
            windows.push({ from: fmt(cursor), to: fmt(windowEnd) });
            cursor = windowEnd;
        }

        // Agrega por placa
        const totals = {}; // { [placa]: { totalMs, totalKm, eventos } }

        for (const w of windows) {
            let data;
            try {
                data = await sigasulFetch(
                    `/api/jornadas/simplificada/${encodeURIComponent(w.from)}/${encodeURIComponent(w.to)}`
                );
            } catch (e) {
                console.warn(`⚠️ SigaSul aggregate janela ${w.from}→${w.to}: ${e.message}`);
                continue;
            }

            if (!Array.isArray(data)) continue;

            for (const vehicle of data) {
                const placa = vehicle.placa;
                if (!placa) continue;
                if (!totals[placa]) totals[placa] = { placa, totalMs: 0, totalKm: 0, eventos: 0 };

                for (const ev of (vehicle.eventos || [])) {
                    totals[placa].totalMs  += hmsToMs(ev.tempoLigado);
                    totals[placa].totalKm  += Number(ev.distancia) || 0;
                    totals[placa].eventos  += 1;
                }
            }
        }

        const result = Object.values(totals).map(t => ({
            placa:            t.placa,
            totalHorasLigado: t.totalMs / 3600000,
            totalKm:          t.totalKm,
            eventos:          t.eventos,
        }));

        res.json(result);
    } catch (e) {
        console.error('❌ SigaSul getJourneysAggregate:', e.message);
        res.status(502).json({ message: e.message });
    }
};

module.exports = { getPositions, getPositionsByPeriod, getPositionsByPlate, getJourneys, getJourneysSimplified, getJourneysAggregate };
