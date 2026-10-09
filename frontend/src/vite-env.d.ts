/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Contacto de ventas de la pagina principal (ver src/home/HomePage.tsx).
  readonly VITE_CONTACT_WHATSAPP?: string;
  readonly VITE_CONTACT_EMAIL?: string;
}
