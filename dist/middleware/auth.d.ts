import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        role: string;
        full_name: string | null;
        is_super_admin: boolean;
        [key: string]: any;
    };
}
export interface CustomerAuthRequest extends Request {
    customer?: {
        id: string;
        full_name: string;
        phone_number: string | null;
        merchant_id: string;
        [key: string]: any;
    };
}
export interface DriverAuthRequest extends Request {
    driver?: {
        id: string;
        name: string;
        phone: string | null;
        merchant_id: string;
        [key: string]: any;
    };
}
export declare function generateToken(userId: string, impersonatedBy?: string): string;
export declare function generateCustomerToken(customerId: string, merchantId: string): string;
export declare function generateDriverToken(driverId: string, merchantId: string): string;
export declare function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
/**
 * Whether this user may use the product at all. There is one plan, so this is
 * the only entitlement question the app ever needs to ask — the mirror of the
 * frontend's utils/accessControl.hasPremiumAccess.
 */
export declare function hasProductAccess(user: {
    email?: string;
    is_super_admin?: boolean;
    special_access_type?: string | null;
    subscription_status?: string | null;
} | null | undefined): boolean;
export declare function superAdminOnly(req: AuthRequest, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function blockIfImpersonating(req: AuthRequest, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function checkActiveSubscription(req: AuthRequest, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
/**
 * There is one plan, so "premium" is no longer a tier — every feature ships to
 * every subscriber. Kept under its old name because ~10 routes reference it;
 * it is now exactly an active-subscription check.
 */
export declare const checkPremiumAccess: typeof checkActiveSubscription;
export declare function customerAuthMiddleware(req: CustomerAuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
export declare function driverAuthMiddleware(req: DriverAuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=auth.d.ts.map