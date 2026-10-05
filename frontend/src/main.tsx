import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { captureSlugFromUrl } from './lib/session';
import './index.css';

captureSlugFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
