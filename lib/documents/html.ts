import { createDocument } from "@mixmark-io/domino";

export const HTML_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

export function previewHtml(html: string): string {
  const document = createDocument(html);
  document.querySelectorAll("meta[http-equiv],base,iframe,object,embed,link,script[src]").forEach(element => element.remove());
  document.querySelectorAll("a[href]").forEach(element => { if (!element.getAttribute("href")?.startsWith("#")) element.removeAttribute("href"); });
  const policy = document.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'");
  document.head.insertBefore(policy, document.head.firstChild);
  // 内部锚点直接滚动，避免 iframe 发生额外导航。
  // Escape 在 iframe 内也能退出应用全屏；父页面验证发送者后只处理退出事件。
  const bridge = document.createElement("script");
  bridge.textContent = `document.addEventListener('click',function(e){
    var link=e.target.closest&&e.target.closest('a[href^="#"]');
    if(!link)return;
    e.preventDefault();
    var id;try{id=decodeURIComponent(link.getAttribute('href').slice(1));}catch(_){return;}
    var target=document.getElementById(id);
    if(target){target.scrollIntoView({block:'start',behavior:'instant'});target.setAttribute('tabindex','-1');target.focus({preventScroll:true});}
  },true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){parent.postMessage({type:'weave-artifact-escape'},'*');}});
  if(document.documentElement.getAttribute('data-weave-reading')==='1'){
    window.addEventListener('message',function(e){
      if(e.source!==parent||!e.data||e.data.type!=='weave-artifact-theme')return;
      if(e.data.theme==='light'||e.data.theme==='dark')document.documentElement.setAttribute('data-weave-theme',e.data.theme);
    });
    if(parent!==window)parent.postMessage({type:'weave-artifact-ready'},'*');
  }`;
  document.body.appendChild(bridge);
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}
