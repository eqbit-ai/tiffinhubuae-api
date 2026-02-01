"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const path_1 = __importDefault(require("path"));
const auth_1 = __importDefault(require("./routes/auth"));
const entities_1 = __importDefault(require("./routes/entities"));
const functions_1 = __importDefault(require("./routes/functions"));
const integrations_1 = __importDefault(require("./routes/integrations"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Stripe webhooks need raw body
app.use('/api/webhooks/stripe', express_1.default.raw({ type: 'application/json' }));
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
}));
app.use(express_1.default.json({ limit: '10mb' }));
// Static file serving for uploads
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Health check (before auth-gated routes)
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Routes
app.use('/api/auth', auth_1.default);
app.use('/api/functions', functions_1.default);
app.use('/api/integrations', integrations_1.default);
app.use('/api/webhooks', webhooks_1.default);
// Entity routes last (wildcard /:entity)
app.use('/api', entities_1.default);
app.listen(PORT, () => {
    console.log(`TiffinHub API running on port ${PORT}`);
});
exports.default = app;
//# sourceMappingURL=index.js.map