"""Import public web articles or local documents into editable console blocks."""
from __future__ import annotations
import argparse
import ipaddress
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import uuid
import zipfile
from urllib.parse import urljoin, urlsplit, urlencode

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'console/vendor'))
from PIL import Image, ImageOps


class Importer:
    def __init__(self,storage):
        self.storage=storage.resolve()
        if not self.storage.is_relative_to(ROOT):raise ValueError('导入文件必须保存在工作区')
        self.assets=[]
        for name in ('uploads','imports','tmp'): (self.storage/name).mkdir(parents=True,exist_ok=True)

    def asset(self,image):
        if image.width*image.height>32000000:raise ValueError('图片超过 3200 万像素')
        image=ImageOps.exif_transpose(image).convert('RGBA')
        white=Image.new('RGBA',image.size,'white');white.alpha_composite(image)
        white.thumbnail((2400,6000),Image.Resampling.LANCZOS)
        identifier=uuid.uuid4().hex;filename=identifier+'.png'
        white.convert('RGB').save(self.storage/'uploads'/filename)
        self.assets.append({'id':identifier,'filename':filename,'mime':'image/png','width':white.width,'height':white.height})
        return {'id':uuid.uuid4().hex,'type':'image','asset':identifier,'width':100,'align':'center','gap':3,'rotation':0,'crop':'original'}

    @staticmethod
    def text(text,size=11,bold=False):
        return {'id':uuid.uuid4().hex,'type':'text','text':text[:20000],'size':size,'bold':bold,'align':'left','font':'sans','lineHeight':1.45,'gap':3,'direction':'horizontal'}

    def fetch(self,url):
        for _ in range(6):
            parts=urlsplit(url)
            if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password:
                raise ValueError('请输入完整的 http 或 https 网页地址')
            host=parts.hostname;port=parts.port or (443 if parts.scheme=='https' else 80)
            if port not in (80,443):raise ValueError('网页地址仅支持标准 http / https 端口')
            addresses=socket.getaddrinfo(host,port,socket.AF_INET,socket.SOCK_STREAM)
            ips=list(dict.fromkeys(item[4][0] for item in addresses))
            # Some local VPNs return 198.18/15 synthetic DNS addresses. Resolve the
            # public destination through HTTPS before pinning, rather than treating
            # that virtual network as the site's actual destination.
            if ips and all(ipaddress.ip_address(ip) in ipaddress.ip_network('198.18.0.0/15') for ip in ips):
                query='https://cloudflare-dns.com/dns-query?'+urlencode({'name':host,'type':'A'})
                resolved=subprocess.run(['/usr/bin/curl','--silent','--show-error','--max-time','8','-H','accept: application/dns-json',query],capture_output=True,text=True,timeout=10)
                try:ips=[answer['data'] for answer in json.loads(resolved.stdout).get('Answer',[]) if answer.get('type')==1]
                except (ValueError,KeyError):raise ValueError('网页域名解析失败，请稍后重试')
            if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
                raise ValueError('请选择可公开访问的网页地址')
            identifier=uuid.uuid4().hex;body=self.storage/'tmp'/(identifier+'.body');headers=self.storage/'tmp'/(identifier+'.headers')
            try:
                # Pin the checked address and follow redirects manually. No ambient proxies.
                result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--compressed','--noproxy','*','--proto','=http,https','--max-time','12','--max-filesize','8388608','--resolve',f'{host}:{port}:{ips[0]}','--user-agent','Mozilla/5.0 M04S-Console','--dump-header',str(headers),'--output',str(body),'--write-out','%{http_code}',url],capture_output=True,text=True,timeout=15)
                if result.returncode:raise ValueError('网页读取失败，请检查链接或稍后重试')
                code=int(result.stdout[-3:]);header=headers.read_text(errors='replace')
                if 300<=code<400:
                    location=re.findall(r'^location:\s*(.+)$',header,re.I|re.M)
                    if not location:raise ValueError('网页跳转地址无效')
                    url=urljoin(url,location[-1].strip());continue
                if not 200<=code<300:raise ValueError(f'网页返回 {code}，可能需要登录或不允许读取')
                data=body.read_bytes()
                if len(data)>8388608:raise ValueError('网页内容过大')
                return data,url
            finally:body.unlink(missing_ok=True);headers.unlink(missing_ok=True)
        raise ValueError('网页跳转次数过多')

    def web(self,url,include_images=True):
        from bs4 import BeautifulSoup
        data,final=self.fetch(url);soup=BeautifulSoup(data,'html.parser')
        title=(soup.title.get_text(' ',strip=True) if soup.title else urlsplit(final).hostname)[:100]
        for node in soup.select('script,style,nav,header,footer,aside,form,noscript,[hidden],[aria-hidden="true"]'):node.decompose()
        article=soup.find('article') or soup.find('main') or soup.body or soup
        blocks=[self.text(title,18,True)];image_count=0;total=0
        for node in article.find_all(['h1','h2','h3','h4','p','li','pre','blockquote','table','img']):
            if node.name!='img' and node.find_parent(['p','li','pre','blockquote','table']):continue
            if node.name=='img':
                if not include_images or image_count>=5:continue
                source=node.get('src') or node.get('data-src')
                if not source or source.startswith('data:'):continue
                try:
                    raw,_=self.fetch(urljoin(final,source))
                    import io
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.width<80 or image.height<40:continue
                        blocks.append(self.asset(image));image_count+=1
                except Exception:continue
            else:
                text=node.get_text(' ' if node.name!='pre' else '\n',strip=True)
                if not text:continue
                total+=len(text)
                if total>60000 or len(blocks)>=95:raise ValueError('网页正文太长，请选择较短文章或上传文档分段打印')
                blocks.append(self.text(text,15 if node.name.startswith('h') else 11,node.name.startswith('h')))
        if len(blocks)==1:
            text=article.get_text('\n',strip=True)
            if not text:raise ValueError('没有可读取的正文。该网页可能需要登录或由脚本加载')
            if len(text)>60000:raise ValueError('网页正文太长')
            blocks.extend(self.text(text[i:i+12000]) for i in range(0,len(text),12000))
        return {'title':title,'blocks':blocks,'sourceUrl':final,'note':'已导入可读取的网页正文，可继续编辑和排版。'}

    def document(self,path,kind,page_range):
        if kind=='pdf':
            import pymupdf as fitz
            with fitz.open(path) as pdf:
                if pdf.needs_pass:raise ValueError('PDF 有密码，请先另存为不加密的 PDF')
                pages=self.page_numbers(page_range,len(pdf))
                result=[]
                for number in pages:
                    page=pdf[number-1];rect=page.rect
                    if rect.is_empty or rect.width<=0 or rect.height<=0:raise ValueError('PDF 页面尺寸无效')
                    scale=min(150/72,2000/rect.width,5000/rect.height)
                    pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
                    image=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
                    result.append({'number':number,'blocks':[self.asset(image)]})
                return {'title':path.stem,'blocks':result[0]['blocks'],'pages':result,'pageCount':len(pdf),'note':f'已导入 {len(result)} 页 PDF，保留原页面版式。'}
        if kind=='docx':
            with zipfile.ZipFile(path) as archive:
                if len(archive.infolist())>5000 or sum(item.file_size for item in archive.infolist())>80000000:raise ValueError('Word 解压后内容过大')
            from docx import Document
            document=Document(path);blocks=[]
            from docx.oxml.ns import qn
            from docx.text.paragraph import Paragraph
            from docx.table import Table
            for child in document.element.body:
                if child.tag==qn('w:p'):
                    paragraph=Paragraph(child,document)
                    if paragraph.text.strip():blocks.append(self.text(paragraph.text,16 if paragraph.style.name.startswith('Heading') else 11,paragraph.style.name.startswith('Heading')))
                    for drawing in child.findall('.//'+qn('a:blip')):
                        rid=drawing.get(qn('r:embed'))
                        if rid and rid in document.part.related_parts:
                            import io
                            with Image.open(io.BytesIO(document.part.related_parts[rid].blob)) as image:blocks.append(self.asset(image))
                elif child.tag==qn('w:tbl'):
                    table=Table(child,document);blocks.append(self.text('\n'.join(' | '.join(cell.text for cell in row.cells) for row in table.rows),10))
            if not blocks:raise ValueError('Word 文档没有可导入的文字或图片')
            if len(blocks)>100:raise ValueError('Word 内容块超过 100，请将文档拆分后上传')
            return {'title':path.stem,'blocks':blocks,'note':'Word 文字与图片已导入，可按纸卷宽度重新排版。复杂版式建议另存为 PDF 上传。'}
        if kind=='doc':
            proc=subprocess.run(['/usr/bin/textutil','-convert','txt','-stdout',str(path)],capture_output=True,timeout=20)
            if proc.returncode:raise ValueError('旧版 Word 读取失败，请另存为 DOCX 或 PDF')
            raw=proc.stdout
        else:raw=path.read_bytes()
        text=None
        for encoding in ('utf-8-sig','utf-16' if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8','gb18030'):
            try:text=raw.decode(encoding);break
            except UnicodeError:continue
        if text is None or '\x00' in text:raise ValueError('无法读取文字编码，请保存为 UTF-8 TXT')
        if len(text)>200000:raise ValueError('文字过长，请分段上传')
        if not text.strip():raise ValueError('文档内容为空')
        return {'title':path.stem,'blocks':[self.text(text[i:i+12000]) for i in range(0,len(text),12000)],'note':'文字已导入，可继续编辑。'}

    @staticmethod
    def page_numbers(value,count):
        if count<1:raise ValueError('PDF 没有页面')
        if not value:
            if count>20:raise ValueError(f'PDF 共 {count} 页，请填写页码范围，每次最多 20 页')
            return list(range(1,count+1))
        selected=set()
        for part in value.replace('，',',').split(','):
            if not re.fullmatch(r'\s*\d+(?:\s*-\s*\d+)?\s*',part):raise ValueError('页码格式示例：1-3,5')
            numbers=[int(n.strip()) for n in part.split('-')];start=numbers[0];end=numbers[-1]
            if not 1<=start<=end<=count:raise ValueError(f'页码应在 1–{count} 以内')
            if end-start>20:raise ValueError('每次最多导入 20 页')
            selected.update(range(start,end+1))
        if len(selected)>20:raise ValueError('每次最多导入 20 页')
        return sorted(selected)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--storage',type=Path,required=True);parser.add_argument('--file',type=Path);parser.add_argument('--kind');parser.add_argument('--pages',default='');parser.add_argument('--url');parser.add_argument('--no-images',action='store_true');args=parser.parse_args()
    importer=Importer(args.storage)
    try:
        if args.url:result=importer.web(args.url,not args.no_images)
        else:
            if not args.file.resolve().is_relative_to(importer.storage/'imports'):raise ValueError('文件位置无效')
            result=importer.document(args.file,args.kind,args.pages)
        result['assets']=importer.assets
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        for asset in importer.assets:(importer.storage/'uploads'/asset['filename']).unlink(missing_ok=True)
        print(json.dumps({'error':str(exc)},ensure_ascii=False));sys.exit(1)

if __name__=='__main__':main()
