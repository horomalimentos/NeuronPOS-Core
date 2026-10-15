// Ventana de "Nuevo pedido": muestra el aviso y suena en bucle.
const q = new URLSearchParams(window.location.search);
document.getElementById('title').textContent = q.get('title') || 'Nuevo pedido';
document.getElementById('body').textContent = q.get('body') || '';
document.getElementById('open').addEventListener('click', () => window.nayoAlert.open());
const tone = document.getElementById('tone');
tone.play().catch(() => {});
