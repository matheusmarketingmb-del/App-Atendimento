// Only version metadata loads with the inbox. Full history loads on demand.
(() => {
  const version='0.38.6';
  const revision='meta-ads-20261109';
  const button=document.querySelector('#changelog-button'),label=document.querySelector('#app-version-label');
  if(label)label.textContent='v'+version;
  const dot=document.querySelector('#changelog-unread-dot');
  function syncDot(){try{const id=window.state?.currentUser?.id||document.querySelector('#current-user')?.textContent||'anonymous';if(dot)dot.hidden=localStorage.getItem('mibro-changelog-seen:'+id)===version;}catch{}}
  syncDot();document.addEventListener('DOMContentLoaded',syncDot,{once:true});
  async function load(){
    if(window.MibroChangelog?.open){window.MibroChangelog.open();return;}
    button.disabled=true;
    const script=document.createElement('script');script.src='/js/changelog.js?v='+version+'-'+revision;
    script.onload=()=>{button.disabled=false;button.removeEventListener('click',load);window.MibroChangelog?.open();};
    script.onerror=()=>{button.disabled=false;script.remove();button.title='Não foi possível carregar as novidades. Clique para tentar novamente.';};
    document.head.append(script);
  }
  button?.addEventListener('click',load);
})();
