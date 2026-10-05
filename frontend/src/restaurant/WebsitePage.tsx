import { ExternalLink, Globe, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { GalleryImage, SiteContent } from '../site/types';
import { canManage, useAdmin } from './context';

interface WebsiteData { content: SiteContent; gallery: GalleryImage[] }

type TextKey = Exclude<keyof SiteContent, 'show_menu' | 'show_gallery'>;

const SECTIONS: { title: string; hint?: string; fields: { key: TextKey; label: string; long?: boolean; placeholder?: string; max?: number }[] }[] = [
  {
    title: 'Portada',
    hint: 'Lo primero que ve el cliente. El botón "Ordenar en línea" aparece solo si tienes pedidos en línea activos.',
    fields: [
      { key: 'hero_title', label: 'Título', placeholder: 'Ej. Los mejores tacos de la ciudad', max: 120 },
      { key: 'hero_subtitle', label: 'Subtítulo', long: true, max: 300 },
      { key: 'hero_image_url', label: 'Imagen de portada (URL)', placeholder: 'https://…' },
      { key: 'announcement', label: 'Aviso en la parte superior (opcional)', placeholder: 'Ej. ¡Nueva sucursal en el centro!', max: 200 },
    ],
  },
  {
    title: 'Acerca de',
    fields: [
      { key: 'about_title', label: 'Título', placeholder: 'Nuestra historia', max: 120 },
      { key: 'about_text', label: 'Texto', long: true, max: 3000 },
      { key: 'about_image_url', label: 'Imagen (URL)', placeholder: 'https://…' },
    ],
  },
  {
    title: 'Contacto y redes sociales',
    fields: [
      { key: 'whatsapp', label: 'WhatsApp', placeholder: '656 123 4567', max: 30 },
      { key: 'contact_email', label: 'Correo de contacto', max: 200 },
      { key: 'social_facebook', label: 'Facebook (URL)', placeholder: 'https://facebook.com/…' },
      { key: 'social_instagram', label: 'Instagram (URL)', placeholder: 'https://instagram.com/…' },
      { key: 'social_tiktok', label: 'TikTok (URL)', placeholder: 'https://tiktok.com/@…' },
      { key: 'social_x', label: 'X / Twitter (URL)' },
      { key: 'social_website', label: 'Otro sitio (URL)' },
      { key: 'footer_text', label: 'Texto del pie de página', long: true, max: 500 },
    ],
  },
  {
    title: 'Buscadores (SEO)',
    hint: 'Título y descripción que aparecen en Google y al compartir el enlace.',
    fields: [
      { key: 'seo_title', label: 'Título de la página', max: 70 },
      { key: 'seo_description', label: 'Descripción', long: true, max: 200 },
    ],
  },
];

/**
 * "Sitio web" (modulo landing): contenido de la pagina publica del
 * restaurante, galeria de imagenes y secciones visibles. Logo y colores se
 * toman de la marca del restaurante (Panel NeuronPOS).
 */
export default function WebsitePage() {
  const { me } = useAdmin();
  const enabled = Boolean(me.modules.find((m) => m.code === 'landing')?.enabled);
  const [data, setData] = useState<WebsiteData | null>(null);
  const [form, setForm] = useState<SiteContent>({});
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);
  const [newImage, setNewImage] = useState({ image_url: '', caption: '' });

  const load = useCallback(() => {
    api<WebsiteData>('/website').then((d) => { setData(d); setForm(d.content); }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  if (!canManage(me.user.role)) return <Navigate to="/admin" replace />;
  if (!enabled) return <ModuleLocked name="Sitio web" />;
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setOk('');
    try {
      // Solo se mandan los campos que cambiaron ('' borra el campo).
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) if (data!.content[k as keyof SiteContent] !== v) patch[k] = v;
      for (const k of Object.keys(data!.content)) if (!(k in form)) patch[k] = '';
      if (!Object.keys(patch).length) { setOk('No hay cambios.'); return; }
      const d = await api<WebsiteData>('/website/content', { method: 'PATCH', body: patch });
      setData(d);
      setForm(d.content);
      setOk('Sitio actualizado.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function addImage(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/website/gallery', { method: 'POST', body: { image_url: newImage.image_url, caption: newImage.caption || null } });
      setNewImage({ image_url: '', caption: '' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  async function removeImage(g: GalleryImage) {
    if (!window.confirm('¿Quitar esta imagen de la galería?')) return;
    try { await api(`/website/gallery/${g.id}`, { method: 'DELETE' }); load(); } catch (err) { setError(errorMessage(err)); }
  }

  const siteUrl = `${window.location.origin}/`;
  return (
    <>
      <PageHeader title="Sitio web" subtitle="Contenido de la página pública de tu restaurante."
        actions={<a href={siteUrl} target="_blank" rel="noopener noreferrer"><Button variant="secondary" type="button"><ExternalLink className="h-4 w-4" /> Ver sitio</Button></a>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {ok && <div className="mb-4"><Alert kind="success">{ok}</Alert></div>}
      <form onSubmit={save} className="space-y-6">
        {SECTIONS.map((s) => (
          <Section key={s.title} title={s.title} hint={s.hint}>
            <div className="grid gap-4 sm:grid-cols-2">
              {s.fields.map((f) => (
                <div key={f.key} className={f.long ? 'sm:col-span-2' : ''}>
                  <Field label={f.label}>
                    {f.long ? (
                      <textarea className="input" rows={f.key === 'about_text' ? 6 : 2} maxLength={f.max} placeholder={f.placeholder}
                        value={form[f.key] || ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                    ) : (
                      <input className="input" maxLength={f.max} placeholder={f.placeholder}
                        value={form[f.key] || ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                    )}
                  </Field>
                </div>
              ))}
            </div>
          </Section>
        ))}
        <Section title="Secciones visibles">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-sm text-gray-300">
                <Toggle label="Mostrar menú" checked={form.show_menu !== false} onChange={(v) => setForm({ ...form, show_menu: v })} /> Mostrar el menú (del punto de venta)
              </label>
              <Field label="Título del menú"><input className="input" maxLength={120} placeholder="Nuestro menú" value={form.menu_title || ''} onChange={(e) => setForm({ ...form, menu_title: e.target.value })} /></Field>
            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-sm text-gray-300">
                <Toggle label="Mostrar galería" checked={form.show_gallery !== false} onChange={(v) => setForm({ ...form, show_gallery: v })} /> Mostrar la galería
              </label>
              <Field label="Título de la galería"><input className="input" maxLength={120} placeholder="Galería" value={form.gallery_title || ''} onChange={(e) => setForm({ ...form, gallery_title: e.target.value })} /></Field>
            </div>
          </div>
        </Section>
        <div className="sticky bottom-4 flex justify-end">
          <Button type="submit" loading={saving} className="shadow-xl"><Save className="h-4 w-4" /> Guardar cambios</Button>
        </div>
      </form>

      <div className="mt-8">
        <Section title="Galería" hint="Imágenes por URL (por ahora no se suben archivos).">
          <form onSubmit={addImage} className="mb-4 grid gap-3 sm:grid-cols-[1fr_14rem_auto]">
            <input className="input" required placeholder="https://… imagen" value={newImage.image_url} onChange={(e) => setNewImage({ ...newImage, image_url: e.target.value })} />
            <input className="input" placeholder="Descripción (opcional)" maxLength={200} value={newImage.caption} onChange={(e) => setNewImage({ ...newImage, caption: e.target.value })} />
            <Button type="submit" variant="secondary"><Plus className="h-4 w-4" /> Agregar</Button>
          </form>
          {data.gallery.length === 0 ? <p className="text-sm text-gray-500">La galería está vacía.</p> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {data.gallery.map((g) => (
                <figure key={g.id} className="group relative overflow-hidden rounded-xl border border-gray-800">
                  <img src={g.image_url} alt={g.caption || ''} className="aspect-square w-full object-cover" />
                  {g.caption && <figcaption className="truncate px-2 py-1 text-xs text-gray-400">{g.caption}</figcaption>}
                  <button onClick={() => removeImage(g)} className="absolute right-2 top-2 rounded-lg bg-black/70 p-1.5 text-white hover:bg-red-700" aria-label="Quitar"><Trash2 className="h-4 w-4" /></button>
                </figure>
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="font-semibold text-white">{title}</h2>
      {hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ModuleLocked({ name }: { name: string }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <Lock className="mx-auto mb-3 h-8 w-8 text-gray-500" />
      <h1 className="flex items-center justify-center gap-2 text-lg font-semibold text-white"><Globe className="h-5 w-5" /> {name} no disponible</h1>
      <p className="mt-2 text-sm text-gray-400">Tu restaurante no tiene contratado el módulo "{name}". Comunícate con NeuronPOS para contratarlo.</p>
    </div>
  );
}
