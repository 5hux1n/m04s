<?php
declare(strict_types=1);
const ROOT = __DIR__ . '/..';
$consoleData = getenv('M04_CONSOLE_STORAGE') ?: ROOT . '/storage/console';
if (!str_starts_with($consoleData, realpath(ROOT).'/') && $consoleData !== ROOT . '/storage/console') {
    throw new RuntimeException('服务数据必须位于工作区');
}
define('DATA', $consoleData);
const MAX_BODY = 20 * 1024 * 1024;

function db(): PDO {
    static $db;
    if (!$db) {
        foreach ([DATA, DATA.'/uploads', DATA.'/renders',DATA.'/imports',DATA.'/tmp'] as $directory) {
            if (!is_dir($directory)) mkdir($directory, 0700, true);
        }
        $db = new PDO('sqlite:'.DATA.'/console.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
        $db->exec('PRAGMA busy_timeout=5000');
        $db->exec(file_get_contents(__DIR__.'/schema.sql'));
    }
    return $db;
}
function token(): string {
    $path = DATA.'/csrf.token';
    db();
    $file = fopen($path, 'c+');
    flock($file, LOCK_EX);
    $value = stream_get_contents($file);
    if (!$value) { $value = bin2hex(random_bytes(32)); fwrite($file, $value); chmod($path, 0600); }
    flock($file, LOCK_UN); fclose($file);
    return $value;
}
function fail(string $message, int $code=400): never { http_response_code($code); echo json_encode(['error'=>$message], JSON_UNESCAPED_UNICODE); exit; }
function respond(mixed $data, int $code=200): never { http_response_code($code); echo json_encode($data, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES); exit; }
function getkv(string $key, mixed $default=null): mixed {
    $q=db()->prepare('SELECT value FROM kv WHERE key=?'); $q->execute([$key]); $v=$q->fetchColumn();
    return $v===false ? $default : json_decode($v,true,512,JSON_THROW_ON_ERROR);
}
function setkv(string $key, mixed $value): void {
    $q=db()->prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    $q->execute([$key,json_encode($value,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)]);
}
function defaults(): array { return ['density'=>'medium','coefficient'=>null,'speed'=>null,'paper'=>null,'copies'=>1,'paperWidth'=>'53']; }
function integer(mixed $value, int $min, int $max, string $name): int {
    if (!is_int($value) || $value<$min || $value>$max) fail("{$name}超出范围"); return $value;
}
function settings(mixed $value): array {
    if (!is_array($value)) fail('设置格式无效');
    $s=array_replace(defaults(), array_intersect_key($value,defaults()));
    if (!in_array($s['density'],['light','medium','dark','special'],true)) fail('浓度无效');
    foreach (['coefficient'=>'浓度系数','speed'=>'实验速度'] as $key=>$name) if ($s[$key]!==null) integer($s[$key],1,255,$name);
    if (!in_array($s['paper'],[null,'continuous','gap','black-mark'],true)) fail('纸张模式无效');
    if (!in_array($s['paperWidth'],['53','80','110','legacy'],true)) fail('纸张宽度无效');
    integer($s['copies'],1,20,'份数'); return $s;
}
function body(): array {
    $size=(int)($_SERVER['CONTENT_LENGTH']??0); if ($size>MAX_BODY) fail('内容超过 20 MB',413);
    $raw=file_get_contents('php://input',false,null,0,MAX_BODY+1);
    if (strlen($raw)>MAX_BODY) fail('内容超过 20 MB',413);
    try { $body=json_decode($raw,true,64,JSON_THROW_ON_ERROR); } catch (JsonException) { fail('无效的 JSON'); }
    if (!is_array($body)) fail('内容格式无效'); return $body;
}
function document(mixed $value): array {
    if (!is_array($value) || !isset($value['blocks']) || !is_array($value['blocks']) || count($value['blocks'])>100) fail('文档格式无效');
    if (strlen(json_encode($value))>12*1024*1024) fail('文档太大');
    foreach ($value['blocks'] as $block) {
        if (!is_array($block) || !in_array($block['type']??null,['text','image','divider','space'],true)) fail('不支持的内容类型');
        if (isset($block['text']) && (!is_string($block['text']) || mb_strlen($block['text'])>20000)) fail('文字内容太长');
        if (($block['type']??null)==='image') {
            $id=$block['asset']??''; if (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/D',$id)) fail('图片引用无效');
            $q=db()->prepare('SELECT id FROM assets WHERE id=?');$q->execute([$id]);if (!$q->fetchColumn()) fail('图片已不存在');
        }
    }
    return $value;
}
function rows(string $sql): array { return db()->query($sql)->fetchAll(); }
function jobs(): array {
    $result=rows('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50');
    foreach ($result as &$job) {
        $payload=json_decode($job['payload'],true); $job['title']=$payload['title']??match($job['kind']){'connect'=>'连接打印机','disconnect'=>'断开打印机','refresh'=>'刷新设备状态','feed'=>'空白走纸','settings'=>'应用设备设置',default=>'打印作品'};
        $job['result']=$job['result'] ? json_decode($job['result'],true):null;
        $job['copies']=$payload['settings']['copies']??1;
        $job['preview']=isset($payload['image']) ? '/job-preview/'.$job['id'] : null;
        unset($job['payload']);
    } return $result;
}
function device(): array {
    $state=getkv('device',['connected'=>false,'phase'=>'尚未连接','values'=>[]]);
    $heartbeat=(float)getkv('heartbeat',0);
    $state['worker_online']=microtime(true)-$heartbeat<8;
    if (!$state['worker_online']) { $state['connected']=false; $state['phase']='打印服务未启动'; }
    return $state;
}
function queue(string $kind, array $payload, ?string $temporary=null): array {
    if (!device()['worker_online']) { if($temporary)unlink($temporary);fail('打印服务未启动，请双击工作区中的 start_console.command',503); }
    $db=db(); $db->exec('BEGIN IMMEDIATE');
    try {
        $count=(int)$db->query("SELECT count(*) FROM jobs WHERE status IN ('queued','running')")->fetchColumn();
        if ($count>=20) { $db->exec('ROLLBACK');if($temporary)unlink($temporary);fail('待处理任务过多，请稍后再试',409); }
        if (in_array($kind,['connect','disconnect','refresh'],true)) {
            $q=$db->prepare("SELECT id FROM jobs WHERE kind=? AND status IN ('queued','running') LIMIT 1");$q->execute([$kind]);
            if ($id=$q->fetchColumn()) { $db->exec('COMMIT'); return ['id'=>$id]; }
        }
        $id=bin2hex(random_bytes(16));
        $q=$db->prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)');
        $q->execute([$id,$kind,json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),microtime(true)]);
        $db->exec('COMMIT'); return ['id'=>$id];
    } catch (Throwable $e) { $db->exec('ROLLBACK');throw $e; }
}
function stream_image(string $path,string $mime): never {
    if (!is_file($path)) fail('图片不存在',404);
    header('Content-Type: '.$mime);header('Content-Length: '.filesize($path));header('Cache-Control: private, max-age=86400'); readfile($path);exit;
}
function import_content(array $arguments): array {
    $python=getenv('M04_PYTHON') ?: (is_executable(ROOT.'/.venv/bin/python3') ? realpath(ROOT.'/.venv/bin/python3') : 'python3');
    $command=array_merge([$python,realpath(ROOT).'/console/import_content.py','--storage',realpath(DATA)],$arguments);
    $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['file',realpath(ROOT).'/logs/console/import.log','a']];
    $process=proc_open($command,$descriptors,$pipes,realpath(ROOT),array_merge(getenv(),['TMPDIR'=>realpath(DATA).'/tmp','PYTHONPYCACHEPREFIX'=>realpath(DATA).'/tmp/pycache']));
    if (!is_resource($process)) fail('无法启动文档导入',500);
    fclose($pipes[0]);$output=stream_get_contents($pipes[1]);fclose($pipes[1]);$code=proc_close($process);
    try {$result=json_decode($output,true,64,JSON_THROW_ON_ERROR);}catch(Throwable){fail('导入失败，请查看工作区导入日志',500);}
    if ($code!==0 || isset($result['error'])) fail($result['error']??'导入失败');
    foreach ($result['assets']??[] as $asset) {
        if (!preg_match('/^[a-f0-9]{32}$/D',$asset['id']) || $asset['filename']!==$asset['id'].'.png') fail('导入图片信息无效',500);
        $q=db()->prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)');$q->execute([$asset['id'],$asset['filename'],$asset['mime'],$asset['width'],$asset['height'],microtime(true)]);
    }
    unset($result['assets']);return $result;
}
function api(string $path): never {
    header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store');
    $method=$_SERVER['REQUEST_METHOD'];
    if ($method!=='GET') {
        if (!hash_equals(token(),$_SERVER['HTTP_X_CONSOLE_TOKEN']??'')) fail('页面校验失效，请刷新重试',403);
        if (isset($_SERVER['HTTP_ORIGIN'])) {
            $origin=parse_url($_SERVER['HTTP_ORIGIN']);
            if (($origin['host']??'').':'.($origin['port']??80)!==$_SERVER['HTTP_HOST']) fail('不接受外部页面请求',403);
        }
    }
    if ($path==='/api/bootstrap' && $method==='GET') respond(['settings'=>getkv('settings',defaults()),'device'=>device(),'jobs'=>jobs(),'documents'=>rows('SELECT id,title,updated_at FROM documents ORDER BY updated_at DESC'),'capabilities'=>['widthDots'=>592,'paperWidths'=>[568,848,1248,592],'dpi'=>300,'maxHeight'=>12000,'speedVerified'=>false]]);
    if ($path==='/api/state' && $method==='GET') respond(['device'=>device(),'jobs'=>jobs()]);
    if ($path==='/api/settings' && $method==='POST') { $s=settings(body());setkv('settings',$s);respond($s); }
    if ($path==='/api/documents' && $method==='GET') respond(rows('SELECT id,title,updated_at FROM documents ORDER BY updated_at DESC'));
    if ($path==='/api/documents' && $method==='POST') {
        $b=body();$content=document($b['content']??null);$title=mb_substr(trim((string)($b['title']??'未命名作品')),0,100)?:'未命名作品';$id=bin2hex(random_bytes(16));
        $q=db()->prepare('INSERT INTO documents VALUES(?,?,?,?)');$q->execute([$id,$title,json_encode($content,JSON_UNESCAPED_UNICODE),microtime(true)]);respond(['id'=>$id,'title'=>$title],201);
    }
    if (preg_match('#^/api/documents/([a-f0-9]{32})$#D',$path,$m)) {
        $q=db()->prepare('SELECT * FROM documents WHERE id=?');$q->execute([$m[1]]);$row=$q->fetch();if (!$row) fail('草稿不存在',404);
        if ($method==='GET') { $row['content']=json_decode($row['content'],true);respond($row); }
        if ($method==='POST') { $b=body();$content=document($b['content']??null);$title=mb_substr(trim((string)($b['title']??'')),0,100)?:'未命名作品';$q=db()->prepare('UPDATE documents SET title=?,content=?,updated_at=? WHERE id=?');$q->execute([$title,json_encode($content,JSON_UNESCAPED_UNICODE),microtime(true),$m[1]]);respond(['id'=>$m[1],'title'=>$title]); }
        if ($method==='DELETE') { $q=db()->prepare('DELETE FROM documents WHERE id=?');$q->execute([$m[1]]);respond(['deleted'=>true]); }
    }
    if ($path==='/api/uploads' && $method==='POST') {
        $f=$_FILES['image']??null;
        if (!$f || $f['error']!==UPLOAD_ERR_OK) fail('请选择 PNG、JPG 或 WebP 图片，最大 10 MB');
        if ($f['size']>10*1024*1024) fail('图片超过 10 MB',413);
        $info=@getimagesize($f['tmp_name']);
        if (!$info || !in_array($info['mime'],['image/png','image/jpeg','image/webp'],true) || $info[0]*$info[1]>32000000) fail('图片格式或尺寸不支持');
        $id=bin2hex(random_bytes(16));$name=$id.'.'.match($info['mime']){'image/png'=>'png','image/jpeg'=>'jpg',default=>'webp'};
        if (!move_uploaded_file($f['tmp_name'],DATA.'/uploads/'.$name)) fail('保存图片失败',500);
        $q=db()->prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)');$q->execute([$id,$name,$info['mime'],$info[0],$info[1],microtime(true)]);
        respond(['id'=>$id,'url'=>'/media/'.$id,'width'=>$info[0],'height'=>$info[1]],201);
    }
    if ($path==='/api/import/web' && $method==='POST') {
        $b=body();$url=$b['url']??'';
        if (!is_string($url) || strlen($url)>2048 || !filter_var($url,FILTER_VALIDATE_URL)) fail('请输入有效的网页地址');
        $arguments=['--url',$url];if (($b['images']??true)===false)$arguments[]='--no-images';
        respond(import_content($arguments),201);
    }
    if ($path==='/api/import/document' && $method==='POST') {
        $f=$_FILES['document']??null;
        if (!$f || $f['error']!==UPLOAD_ERR_OK || $f['size']>10*1024*1024) fail('请选择 PDF、DOCX、DOC 或 TXT，最大 10 MB');
        $extension=strtolower(pathinfo($f['name'],PATHINFO_EXTENSION));
        if (!in_array($extension,['pdf','docx','doc','txt'],true)) fail('文档格式不支持');
        $name=bin2hex(random_bytes(16)).'.'.$extension;$file=DATA.'/imports/'.$name;
        if (!move_uploaded_file($f['tmp_name'],$file)) fail('保存文档失败',500);
        $range=substr((string)($_POST['pages']??''),0,100);
        $result=import_content(['--file',realpath($file),'--kind',$extension,'--pages',$range]);
        $result['title']=mb_substr(pathinfo($f['name'],PATHINFO_FILENAME),0,100);
        respond($result,201);
    }
    if ($path==='/api/device' && $method==='POST') {
        $b=body();$action=$b['action']??'';
        if (!in_array($action,['connect','disconnect','refresh','feed','settings'],true)) fail('操作无效');
        $payload=[];
        if ($action==='feed') { $mm=$b['millimeters']??0;if (!is_numeric($mm) || !is_finite((float)$mm) || $mm<1 || $mm>200) fail('走纸长度应为 1–200 mm');$payload['millimeters']=(float)$mm; }
        if ($action==='settings') {
            $payload['settings']=settings($b['settings']??[]);
            if (array_key_exists('autoOff',$b)) { $v=integer($b['autoOff'],0,1275,'关机时间');if ($v%5) fail('关机时间应为 5 的倍数');$payload['autoOff']=$v; }
        }
        respond(queue($action,$payload),202);
    }
    if ($path==='/api/print' && $method==='POST') {
        $b=body();$s=settings($b['settings']??[]);$png=$b['png']??'';
        if (!is_string($png) || !str_starts_with($png,'data:image/png;base64,')) fail('请生成打印预览');
        $raw=base64_decode(substr($png,22),true); if (!$raw || strlen($raw)>12*1024*1024) fail('预览数据无效');
        $width=integer($b['widthDots']??592,8,1248,'打印宽度');
        if (!in_array($width,[568,848,1248,592],true)) fail('不支持的纸张宽度');
        $info=@getimagesizefromstring($raw);if (!$info || $info['mime']!=='image/png' || $info[0]!==$width || $info[1]<1 || $info[1]>12000) fail('预览点阵尺寸不支持');
        if (!device()['worker_online']) fail('打印服务未启动，请双击工作区中的 start_console.command',503);
        if ((int)db()->query("SELECT count(*) FROM jobs WHERE status IN ('queued','running')")->fetchColumn()>=20) fail('待处理任务过多，请稍后再试',409);
        $id=bin2hex(random_bytes(16));$full=realpath(DATA.'/renders').'/'.$id.'.png';$image=substr($full,strlen(realpath(ROOT))+1);
        if (file_put_contents($full,$raw)===false) fail('保存打印图像失败',500);
        try { $job=queue('print',['image'=>$image,'widthDots'=>$width,'settings'=>$s,'title'=>mb_substr((string)($b['title']??'未命名作品'),0,100)],$full); } catch(Throwable $e) {unlink($full);throw $e;}
        respond($job,202);
    }
    if (preg_match('#^/api/jobs/([a-f0-9]{32})/cancel$#D',$path,$m) && $method==='POST') {
        $q=db()->prepare("UPDATE jobs SET status='cancelled',phase='已取消',finished_at=? WHERE id=? AND status='queued'");$q->execute([microtime(true),$m[1]]);
        if (!$q->rowCount()) fail('任务已经开始，不能取消。请在设备上停止打印',409);respond(['cancelled'=>true]);
    }
    if (preg_match('#^/api/jobs/([a-f0-9]{32})$#D',$path,$m) && $method==='GET') {
        $q=db()->prepare('SELECT event,data,created_at FROM events WHERE job_id=? ORDER BY id DESC LIMIT 100');$q->execute([$m[1]]);$events=$q->fetchAll();foreach($events as &$e)$e['data']=json_decode($e['data'],true);respond(['events'=>array_reverse($events)]);
    }
    fail('接口不存在',404);
}
