export function getAdminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>WLOC 授权管理</title>
  <style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16202a;background:#f2f5f8;line-height:1.5}
    *{box-sizing:border-box}body{margin:0}.wrap{width:min(1120px,calc(100% - 28px));margin:32px auto 64px}
    h1{font-size:28px;margin:0}.sub{color:#687481;margin:6px 0 24px}.card{background:#fff;border:1px solid #dfe5eb;border-radius:16px;padding:20px;box-shadow:0 8px 30px rgba(25,39,52,.06);margin-bottom:18px}
    .row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.field{display:flex;flex-direction:column;gap:6px;min-width:150px;flex:1}.field.wide{min-width:260px;flex:2}
    label{font-size:13px;color:#56616d}input,select,button{font:inherit;border-radius:10px;border:1px solid #cfd7df;padding:10px 12px;background:#fff;color:#16202a}
    input:focus,select:focus{outline:2px solid #4b8df8;outline-offset:1px}button{cursor:pointer;font-weight:600}button.primary{background:#1769e0;border-color:#1769e0;color:white}button.danger{background:#fff1f1;border-color:#ffc9c9;color:#b42318}button.good{background:#edfff3;border-color:#b6efc9;color:#087a36}button.ghost{background:#f6f8fa}button:disabled{opacity:.55;cursor:not-allowed}
    .toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.toolbar input{min-width:240px}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{padding:6px 9px;font-size:13px}
    .notice{display:none;padding:12px 14px;border-radius:10px;margin:0 0 16px;white-space:pre-wrap;word-break:break-word}.notice.show{display:block}.notice.ok{background:#eafaf0;color:#126734}.notice.error{background:#fff0f0;color:#a31d1d}.notice.info{background:#edf5ff;color:#164f92}
    .table-wrap{overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse;min-width:860px}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid #e8edf1;font-size:14px;vertical-align:top}th{color:#5e6974;font-size:12px;text-transform:uppercase;letter-spacing:.03em}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:700}.badge.active{background:#dcfce7;color:#166534}.badge.disabled{background:#fee2e2;color:#991b1b}.muted{color:#77828d}.hidden{display:none!important}
    .login{max-width:560px;margin:10vh auto}.result{margin-top:14px;padding:14px;background:#f6f8fa;border-radius:12px}.result textarea{width:100%;min-height:90px;resize:vertical;margin:8px 0;border:1px solid #cfd7df;border-radius:10px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .warning{color:#8a5300;background:#fff8df;border:1px solid #f2dda0;padding:10px 12px;border-radius:10px;font-size:13px;margin-top:12px}
    @media (prefers-color-scheme:dark){:root{color:#ecf2f8;background:#101419}.card{background:#171d23;border-color:#2b343d;box-shadow:none}.sub,.muted,label,th{color:#aab4be}input,select,button{background:#10161c;color:#ecf2f8;border-color:#394550}.ghost{background:#202830!important}.result{background:#10161c}td,th{border-color:#2a333c}.warning{background:#3b2e0d;border-color:#64501b;color:#f4d98b}.notice.info{background:#152a42;color:#a8d0ff}}
  </style>
</head>
<body>
  <main class="wrap">
    <section id="loginView" class="login card">
      <h1>WLOC 授权管理</h1>
      <p class="sub">请输入部署时设置的 ADMIN_TOKEN。密钥仅保存在当前浏览器标签页。</p>
      <form id="loginForm" class="row">
        <div class="field wide"><label for="token">管理员密钥</label><input id="token" type="password" autocomplete="current-password" minlength="24" required></div>
        <button class="primary" type="submit">登录</button>
      </form>
    </section>

    <section id="appView" class="hidden">
      <div class="toolbar">
        <div><h1>WLOC 授权管理</h1><p class="sub">创建和控制用户授权</p></div>
        <button id="logout" class="ghost">退出管理</button>
      </div>
      <div id="notice" class="notice"></div>

      <section class="card">
        <h2>创建授权</h2>
        <form id="createForm" class="row">
          <div class="field wide"><label for="label">用户备注</label><input id="label" maxlength="120" placeholder="例如：user-001" required></div>
          <div class="field"><label for="devices">最大设备数</label><input id="devices" type="number" min="1" max="20" value="1" required></div>
          <div class="field"><label for="expires">到期时间（留空为永久）</label><input id="expires" type="datetime-local"></div>
          <button id="createButton" class="primary" type="submit">创建授权</button>
        </form>
        <div id="createResult" class="result hidden">
          <strong>授权已创建</strong>
          <p class="muted">只把下面的模块地址发送给对应用户。</p>
          <textarea id="moduleUrl" readonly></textarea>
          <div class="actions"><button id="copyModule" class="primary" type="button">复制模块地址</button><button id="copyRecord" class="ghost" type="button">复制完整记录</button></div>
          <div class="warning">D1 只保存授权密钥的哈希，页面关闭后无法从数据库恢复明文模块地址。请立即妥善保存。</div>
        </div>
      </section>

      <section class="card">
        <div class="toolbar">
          <h2>授权列表</h2>
          <div class="row"><input id="search" placeholder="搜索备注或授权 ID"><button id="refresh" class="ghost">刷新</button></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>用户</th><th>状态</th><th>设备</th><th>到期时间</th><th>最后使用</th><th>授权 ID</th><th>操作</th></tr></thead>
            <tbody id="licenseRows"></tbody>
          </table>
        </div>
        <p id="empty" class="muted hidden">没有匹配的授权。</p>
      </section>
    </section>
  </main>
  <script>
  (function(){
    'use strict';
    var tokenKey='wloc_admin_token';
    var token=sessionStorage.getItem(tokenKey)||'';
    var licenses=[];
    var lastCreated=null;
    function byId(id){return document.getElementById(id)}
    function notify(message,type){var el=byId('notice');el.textContent=message;el.className='notice show '+(type||'info')}
    function clearNotice(){byId('notice').className='notice';byId('notice').textContent=''}
    function formatTime(value){if(value===null||value===undefined||value==='')return '永久';var date=new Date(Number(value)*1000);return Number.isNaN(date.getTime())?'—':date.toLocaleString()}
    function shortId(value){value=String(value||'');return value.length>18?value.slice(0,8)+'…'+value.slice(-6):value}
    async function api(path,options){
      options=options||{};
      var headers=Object.assign({'Authorization':'Bearer '+token,'Content-Type':'application/json'},options.headers||{});
      var response=await fetch(path,Object.assign({},options,{headers:headers}));
      var text=await response.text();var body;
      try{body=JSON.parse(text)}catch(_error){body={message:text}}
      if(response.status===401){logout();throw new Error('管理员密钥无效，请重新登录')}
      if(!response.ok)throw new Error(body.error||body.message||('请求失败 '+response.status));
      return body;
    }
    function loginView(){byId('loginView').classList.remove('hidden');byId('appView').classList.add('hidden')}
    function appView(){byId('loginView').classList.add('hidden');byId('appView').classList.remove('hidden')}
    function logout(){token='';sessionStorage.removeItem(tokenKey);loginView()}
    function button(text,className,handler){var el=document.createElement('button');el.type='button';el.textContent=text;el.className=className||'ghost';el.addEventListener('click',handler);return el}
    function render(){
      var term=byId('search').value.trim().toLowerCase();
      var rows=byId('licenseRows');rows.textContent='';
      var filtered=licenses.filter(function(item){return !term||String(item.label||'').toLowerCase().includes(term)||String(item.id||'').toLowerCase().includes(term)});
      byId('empty').classList.toggle('hidden',filtered.length!==0);
      filtered.forEach(function(item){
        var tr=document.createElement('tr');
        function cell(text,className){var td=document.createElement('td');td.textContent=text;if(className)td.className=className;tr.appendChild(td);return td}
        cell(item.label||'未命名');
        var status=cell('');var badge=document.createElement('span');badge.textContent=item.status==='active'?'正常':'已停用';badge.className='badge '+item.status;status.appendChild(badge);
        cell(String(item.device_count||0)+' / '+String(item.max_devices||1));
        cell(formatTime(item.expires_at));
        cell(item.last_seen?formatTime(item.last_seen):'从未使用','muted');
        cell(shortId(item.id),'mono');
        var actions=cell('');actions.className='actions';
        if(item.status==='active')actions.appendChild(button('停用','danger',function(){changeStatus(item,'disabled')}));
        else actions.appendChild(button('恢复','good',function(){changeStatus(item,'active')}));
        actions.appendChild(button('重置设备','ghost',function(){resetDevices(item)}));
        actions.appendChild(button('复制 ID','ghost',function(){copyText(item.id,'授权 ID 已复制')}));
        rows.appendChild(tr);
      });
    }
    async function load(){
      clearNotice();
      try{var body=await api('/api/admin/licenses');licenses=body.licenses||[];render()}
      catch(error){notify(error.message,'error');throw error}
    }
    async function changeStatus(item,status){
      var verb=status==='disabled'?'停用':'恢复';
      if(!confirm('确定要'+verb+'“'+(item.label||item.id)+'”吗？'))return;
      try{await api('/api/admin/licenses/'+encodeURIComponent(item.id)+'/status',{method:'POST',body:JSON.stringify({status:status})});notify(verb+'成功','ok');await load()}
      catch(error){notify(error.message,'error')}
    }
    async function resetDevices(item){
      if(!confirm('确定清除“'+(item.label||item.id)+'”的全部设备绑定吗？'))return;
      try{var body=await api('/api/admin/licenses/'+encodeURIComponent(item.id)+'/reset-devices',{method:'POST',body:'{}'});notify('已清除 '+String(body.removed||0)+' 个设备绑定','ok');await load()}
      catch(error){notify(error.message,'error')}
    }
    async function copyText(value,message){
      try{await navigator.clipboard.writeText(value);notify(message,'ok')}
      catch(_error){notify('复制失败，请长按文本手动复制','error')}
    }
    byId('loginForm').addEventListener('submit',async function(event){
      event.preventDefault();token=byId('token').value.trim();sessionStorage.setItem(tokenKey,token);appView();
      try{await load()}catch(_error){}
    });
    byId('logout').addEventListener('click',logout);
    byId('refresh').addEventListener('click',load);
    byId('search').addEventListener('input',render);
    byId('createForm').addEventListener('submit',async function(event){
      event.preventDefault();clearNotice();var buttonEl=byId('createButton');buttonEl.disabled=true;
      var expiresValue=byId('expires').value;var expiresAt=expiresValue?Math.floor(new Date(expiresValue).getTime()/1000):null;
      try{
        lastCreated=await api('/api/admin/licenses',{method:'POST',body:JSON.stringify({label:byId('label').value.trim(),maxDevices:Number(byId('devices').value),expiresAt:expiresAt})});
        byId('moduleUrl').value=lastCreated.moduleUrl;byId('createResult').classList.remove('hidden');notify('授权创建成功，请立即保存模块地址','ok');await load();
      }catch(error){notify(error.message,'error')}finally{buttonEl.disabled=false}
    });
    byId('copyModule').addEventListener('click',function(){copyText(byId('moduleUrl').value,'模块地址已复制')});
    byId('copyRecord').addEventListener('click',function(){if(lastCreated)copyText(JSON.stringify(lastCreated,null,2),'完整授权记录已复制')});
    if(token){appView();load().catch(function(){})}else loginView();
  }());
  </script>
</body>
</html>`;
}
