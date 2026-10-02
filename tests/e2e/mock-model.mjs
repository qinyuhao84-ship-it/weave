// Isolated audit fixture. Never configure this endpoint for a real knowledge vault.
import http from 'node:http';
const analysis = {gist:'审计样本介绍推荐算法和协同过滤。',language:'中文',entities:[],concepts:[{name:'推荐算法',description:'信息过滤方法',evidence:'推荐算法用于预测用户偏好。'},{name:'协同过滤',description:'推荐方法',evidence:'协同过滤分为基于用户与基于物品两类。'}],relations:[],overlaps:[],contradictions:[],gaps:[]};
const draft = {sourceSummary:{title:'审计样本',content:'资料介绍 [[推荐算法]] 和 [[协同过滤]]。'},newPages:[{type:'concept',title:'推荐算法',summary:'预测用户偏好',content:'推荐算法用于预测用户偏好。\n\n关联方法是 [[协同过滤]]。',aliases:['推荐系统'],tags:['算法'],confidence:'high',citations:[{page:null,quote:'推荐算法用于预测用户偏好。'}]},{type:'concept',title:'协同过滤',summary:'推荐方法',content:'协同过滤分为基于用户与基于物品两类。',aliases:[],tags:['算法'],confidence:'high',citations:[{page:null,quote:'协同过滤分为基于用户与基于物品两类。'}]}],updatedPages:[],reviewItems:[]};
http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ok');return;}
  if(req.url==='/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'audit-model',context_length:32768,reasoning_efforts:['low','medium','high']},{id:'audit-fast',context_length:16384,reasoning_efforts:['low','high']}]}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/embeddings') {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:/推荐|协同|recommend/.test(text)?[1,0,0]:[0,1,0]}))}));return;
  }
  if(req.url==='/rerank') {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({results:body.documents.map((text,index)=>({index,relevance_score:/推荐|协同/.test(text)?.9:.1})).sort((a,b)=>b.relevance_score-a.relevance_score)}));return;
  }
  const prompt=body.messages.map(m=>m.content).join('\n');
  let kind='title',text='推荐算法讨论';
  if(body.stream){kind='chat';text='推荐算法用于预测用户偏好。[ID:1]';}
  const htmlMode = body.stream && prompt.includes('# show-me：');
  if(htmlMode) text += '\n<weave-html><!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>推荐算法图解</title><style>body{margin:0;background:#fcfbf9;color:#191714;font:16px/1.8 system-ui}main{padding:24px;max-width:60ch;margin:auto}button{padding:10px 18px;border:1px solid #87612c;border-radius:6px;background:transparent;color:#6b4b20}button:focus-visible{outline:2px solid #87612c}</style></head><body><main><h1>推荐算法，如何理解你？</h1><p>推荐算法用于预测用户偏好。[ID:1]</p><button onclick="document.getElementById(\'detail\').hidden=!document.getElementById(\'detail\').hidden">展开图解</button><p id="detail" hidden>把已有偏好作为线索，找到可能感兴趣的内容。</p></main><script>window.interactiveReady=true;</script></body></html></weave-html>';
  else if(prompt.includes('sourceSummary')){kind='draft';text=JSON.stringify(prompt.includes('AUDIT_APPEND') ? {sourceSummary:{title:'追加审计资料',content:'追加审计资料说明 [[推荐算法]]。'},newPages:[],updatedPages:[{title:'推荐算法',reason:'追加新证据',proposedContent:'',appendContent:'追加证据支持探索比例 27%。',addAliases:[],addTags:[],citations:[{page:999,quote:'追加证据支持探索比例 27%。'}]}],reviewItems:[]} : draft);}
  else if(prompt.includes('contradictions')&&prompt.includes('entities')){kind='analysis';text=JSON.stringify(prompt.includes('AUDIT_APPEND') ? {...analysis,overlaps:[{existing:'推荐算法',incoming:'推荐算法',verdict:'same',reason:'同一概念'}]} : analysis);}
  else if(prompt.includes('noChangeItems')){kind='batch'; const ids=[...new Set([...prompt.matchAll(/\[([0-9A-HJKMNP-TV-Z]{26})\]/g)].map(m=>m[1]))];text=JSON.stringify({summary:'本地审计保持知识不变',edits:[],newPages:[],deletions:[],merges:[],noChangeItems:ids.map(itemId=>({itemId,reason:'按用户要求保持现状'}))});}
  else if(prompt.includes('targetName')){kind='fix';text=JSON.stringify({summary:'补建缺页',newPages:[{targetName:'缺页审计',type:'concept',title:'缺页审计',content:'来自 [[推荐算法]] 的审计初稿。',reason:'被已有词条引用'}],skipped:[]});}
  else if(prompt.includes('findings')){kind='lint';text=JSON.stringify({findings:[]});}
  console.log(JSON.stringify({at:new Date().toISOString(),kind,stream:Boolean(body.stream)}));
  if(body.stream){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(prompt.includes('HTML_WAIT')) await new Promise(r=>setTimeout(r,1800));
    for(const part of text.match(htmlMode ? /[\s\S]{1,40}/gu : /[\s\S]{1,6}/gu)||[]){
      res.write(`data: ${JSON.stringify({id:'audit',object:'chat.completion.chunk',choices:[{index:0,delta:{content:part},finish_reason:null}]})}\n\n`);
      await new Promise(r=>setTimeout(r,htmlMode ? 50 : 100));
    }
    res.end(`data: ${JSON.stringify({id:'audit',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'audit',object:'chat.completion',model:'audit-model',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}));
  }
}).listen(Number(process.env.WEAVE_E2E_MODEL_PORT ?? 3301),'127.0.0.1',()=>console.log('Local test model ready'));
