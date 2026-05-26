const db = require('../database'); // <--- CORREÇÃO: Caminho correto (era ../config/database)
const fs = require('fs');
const path = require('path');

// Listar checklists de um veículo específico
exports.getChecklistsByVehicle = async (req, res) => {
    const { vehicleId } = req.params;

    try {
        // Busca checklists ordenados por data
        const [rows] = await db.execute(
            `SELECT id, data_checklist, pdf_path, observacoes, created_at 
             FROM checklists 
             WHERE vehicle_id = ? 
             ORDER BY data_checklist DESC`,
            [vehicleId]
        );
        res.json(rows);
    } catch (error) {
        console.error("Erro ao buscar checklists:", error);
        res.status(500).json({ message: "Erro interno ao buscar checklists." });
    }
};

// Receber upload do checklist (Mobile -> Web)
exports.uploadChecklist = async (req, res) => {
    // console.log("Recebendo upload...", req.body, req.file); // Debug se necessário

    const { vehicleId, date, items, observacoes, mobileId } = req.body;
    const file = req.file; // Arquivo PDF vindo do Multer

    if (!vehicleId || !file) {
        return res.status(400).json({ message: "Veículo e arquivo PDF são obrigatórios." });
    }

    // Caminho relativo para salvar no banco (ex: /uploads/checklists/arquivo.pdf)
    const pdfPath = `/uploads/checklists/${file.filename}`;

    try {
        const [result] = await db.execute(
            `INSERT INTO checklists (vehicle_id, data_checklist, pdf_path, items_json, observacoes, mobile_id) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [vehicleId, new Date(date), pdfPath, items, observacoes, mobileId]
        );

        res.status(201).json({ 
            message: "Checklist sincronizado com sucesso!", 
            id: result.insertId 
        });
        
        // Notifica o frontend em tempo real (se Socket.io estiver configurado)
        if (req.io) {
            req.io.emit('server:sync', { targets: ['vehicles', 'checklists'] });
        }

    } catch (error) {
        console.error("Erro ao salvar checklist no banco:", error);
        // Se der erro no banco, apaga o arquivo físico para não deixar lixo
        if (file && file.path) {
            fs.unlink(file.path, (err) => { if (err) console.error("Erro ao apagar arquivo órfão:", err); });
        }
        res.status(500).json({ message: "Erro ao salvar dados do checklist." });
    }
};