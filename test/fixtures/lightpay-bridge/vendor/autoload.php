<?php
declare(strict_types=1);
namespace Yansongda\Pay;
final class Pay {
    public static function config(array $config): void {}
    public static function alipay(): self { return new self(); }
    public function web(array $input): string { return 'mock-payment-page'; }
}
