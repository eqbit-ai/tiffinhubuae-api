"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middleware/auth");
const email_1 = require("../services/email");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
// File upload config
const uploadsDir = path_1.default.join(__dirname, '../../uploads');
if (!fs_1.default.existsSync(uploadsDir))
    fs_1.default.mkdirSync(uploadsDir, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path_1.default.extname(file.originalname)}`;
        cb(null, uniqueName);
    },
});
const upload = (0, multer_1.default)({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
// POST /api/integrations/send-email
router.post('/send-email', async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'to, subject, body required' });
        }
        const result = await (0, email_1.sendEmail)({ to, subject, body });
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/integrations/upload
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: 'No file uploaded' });
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        res.json({ file_url: fileUrl, filename: req.file.filename });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=integrations.js.map