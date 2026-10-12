import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initPwa } from './lib/pwa';
import { captureSlugFromUrl } from './lib/session';
import '@fontsource-variable/archivo/wdth.css';
import './index.css';

captureSlugFromUrl();
initPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
