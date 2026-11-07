<?php
declare(strict_types=1);
const LIGHTPAY_BRIDGE_SECRET_FILE = __DIR__ . '/secret';
const LIGHTPAY_NOTIFY = 'https://example.invalid/notify';
const LIGHTPAY_RETURN = 'https://example.invalid/return';
function lightpayConfig(): array { return []; }
function lightpayAmount(string $amount): string {
    if (!preg_match('/^\d+\.\d{2}$/', $amount)) throw new InvalidArgumentException('invalid_amount');
    return $amount;
}
function lightpayDb(): PDO {
    return new PDO('sqlite:' . __DIR__ . '/orders.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}
