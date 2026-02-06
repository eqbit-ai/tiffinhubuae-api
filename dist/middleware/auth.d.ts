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
export declare function generateToken(userId: string): string;
export declare function generateCustomerToken(customerId: string, merchantId: string): string;
export declare function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
export declare function superAdminOnly(req: AuthRequest, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function checkPremiumAccess(req: AuthRequest, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function customerAuthMiddleware(req: CustomerAuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=auth.d.ts.map