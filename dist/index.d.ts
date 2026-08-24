/** Алерт — всё, что умеет показать APNs. Неизвестные поля сервер отбрасывает. */
export interface Alert {
    type?: string;
    title?: string;
    message?: string;
    subtitle?: string;
    /** media_id из uploadImage либо готовый https-URL */
    image?: string;
    sound?: string;
    category?: string;
    thread?: string;
    collapse_id?: string;
    priority?: "high" | "normal";
    interruption?: "passive" | "active" | "time-sensitive";
    badge?: number;
    expires_in?: number;
    numbers?: number[];
    data?: Record<string, unknown>;
}
export interface SendResult {
    ok: boolean;
    id: string;
    encrypted: boolean;
    subscribers: number;
    apns: {
        sent: number;
        failed: number;
        reason: string | null;
    } | null;
    /** остаток квоты из заголовков X-Quota-*; null, если сервер их не прислал */
    quota: Quota | null;
}
export interface Quota {
    limit: number;
    remaining: number;
    resetAt: number;
}
export interface UploadResult {
    media_id: string;
    url: string;
    bytes: number;
    type: string;
}
/** Квота токена исчерпана (HTTP 429). Повторять запрос бессмысленно до resetAt. */
export declare class QuotaExceededError extends Error {
    readonly limit: number;
    readonly resetAt: number;
    constructor(limit: number, resetAt: number);
}
export declare class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export interface SekundantOptions {
    baseUrl: string;
    /** API-токен (sk_...) из дашборда */
    token?: string;
    /** Ed25519-ключ тенанта для X-Signature: PKCS8 в base64 или PEM */
    signingKey?: string;
    /** попыток на сетевые ошибки и 5xx (по умолчанию 3) */
    retries?: number;
    fetch?: typeof fetch;
}
export declare class Sekundant {
    private readonly baseUrl;
    private readonly token?;
    private readonly retries;
    private readonly fetchImpl;
    private signingKeyPromise;
    constructor(opts: SekundantOptions);
    /** Публикует алерт в топик. Бросает QuotaExceededError при исчерпанной квоте. */
    send(topic: string, alert: Alert): Promise<SendResult>;
    /** Загружает картинку; в алерт передаётся вернувшийся media_id. */
    uploadImage(topic: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<UploadResult>;
    /** Проверяет собственный токен и возвращает остаток квоты. */
    quota(): Promise<Quota & {
        name: string;
    }>;
    /** Ретраи только на сеть и 5xx: 4xx означает ошибку запроса, повтор не поможет. */
    private request;
}
