import {
  Facebook, Globe, Instagram, Loader2, Mail, MessageCircle, Music2, ShoppingBag, Twitter, UtensilsCrossed,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import BranchCards from './BranchCards';
import { setSeo, useSiteCtx } from './context';
import type { LandingData } from './types';

/**
 * Pagina publica del restaurante (modulo "Sitio web"): portada, acerca de,
 * menu de muestra (del menu del POS, solo lectura), galeria, sucursales con
 * horario y redes. El contenido lo edita el restaurante en Admin > Sitio web.
 */
export default function LandingPage() {
  const { site } = useSiteCtx();
  const [data, setData] = useState<LandingData | null>(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    portalApi<LandingData>('/public/landing', { noRedirect: true })
      .then((d) => {
        setData(d);
        setSeo(site.seo.title, site.seo.description, d.content.hero_image_url || d.restaurant.logo_url);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [site.seo.title, site.seo.description]);

  if (error) return <p className="px-6 py-24 text-center text-gray-500">{error}</p>;
  if (!data) return <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  const c = data.content;
  const name = data.restaurant.name;
  const activeCat = data.menu.find((m) => m.id === category) || data.menu[0];
  const socials = [
    { url: c.social_facebook, label: 'Facebook', Icon: Facebook },
    { url: c.social_instagram, label: 'Instagram', Icon: Instagram },
    { url: c.social_tiktok, label: 'TikTok', Icon: Music2 },
    { url: c.social_x, label: 'X', Icon: Twitter },
    { url: c.social_website, label: 'Sitio web', Icon: Globe },
    { url: c.whatsapp ? `https://wa.me/${c.whatsapp.replace(/\D/g, '')}` : undefined, label: 'WhatsApp', Icon: MessageCircle },
    { url: c.contact_email ? `mailto:${c.contact_email}` : undefined, label: c.contact_email || 'Correo', Icon: Mail },
  ].filter((s) => s.url);

  return (
    <>
      {c.announcement && <div className="bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white">{c.announcement}</div>}

      {/* Portada */}
      <section className="relative overflow-hidden bg-brand-secondary text-white">
        {c.hero_image_url && (
          <img src={c.hero_image_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/30 to-transparent" />
        <div className="relative mx-auto flex min-h-[26rem] max-w-6xl flex-col justify-center px-4 py-20 sm:min-h-[32rem]">
          {data.restaurant.logo_url && <img src={data.restaurant.logo_url} alt="" className="mb-6 h-16 w-auto self-start object-contain" />}
          <h1 className="max-w-2xl text-4xl font-extrabold leading-tight sm:text-6xl">{c.hero_title || name}</h1>
          {c.hero_subtitle && <p className="mt-4 max-w-xl text-lg text-white/85 sm:text-xl">{c.hero_subtitle}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            {data.ordering && (
              <Link to="/pedir" className="btn-brand px-7 py-3.5 text-base"><ShoppingBag className="h-5 w-5" /> Ordenar en línea</Link>
            )}
            {data.menu.length > 0 && (
              <a href="#menu" className="inline-flex items-center gap-2 rounded-full border-2 border-white/80 px-7 py-3 text-base font-semibold text-white transition hover:bg-white/10">
                <UtensilsCrossed className="h-5 w-5" /> Ver el menú
              </a>
            )}
          </div>
        </div>
        <div className="h-1.5 bg-brand" />
      </section>

      {/* Acerca de */}
      {(c.about_text || c.about_title) && (
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold text-gray-900">{c.about_title || `Sobre ${name}`}</h2>
            <div className="mt-2 h-1 w-16 rounded bg-brand" />
            {c.about_text && <p className="mt-5 whitespace-pre-line leading-relaxed text-gray-600">{c.about_text}</p>}
          </div>
          {c.about_image_url && <img src={c.about_image_url} alt="" className="aspect-[4/3] w-full rounded-3xl object-cover shadow-lg" />}
        </section>
      )}

      {/* Menu de muestra */}
      {data.menu.length > 0 && activeCat && (
        <section id="menu" className="scroll-mt-20 bg-white py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-center text-3xl font-bold text-gray-900">{c.menu_title || 'Nuestro menú'}</h2>
            <div className="mx-auto mt-2 h-1 w-16 rounded bg-brand" />
            <div className="mt-8 flex gap-2 overflow-x-auto pb-2 sm:justify-center">
              {data.menu.map((cat) => (
                <button key={cat.id} onClick={() => setCategory(cat.id)}
                  className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition
                    ${cat.id === activeCat.id ? 'bg-brand text-brand-contrast' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                  {cat.name}
                </button>
              ))}
            </div>
            {activeCat.description && <p className="mt-4 text-center text-gray-500">{activeCat.description}</p>}
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {activeCat.items.map((it) => (
                <article key={it.id} className="card-light flex overflow-hidden">
                  {it.image_url && <img src={it.image_url} alt="" className="h-auto w-28 flex-shrink-0 object-cover" loading="lazy" />}
                  <div className="flex min-w-0 flex-1 flex-col p-4">
                    <h3 className="font-semibold text-gray-900">{it.name}</h3>
                    {it.description && <p className="mt-1 line-clamp-3 text-sm text-gray-500">{it.description}</p>}
                    <span className="mt-auto pt-2 font-bold text-brand">{formatMXN(it.price)}</span>
                  </div>
                </article>
              ))}
            </div>
            {data.ordering && (
              <div className="mt-10 text-center">
                <Link to="/pedir" className="btn-brand px-7 py-3"><ShoppingBag className="h-5 w-5" /> Ordenar en línea</Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Galeria */}
      {data.gallery.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-center text-3xl font-bold text-gray-900">{c.gallery_title || 'Galería'}</h2>
          <div className="mx-auto mt-2 h-1 w-16 rounded bg-brand" />
          <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
            {data.gallery.map((g) => (
              <figure key={g.id} className="group relative overflow-hidden rounded-2xl">
                <img src={g.image_url} alt={g.caption || ''} className="aspect-square w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy" />
                {g.caption && <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-3 text-sm font-medium text-white">{g.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {/* Sucursales */}
      {data.branches.length > 0 && (
        <section id="sucursales" className="scroll-mt-20 bg-white py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-center text-3xl font-bold text-gray-900">{data.branches.length > 1 ? 'Sucursales' : 'Visítanos'}</h2>
            <div className="mx-auto mt-2 h-1 w-16 rounded bg-brand" />
            <div className="mt-8"><BranchCards branches={data.branches} /></div>
          </div>
        </section>
      )}

      {/* Redes y pie */}
      {(socials.length > 0 || c.footer_text) && (
        <section className="bg-brand-secondary py-12 text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 text-center">
            {socials.length > 0 && (
              <div className="flex flex-wrap justify-center gap-3">
                {socials.map(({ url, label, Icon }) => (
                  <a key={label} href={url} target="_blank" rel="noopener noreferrer" aria-label={label}
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 transition hover:border-brand hover:bg-brand">
                    <Icon className="h-5 w-5" />
                  </a>
                ))}
              </div>
            )}
            {c.footer_text && <p className="max-w-2xl whitespace-pre-line text-sm text-white/70">{c.footer_text}</p>}
          </div>
        </section>
      )}
    </>
  );
}
