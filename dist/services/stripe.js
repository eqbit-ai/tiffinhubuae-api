"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STRIPE_PREMIUM_PRICE_ID = exports.STRIPE_WEBHOOK_SECRET = exports.stripe = void 0;
const stripe_1 = __importDefault(require("stripe"));
const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
exports.stripe = new stripe_1.default(stripeKey, {
    apiVersion: '2024-12-18.acacia',
});
exports.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
exports.STRIPE_PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID || '';
//# sourceMappingURL=stripe.js.map