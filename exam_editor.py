import sys
import os
import json
import re
import hmac
import secrets
import sqlite3
import uuid
import threading
import webbrowser
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler


def get_base_dir():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent
    return Path(__file__).parent


PAGE = r"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>考题编辑</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Microsoft YaHei UI",sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}.app{max-width:960px;margin:0 auto;padding:16px}h1{color:#ff6b6b;font-size:20px;margin-bottom:4px}.sub{color:#888;font-size:12px;margin-bottom:16px}h2{color:#ccc;font-size:15px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #1a1a1a}.panel{background:#111;border:1px solid #1a1a1a;border-radius:8px;padding:14px;margin-bottom:14px}.form-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px}.form-row>div{flex:1;min-width:100px}.form-row label{display:block;font-size:11px;color:#888;margin-bottom:3px}.form-row input,.form-row select{width:100%;padding:7px 9px;background:#0d0d0d;border:1px solid#333;color:#e0e0e0;border-radius:4px;font-size:12px;outline:none;font-family:inherit}.form-row input:focus,.form-row select:focus{border-color:#ff6b6b}.btn{padding:7px 14px;border:none;border-radius:5px;cursor:pointer;font-size:12px;transition:all .2s}.btn-p{background:#ff6b6b;color:#fff}.btn-p:hover{background:#e05555}.btn-i{background:#2980b9;color:#fff}.btn-i:hover{background:#1f6da0}.btn-d{background:#c0392b;color:#fff}.btn-d:hover{background:#962d22}.btn-g{background:#27ae60;color:#fff}.btn-g:hover{background:#1e8449}.btn-s{padding:4px 8px;font-size:11px;margin:0 2px}.q-item{background:#111;border:1px solid#1a1a1a;border-radius:6px;padding:10px 12px;margin-bottom:6px}.q-item .q-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}.q-item .q-type{font-size:10px;padding:2px 8px;border-radius:8px;background:#1a1a1a;color:#888}.q-item .q-text{font-size:13px;margin:4px 0}.q-item .q-opts{font-size:11px;color:#888}.q-item .q-ans{color:#4ecdc4;font-weight:600;font-size:11px}.q-item .q-acts{margin-top:6px;display:flex;gap:4px}.opt-row{display:flex;gap:6px;align-items:center;margin-bottom:3px}.opt-row input[type=text]{flex:1;padding:5px 8px;background:#0d0d0d;border:1px solid#333;color:#e0e0e0;border-radius:3px;font-size:12px;outline:none}.opt-row input[type=text]:focus{border-color:#ff6b6b}.opt-row .ans-label{font-size:10px;color:#888;min-width:28px}.opt-row .del-btn{font-size:10px;padding:2px 6px;background:#c0392b;color:#fff;border:none;border-radius:3px;cursor:pointer}.empty{text-align:center;color:#555;padding:30px;font-size:13px}.toast{position:fixed;top:16px;right:16px;padding:8px 14px;border-radius:6px;font-size:12px;z-index:2000}.toast-ok{background:#27ae60;color:#fff}.toast-err{background:#c0392b;color:#fff}.toast-info{background:#2980b9;color:#fff}.status{font-size:11px;color:#666;margin:8px 0}</style></head><body>
<div class="app"><h1>入站考题编辑器</h1><div class="sub" id="db-status">检测数据库中...</div>

<div class="panel" id="form-panel">
<h2 id="form-title">添加题目</h2>
<input type="hidden" id="edit-id" value="">
<div class="form-row">
<div><label>类型</label><select id="q-type"><option value="single">单选</option><option value="multiple">多选</option><option value="boolean">判断</option></select></div>
<div><label>权重</label><input type="number" id="q-weight" value="1" min="1" max="10"></div>
<div><label>启用</label><select id="q-enabled"><option value="1">是</option><option value="0">否</option></select></div>
</div>
<div class="form-row"><div style="flex:3"><label>题目</label><input type="text" id="q-text" placeholder="题目文字"></div></div>
<div class="form-row"><div style="flex:3"><label>解释(选填)</label><input type="text" id="q-expl" placeholder="答对后的提示"></div></div>
<div id="opts-area"></div>
<div style="margin:6px 0"><button class="btn btn-i btn-s" id="add-opt" style="display:none">+ 添加选项</button></div>
<div style="display:flex;gap:8px;margin-top:10px">
<button class="btn btn-p" id="save-btn">保存题目</button>
<button class="btn btn-d" id="cancel-btn" style="display:none">取消</button>
</div>
</div>

<div class="panel">
<h2>考试配置</h2>
<div class="form-row">
<div><label>通过分数%</label><input type="number" id="cfg-ps" value="60" min="1" max="100"></div>
<div><label>出题数</label><input type="number" id="cfg-qc" value="100" min="1" max="1000"></div>
<div><label>时间限制(秒)</label><input type="number" id="cfg-tl" value="3600" min="60"></div>
<div><label>最多失败次数</label><input type="number" id="cfg-mf" value="3" min="1" max="100"></div>
<div><label>失败冷却(秒)</label><input type="number" id="cfg-fc" value="1800" min="0"></div>
</div>
<div class="form-row">
<div><label>奖励丁尼</label><input type="number" id="cfg-dn" value="50" min="0" max="9999"></div>
<div><label>奖励经验</label><input type="number" id="cfg-xp" value="50" min="0"></div>
<div></div><div></div><div></div>
</div>
<button class="btn btn-g" onclick="saveConfig()">保存配置</button>
</div>

<div class="status"><button class="btn btn-i btn-s" onclick="loadAll()">刷新列表</button></div>
<div id="q-list"></div>
</div>
<script>
var base='/api/questions',editingId=null,optsData=[];
var TOKEN=(function(){var m=location.search.match(/[?&]t=([A-Za-z0-9]+)$/);return m?m[1]:''})();

function toast(m,t){var d=document.createElement('div');d.className='toast toast-'+t;d.textContent=m;document.body.appendChild(d);setTimeout(function(){d.remove()},2000)}

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

function api(m,url,b){
 var o={method:m,headers:{'Content-Type':'application/json','X-Editor-Token':TOKEN}};
 if(b)o.body=JSON.stringify(b);
 return fetch(base+url,o).then(function(r){
  return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'请求失败了');return d})
 })
}

function cancelEdit(){editingId=null;document.getElementById('edit-id').value='';document.getElementById('form-title').textContent='添加题目';document.getElementById('save-btn').textContent='保存题目';document.getElementById('cancel-btn').style.display='none';document.getElementById('q-text').value='';document.getElementById('q-expl').value='';document.getElementById('q-weight').value='1';document.getElementById('q-enabled').value='1';document.getElementById('q-type').value='single';optsData=[];renderOpts()}

function renderOpts(resetData){
 var t=document.getElementById('q-type').value;
 var ct=document.getElementById('opts-area');ct.innerHTML='';
 var ab=document.getElementById('add-opt');
 if(resetData)optsData=[];
 if(t==='boolean'){
  if(!optsData.length||optsData.length!==2)optsData=[{k:'T',t:'正确',c:false},{k:'F',t:'错误',c:false}];
  ab.style.display='none';
  for(var i=0;i<optsData.length;i++)addOptRow(i,true,true);
 }else{
  if(!optsData.length||optsData[0]&&(optsData[0].k==='T'||optsData[0].k==='F')){
   optsData=t==='single'?[{k:'A',t:'',c:false},{k:'B',t:'',c:false},{k:'C',t:'',c:false},{k:'D',t:'',c:false}]:[{k:'A',t:'',c:false},{k:'B',t:'',c:false},{k:'C',t:'',c:false}];
  }
  ab.style.display='inline-block';
  for(var i=0;i<optsData.length;i++)addOptRow(i,false,false);
 }
}

function addOptRow(i,rd,isBool){
 var o=optsData[i];if(!o)return;
 var ct=document.getElementById('opts-area');
 var d=document.createElement('div');d.className='opt-row';
 var checked=o.c?'checked':'';
 d.innerHTML='<input type="text" value="'+(o.t||'').replace(/"/g,'&quot;')+'" placeholder="选项文字" '+(rd?'readonly':'')+'><input type="text" value="'+(o.k||'')+'" style="width:36px;text-align:center;font-size:11px" readonly><span class="ans-label">'+(isBool?'对错?':'答案?')+'</span><input type="checkbox" '+checked+'>';
 if(!rd){
  var db=document.createElement('button');db.className='del-btn';db.textContent='X';
  db.onclick=function(){optsData.splice(i,1);renderOpts()};
  d.appendChild(db);
 }
 ct.appendChild(d);
}

document.getElementById('add-opt').onclick=function(){
 var used={};optsData.forEach(function(o){used[o.k]=1});
 var k='',letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
 for(var i=0;i<26;i++){if(!used[letters[i]]){k=letters[i];break}}
 if(!k)k='X'+optsData.length;
 optsData.push({k:k,t:'',c:false});renderOpts();
};

document.getElementById('q-type').onchange=function(){renderOpts(true)};

document.getElementById('cancel-btn').onclick=cancelEdit;

function collectOpts(){
 var rows=document.querySelectorAll('#opts-area .opt-row');
 var r=[];
 rows.forEach(function(row){
  var t=row.querySelectorAll('input[type=text]')[0].value.trim();
  var k=row.querySelectorAll('input[type=text]')[1].value;
  var c=row.querySelector('input[type=checkbox]').checked;
  if(t)r.push({k:k,t:t,c:c});
 });
 return r;
}

document.getElementById('save-btn').onclick=async function(){
 var body={question:document.getElementById('q-text').value.trim(),type:document.getElementById('q-type').value,weight:parseInt(document.getElementById('q-weight').value)||1,enabled:document.getElementById('q-enabled').value==='1',explanation:document.getElementById('q-expl').value.trim()};
 if(!body.question){toast('请输入题目','err');return}
 var opts=collectOpts();
 var ck=opts.filter(function(o){return o.c}).map(function(o){return o.k});
 if(!ck.length){toast('请选正确答案','err');return}
 body.options=opts.map(function(o){return{key:o.k,text:o.t}});
 body.correctKeys=ck;
 try{
  if(editingId){await api('PUT','/'+editingId,body);toast('已更新','ok')}
  else{await api('POST','',body);toast('已创建','ok')}
  cancelEdit();loadAll();
 }catch(e){toast(e.message,'err')}
};

window.editQ=async function(id){
 try{
  var data=await api('GET','?id='+id);
  if(!data||!data.length){toast('题目不存在','err');return}
  var q=data[0];editingId=q.id;
  document.getElementById('edit-id').value=q.id;
  document.getElementById('form-title').textContent='编辑题目';
  document.getElementById('save-btn').textContent='更新';
  document.getElementById('cancel-btn').style.display='inline-block';
  document.getElementById('q-text').value=q.question||'';
  document.getElementById('q-expl').value=q.explanation||'';
  document.getElementById('q-weight').value=q.weight||1;
  document.getElementById('q-enabled').value=q.enabled?'1':'0';
  document.getElementById('q-type').value=q.type||'single';
  optsData=(q.options||[]).map(function(o){return{k:o.key,t:o.text,c:(q.correctKeys||[]).includes(o.key)}});
  renderOpts();window.scrollTo(0,0);
 }catch(e){toast(e.message,'err')}
};

window.delQ=async function(id){
 if(!confirm('确定删除?'))return;
 try{await api('DELETE','/'+id);toast('已删除','ok');cancelEdit();loadAll()}catch(e){toast(e.message,'err')}
};

async function loadAll(){
 try{
  var data=await api('GET','');
  var list=document.getElementById('q-list');
  if(!data||!data.length){list.innerHTML='<div class="empty">暂无题目</div>';return}
   list.innerHTML=data.map(function(q,i){
    var types={single:'单选',multiple:'多选',boolean:'判断'};
    var corr=esc((q.correctKeys||[]).join(', '));
    var opts=esc((q.options||[]).map(function(o){return o.key+'. '+o.text}).join(' '));
    return'<div class="q-item"><div class="q-head"><span class="q-type">'+esc(types[q.type])+'</span><span style="font-size:10px;color:#888">权重:'+esc(q.weight)+' '+(q.enabled?'启用':'禁用')+'</span></div><div class="q-text">'+(i+1)+'. '+esc(q.question)+'</div><div class="q-opts">选项: '+opts+'</div><div class="q-ans">答案: '+corr+'</div><div class="q-acts"><button class="btn btn-i btn-s" onclick="editQ('+parseInt(q.id,10)+')">编辑</button><button class="btn btn-d btn-s" onclick="delQ('+parseInt(q.id,10)+')">删除</button></div></div>';
   }).join('');
  document.getElementById('db-status').textContent='数据库连接正�?';
 }catch(e){toast('加载失败: '+e.message,'err');document.getElementById('db-status').textContent='错误: '+e.message}
}

window.saveConfig=async function(){
 var body={passScorePercent:parseInt(document.getElementById('cfg-ps').value)||60,questionCount:parseInt(document.getElementById('cfg-qc').value)||100,timeLimitSeconds:parseInt(document.getElementById('cfg-tl').value)||3600,maxFailsBeforeCooldown:parseInt(document.getElementById('cfg-mf').value)||3,failCooldownSeconds:parseInt(document.getElementById('cfg-fc').value)||1800,rewardDenny:parseInt(document.getElementById('cfg-dn').value)||50,rewardExp:parseInt(document.getElementById('cfg-xp').value)||50};
 try{await api('POST','/config',body);toast('配置已保存','info')}catch(e){toast(e.message,'err')}
};

async function loadConfig(){
 try{
 var data=await api('GET','/config');
 document.getElementById('cfg-ps').value=data.passScorePercent||60;
 document.getElementById('cfg-qc').value=data.questionCount||100;
 document.getElementById('cfg-tl').value=data.timeLimitSeconds||3600;
 document.getElementById('cfg-mf').value=data.maxFailsBeforeCooldown||3;
 document.getElementById('cfg-fc').value=data.failCooldownSeconds||1800;
 document.getElementById('cfg-dn').value=data.rewardDenny||50;
 document.getElementById('cfg-xp').value=data.rewardExp||50;
 }catch(e){}
}

renderOpts();loadAll();loadConfig();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    app = None

    def log_message(self, f, *a):
        if self.app and self.app.log:
            self.app.log("[HTTP] " + a[0])

    def _check_token(self):
        """API 门禁：校验 ?t= 查询参数或 X-Editor-Token 头。
        token 由启动器每次启动随机生成（仅监听 127.0.0.1），
        防止本机其它进程/浏览器页面在未获得 token 时直接读改题库。"""
        if not self.app or not getattr(self.app, 'token', None):
            return False
        auth = self.headers.get('X-Editor-Token', '')
        if not auth:
            m = re.search(r'[?&]t=([A-Za-z0-9]+)', self.path)
            if m:
                auth = m.group(1)
        return hmac.compare_digest(str(auth), str(self.app.token))

    def _denied(self):
        self._json({'error': 'token 无效，请使用启动器显示的完整地址访问'}, 403)

    def _json(self, data, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _html(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(PAGE.encode())

    def _body(self):
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n)) if n > 0 else {}

    def _db(self):
        c = sqlite3.connect(self.app.db_path)
        c.row_factory = sqlite3.Row
        return c

    def do_OPTIONS(self):
        # 本机工具页：不开放跨域（去掉原 Access-Control-Allow-Origin:*）
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Editor-Token')
        self.end_headers()

    def _read_question(self, r, cols):
        def g(k):
            if k in cols: return r[k]
            for alt in [k.replace('_',''), k[0].lower()+k[1:], ''.join(w.capitalize() for w in k.split('_')), ''.join(w.capitalize() if i>0 else w for i,w in enumerate(k.split('_')))]:
                if alt in cols: return r[alt]
            return r[k] if k in r.keys() else None
        opts = g('options'); ck = g('correct_keys')
        if isinstance(opts, str): opts = json.loads(opts)
        if isinstance(ck, str): ck = json.loads(ck)
        return {'id': r['id'], 'question': g('question') or '', 'type': g('type') or 'single',
                'options': opts if isinstance(opts, list) else [],
                'correctKeys': ck if isinstance(ck, list) else [],
                'explanation': g('explanation') or '', 'weight': g('weight') or 1,
                'enabled': bool(g('enabled')) if g('enabled') is not None else True}

    def do_GET(self):
        p = self.path.split('?')[0]
        if p in ('/', '/index.html'):
            self._html()
            return
        if not self._check_token():
            self._denied(); return
        if p == '/api/questions/config':
            self._json(self.app._load_config())
        elif p == '/api/questions':
            try:
                c = self._db()
                tb = c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='exam_questions'").fetchone()
                if not tb:
                    c.close(); self._json({'error': '表不存在,请先启动一次绳网服务端'}, 500); return
                cols = [r['name'] for r in c.execute("PRAGMA table_info('exam_questions')")]
                qs = self.path.split('?')[1] if '?' in self.path else ''
                pair = {}
                for x in qs.split('&'):
                    if '=' in x:
                        k, v = x.split('=', 1); pair[k] = v
                qid = pair.get('id')
                if qid:
                    rows = c.execute('SELECT * FROM exam_questions WHERE id=?', (int(qid),)).fetchall()
                else:
                    rows = c.execute('SELECT * FROM exam_questions ORDER BY id').fetchall()
                c.close()
                self._json([self._read_question(r, cols) for r in rows])
            except Exception as e:
                self._json({'error': str(e)}, 500)
        else:
            self._json({'error': 'Not found'}, 404)

    def do_POST(self):
        if not self._check_token():
            self._denied(); return
        p = self.path.split('?')[0]
        if p == '/api/questions/config':
            try:
                self.app._save_config(self._body()); self._json({'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)
        elif p == '/api/questions':
            try:
                b = self._body()
                c = self._db()
                c.execute('INSERT INTO exam_questions(document_id,question,type,options,correct_keys,explanation,weight,enabled) VALUES(?,?,?,?,?,?,?,?)',
                    (str(uuid.uuid4()), b.get('question',''), b.get('type','single'),
                     json.dumps(b.get('options',[]),ensure_ascii=False,separators=(',',':')),
                     json.dumps(b.get('correctKeys',[]),ensure_ascii=False,separators=(',',':')),
                     b.get('explanation',''), b.get('weight',1),
                     1 if b.get('enabled',True) else 0))
                c.commit()
                nid = c.execute('SELECT last_insert_rowid()').fetchone()[0]
                c.close()
                self._json({'id': nid, 'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)
        else:
            self._json({'error': 'Not found'}, 404)

    def do_PUT(self):
        if not self._check_token():
            self._denied(); return
        p = self.path.split('?')[0]
        if p.startswith('/api/questions/') and p != '/api/questions/config':
            try:
                qid = int(p.rsplit('/', 1)[-1])
                b = self._body()
                c = self._db()
                c.execute('UPDATE exam_questions SET question=?,type=?,options=?,correct_keys=?,explanation=?,weight=?,enabled=? WHERE id=?',
                    (b.get('question',''), b.get('type','single'),
                     json.dumps(b.get('options',[]),ensure_ascii=False,separators=(',',':')),
                     json.dumps(b.get('correctKeys',[]),ensure_ascii=False,separators=(',',':')),
                     b.get('explanation',''), b.get('weight',1),
                     1 if b.get('enabled',True) else 0, qid))
                c.commit(); c.close()
                self._json({'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)
        else:
            self._json({'error': 'Not found'}, 404)

    def do_DELETE(self):
        if not self._check_token():
            self._denied(); return
        p = self.path.split('?')[0]
        if p.startswith('/api/questions/') and p != '/api/questions/config':
            try:
                qid = int(p.rsplit('/', 1)[-1])
                c = self._db()
                c.execute('DELETE FROM exam_questions WHERE id=?', (qid,))
                c.commit(); c.close()
                self._json({'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)
        else:
            self._json({'error': 'Not found'}, 404)


class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("考题编辑器 - 绳网")
        self.root.geometry("560x420")
        self.root.minsize(460, 340)
        self.root.configure(bg="#1a1a2e")
        self.srv = None
        self.token = None
        self.port = tk.StringVar(value="8888")
        self.base = get_base_dir()
        self.db_path = str(self.base / "data" / "data.db")

        s = ttk.Style(); s.theme_use("clam")
        s.configure("TFrame", background="#1a1a2e")
        s.configure("TLabel", background="#1a1a2e", foreground="#e0e0e0", font=("Microsoft YaHei UI", 10))
        s.configure("Title.TLabel", background="#1a1a2e", foreground="#ff6b6b", font=("Microsoft YaHei UI", 15, "bold"))
        self._ui()
        self.root.protocol("WM_DELETE_WINDOW", self._close)

    def _ui(self):
        m = ttk.Frame(self.root, padding="14"); m.pack(fill=tk.BOTH, expand=True)
        ttk.Label(m, text="入站考题编辑器", style="Title.TLabel").pack()
        ttk.Label(m, text="直接编辑数据库中的考题", font=("Microsoft YaHei UI", 9), foreground="#888").pack(pady=(0, 10))

        cf = ttk.Frame(m); cf.pack(fill=tk.X)
        ttk.Label(cf, text="端口:").pack(side=tk.LEFT, padx=(0,4))
        e = ttk.Entry(cf, textvariable=self.port, width=7, font=("Consolas", 11)); e.pack(side=tk.LEFT)
        e.bind("<Return>", lambda ev: self._start())
        ttk.Label(cf, text=" 1024-65535", foreground="#888", font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT)

        bf = ttk.Frame(m); bf.pack(fill=tk.X, pady=(8,4))
        self.b1 = ttk.Button(bf, text="启动编辑器", command=self._start); self.b1.pack(side=tk.LEFT, padx=(0,6))
        self.b2 = ttk.Button(bf, text="停止", command=self._stop, state=tk.DISABLED); self.b2.pack(side=tk.LEFT)

        self.sl = ttk.Label(m, text="未启动", foreground="#888"); self.sl.pack(pady=(0,2))
        self.lf = ttk.Frame(m); self.lf.pack(fill=tk.X)
        ttk.Label(self.lf, text="启动后显示访问地址...", foreground="#555", font=("Microsoft YaHei UI", 9)).pack()

        self.out = scrolledtext.ScrolledText(m, wrap=tk.WORD, font=("Consolas", 9), bg="#0d0d1a", fg="#a0a0b0", relief=tk.FLAT, borderwidth=0, padx=6, pady=4, height=8)
        self.out.pack(fill=tk.BOTH, expand=True, pady=(8,0))
        self.out.configure(state=tk.DISABLED)

    def log(self, t):
        self.out.configure(state=tk.NORMAL); self.out.insert(tk.END, t+"\n"); self.out.see(tk.END); self.out.configure(state=tk.DISABLED)

    def _start(self):
        p = self.port.get().strip()
        try:
            v = int(p)
            if v < 1024 or v > 65535: raise ValueError
        except:
            messagebox.showerror("错误", "端口号 1024-65535"); return
        port = int(p)
        if not os.path.isfile(self.db_path):
            messagebox.showerror("错误", "找不到 data/data.db\n请与 ExamEditor.exe 放在同一目录"); return

        self.log("─" * 40)
        self.log("启动题库编辑器 端口:" + str(port))
        self.b1.configure(state=tk.DISABLED); self.b2.configure(state=tk.NORMAL)
        self.sl.configure(text="启动中...", foreground="#f0c040")
        for w in self.lf.winfo_children(): w.destroy()
        ttk.Label(self.lf, text="启动中...", foreground="#f0c040").pack()

        try:
            Handler.app = self
            # 安全整改：仅监听本机回环（原 0.0.0.0 会把题库连同正确答案暴露给局域网/公网）
            self.srv = HTTPServer(('127.0.0.1', port), Handler)
            self.srv.timeout = 1
            # 每次启动生成一次性访问 token（API 门禁，见 Handler._check_token）
            self.token = secrets.token_hex(16)
            threading.Thread(target=self.srv.serve_forever, daemon=True).start()
            url = "http://127.0.0.1:" + str(port) + "/?t=" + self.token
            self.sl.configure(text="运行中", foreground="#4ecdc4")
            for w in self.lf.winfo_children(): w.destroy()
            r = ttk.Frame(self.lf); r.pack()
            ttk.Label(r, text="访问: ", font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT)
            lb = ttk.Label(r, text=url, foreground="#4ecdc4", cursor="hand2", font=("Microsoft YaHei UI", 9, "underline"))
            lb.pack(side=tk.LEFT); lb.bind("<Button-1>", lambda e: webbrowser.open(url))
            self.log("已启动(仅本机): " + url)
            self.log("地址含一次性访问令牌，请勿外传；重启后令牌更换")
        except Exception as e:
            self.log("启动失败: " + str(e)); messagebox.showerror("错误", str(e)); self._rst()

    def _stop(self):
        self.b1.configure(state=tk.DISABLED); self.b2.configure(state=tk.DISABLED)
        self.sl.configure(text="停止中...", foreground="#f0c040")
        self.log("停止中...")
        if self.srv:
            try:
                threading.Thread(target=self.srv.shutdown, daemon=True).start()
                import time
                t0 = time.time()
                while time.time() - t0 < 2:
                    try: self.srv.server_close(); break
                    except: pass
                    time.sleep(0.1)
            except: pass
            self.srv = None
        self.log("已停�?")
        for w in self.lf.winfo_children(): w.destroy()
        ttk.Label(self.lf, text="已停�?", foreground="#888").pack()
        self._rst()

    def _rst(self):
        self.b1.configure(state=tk.NORMAL); self.b2.configure(state=tk.DISABLED)
        self.sl.configure(text="未启动", foreground="#888")

    def _close(self):
        if self.srv:
            if not messagebox.askyesno("确认", "编辑器运行中，确定退出？"): return
        self._stop(); self.root.destroy()

    def _load_config(self):
        cp = os.path.join(os.path.dirname(self.db_path), 'exam_config.json')
        d = {'passScorePercent': 60, 'questionCount': 100, 'timeLimitSeconds': 3600, 'maxFailsBeforeCooldown': 3, 'failCooldownSeconds': 1800, 'rewardDenny': 50, 'rewardExp': 50}
        try:
            if os.path.isfile(cp):
                with open(cp, 'r', encoding='utf-8') as f:
                    s = json.load(f)
                    for k in d: d[k] = s.get(k, d[k])
        except: pass
        return d

    def _save_config(self, data):
        cp = os.path.join(os.path.dirname(self.db_path), 'exam_config.json')
        d = {'passScorePercent': 60, 'questionCount': 100, 'timeLimitSeconds': 3600, 'maxFailsBeforeCooldown': 3, 'failCooldownSeconds': 1800, 'rewardDenny': 50, 'rewardExp': 50}
        for k in d:
            if k in data: d[k] = data[k]
        with open(cp, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    if sys.platform == "win32":
        import ctypes
        try: ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except: pass
    App().run()
