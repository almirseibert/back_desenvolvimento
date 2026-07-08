const express = require('express');
const router = express.Router();
const db = require('../database');

// GET /api/notification-log?limit=100&event_type=combustivel_obra_20pct&obra_id=xxx
router.get('/', async (req, res) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit) || 200, 500);
        const where  = [];
        const params = [];

        if (req.query.event_type) { where.push('event_type = ?'); params.push(req.query.event_type); }
        if (req.query.obra_id)    { where.push('obra_id = ?');    params.push(req.query.obra_id); }
        if (req.query.channel)    { where.push('channel = ?');    params.push(req.query.channel); }
        if (req.query.status)     { where.push('status = ?');     params.push(req.query.status); }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(limit);

        const [rows] = await db.query(
            `SELECT * FROM notification_log ${whereClause} ORDER BY created_at DESC LIMIT ?`,
            params
        );
        res.json(rows);
    } catch (err) {
        console.error('[notification-log] GET:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
