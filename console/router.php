<?php
declare(strict_types=1);
require __DIR__.'/api.php';
$host=$_SERVER['HTTP_HOST']??'';
if (!preg_match('/^(127\.0\.0\.1|localhost):[0-9]+$/D',$host)) { http_response_code(403);exit('仅供本机访问'); }
header('X-Content-Type-Options: nosniff');header('Referrer-Policy: same-origin');header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
$path=parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH);
try {
    if (str_starts_with($path,'/api/')) api($path);
    if (preg_match('#^/media/([a-f0-9]{32})$#D',$path,$m)) {
        $q=db()->prepare('SELECT * FROM assets WHERE id=?');$q->execute([$m[1]]);$a=$q->fetch();if(!$a) fail('图片不存在',404);stream_image(DATA.'/uploads/'.$a['filename'],$a['mime']);
    }
    if (preg_match('#^/job-preview/([a-f0-9]{32})$#D',$path,$m)) {
        $q=db()->prepare('SELECT payload FROM jobs WHERE id=?');$q->execute([$m[1]]);$payload=json_decode($q->fetchColumn()?:'{}',true);
        if (!isset($payload['image'])) fail('预览不存在',404);stream_image(ROOT.'/'.$payload['image'],'image/png');
    }
    if ($path==='/') { require __DIR__.'/public/index.php';return true; }
    if (preg_match('#^/assets/[a-zA-Z0-9_.-]+$#D',$path)) {
        $file=__DIR__.'/public'.$path;if (!is_file($file)) fail('资源不存在',404);
        header('Content-Type: '.match(pathinfo($file,PATHINFO_EXTENSION)){'css'=>'text/css','js'=>'application/javascript',default=>'application/octet-stream'});readfile($file);return true;
    }
    fail('页面不存在',404);
} catch (Throwable $e) { error_log((string)$e);header('Content-Type: application/json; charset=utf-8');fail('操作失败，请查看工作区服务日志',500); }
