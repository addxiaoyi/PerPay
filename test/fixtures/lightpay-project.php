<?php
declare(strict_types=1);
require dirname(__DIR__) . '/config.php';
require dirname(__DIR__) . '/vendor/autoload.php';
header('Content-Type: application/json; charset=utf-8');
function reply(int $status, array $body): never { http_response_code($status); echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
$expected = is_readable(LIGHTPAY_BRIDGE_SECRET_FILE) ? trim((string) file_get_contents(LIGHTPAY_BRIDGE_SECRET_FILE)) : '';
$supplied = trim((string) ($_SERVER['HTTP_X_INTERNAL_BRIDGE'] ?? $_SERVER['HTTP_X_LIGHTPAY_BRIDGE'] ?? ''));
$rawBody = file_get_contents('php://input') ?: '';
$bodyProbe = json_decode($rawBody, true);
if ($supplied === '' && is_array($bodyProbe)) $supplied = trim((string) ($bodyProbe['_bridge_token'] ?? ''));
if ($expected === '' || $supplied === '' || !hash_equals($expected, $supplied)) reply(401, ['ok' => false, 'error' => 'bridge_unauthorized']);
$input = $bodyProbe;
if (!is_array($input)) reply(400, ['ok' => false, 'error' => 'invalid_json']);
try {
    \Yansongda\Pay\Pay::config(lightpayConfig());
    $id = trim((string) ($input['orderId'] ?? '')); $merchantId = trim((string) ($input['merchantId'] ?? '')); $amount = lightpayAmount((string) ($input['amount'] ?? '')); $method = (string) ($input['method'] ?? 'web');
    if (!preg_match('/^[a-f0-9-]{36}$/i', $id) || $merchantId === '') throw new InvalidArgumentException('invalid_order');
    $db = lightpayDb();
    $db->prepare('INSERT INTO orders(id, amount, sponsor_name, merchant_id, callback_url, signing_secret, return_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime("now")) ON CONFLICT(id) DO NOTHING')->execute([$id, $amount, trim((string) ($input['sponsor_name'] ?? '')), $merchantId, trim((string) ($input['callbackUrl'] ?? '')), trim((string) ($input['callbackSecret'] ?? '')), trim((string) ($input['returnUrl'] ?? '')), 'pending']);
    $stmt = $db->prepare('SELECT id, amount, merchant_id FROM orders WHERE id = ?'); $stmt->execute([$id]); $existing = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$existing) throw new RuntimeException('order_not_stored');
    if (!is_string($existing['merchant_id']) || !hash_equals($existing['merchant_id'], $merchantId)) reply(409, ['ok' => false, 'error' => 'order_merchant_mismatch']);
    if (!hash_equals((string) $existing['amount'], $amount)) reply(409, ['ok' => false, 'error' => 'order_amount_mismatch']);
    $payInput = ['out_trade_no' => $id, 'total_amount' => $amount, 'subject' => trim((string) ($input['subject'] ?? '网站订单')), 'product_code' => 'FAST_INSTANT_TRADE_PAY', 'notify_url' => LIGHTPAY_NOTIFY, 'return_url' => LIGHTPAY_RETURN];
    if ($method === 'scan') { $result = \Yansongda\Pay\Pay::alipay()->scan($payInput); $qr = is_object($result) && method_exists($result, 'get') ? $result->get('qr_code') : ($result->qr_code ?? ''); if (is_string($qr) && $qr !== '') reply(201, ['ok' => true, 'order_id' => $id, 'qr_code' => $qr]); $web = \Yansongda\Pay\Pay::alipay()->web($payInput); $html = is_object($web) && method_exists($web, 'getBody') ? (string) $web->getBody() : (string) $web; if ($html === '') throw new RuntimeException('支付宝未返回支付页面'); reply(201, ['ok' => true, 'order_id' => $id, 'payment_html' => $html]); }
    $web = \Yansongda\Pay\Pay::alipay()->web($payInput); $html = is_object($web) && method_exists($web, 'getBody') ? (string) $web->getBody() : (string) $web; reply(201, ['ok' => true, 'order_id' => $id, 'payment_html' => $html]);
} catch (Throwable $error) { reply(422, ['ok' => false, 'error' => $error->getMessage()]); }
