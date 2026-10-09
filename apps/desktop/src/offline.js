const params = new URLSearchParams(window.location.search);
const target = params.get('url');
document.getElementById('detail').textContent = params.get('error') || '';
const retry = () => { if (target) window.location.href = target; };
document.getElementById('retry').addEventListener('click', retry);
setInterval(retry, 10000);
