require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // /product-info y /suscribir los llama el widget.js desde cualquier
  // tienda instalada (otro dominio) — hace falta responder el preflight
  // OPTIONS o el navegador bloquea el POST antes de que llegue acá.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.urlencoded({ extended: true }));

const {
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  APP_BASE_URL,
  SUPABASE_URL,
  SUPABASE_KEY,
  RESEND_API_KEY,
  EMAIL_FROM = 'Aviso de Stock <onboarding@resend.dev>',
  CRON_KEY = 'cambiar-esta-clave',
  PORT = 3000,
} = process.env;

const USER_AGENT = `AvisoDeStock (${APP_BASE_URL})`;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------
// Sesión de tienda vía cookie firmada. TN no manda el store_id en la
// URL del iframe embebido, así que sin esto cualquiera que entre a
// /admin/:storeId adivinando un número vería datos de OTRA tienda
// (emails anotados). La cookie se firma con TN_CLIENT_SECRET (HMAC) —
// nadie puede fabricarse una para otra tienda sin esa clave.
// ---------------------------------------------------------------------
function firmarStoreId(storeId) {
  const firma = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(storeId).digest('hex');
  return `${storeId}.${firma}`;
}

function leerStoreIdDeCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith('store_session='));
  if (!match) return null;
  const valor = decodeURIComponent(match.slice('store_session='.length));
  const idx = valor.lastIndexOf('.');
  if (idx === -1) return null;
  const storeId = valor.slice(0, idx);
  const firma = valor.slice(idx + 1);
  const esperada = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(storeId).digest('hex');
  if (firma.length !== esperada.length) return null;
  const coincide = crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  return coincide ? storeId : null;
}

function setearCookieSesion(res, storeId) {
  const valor = encodeURIComponent(firmarStoreId(storeId));
  // SameSite=None + Secure porque esto vive dentro de un iframe cross-site
  // (el admin de TiendaNegocio embebe nuestra URL).
  res.setHeader('Set-Cookie', `store_session=${valor}; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Path=/`);
}

// ---------------------------------------------------------------------
// Tiendas instaladas
// ---------------------------------------------------------------------
async function guardarTienda(storeId, accessToken, scope) {
  const { error } = await supabase.from('stock_tiendas').upsert({
    store_id: storeId,
    access_token: accessToken,
    scope,
    instalada_en: new Date().toISOString(),
  });
  if (error) console.error('Error guardando tienda:', error);
}

async function leerTienda(storeId) {
  const { data, error } = await supabase
    .from('stock_tiendas')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) console.error('Error leyendo tienda:', error);
  return data || null;
}

async function listarTiendas() {
  const { data, error } = await supabase.from('stock_tiendas').select('*');
  if (error) {
    console.error('Error listando tiendas:', error);
    return [];
  }
  return data || [];
}

// ---------------------------------------------------------------------
// Cache local de productos (se llena con el cron, la vidriera del
// producto consulta ACÁ, nunca pega directo a la API de TN en cada
// visita — evita el rate limit de 40 req/10seg y es instantáneo).
// ---------------------------------------------------------------------
async function upsertProducto(storeId, producto) {
  const variante = (producto.variants && producto.variants[0]) || {};
  const { error } = await supabase.from('stock_productos').upsert({
    store_id: storeId,
    product_id: producto.id,
    handle: (producto.handle && producto.handle.es) || '',
    nombre: (producto.name && producto.name.es) || '',
    link: producto.product_link || '',
    stock_management: !!variante.stock_management,
    stock: variante.stock,
    actualizado_en: new Date().toISOString(),
  }, { onConflict: 'store_id,product_id' });
  if (error) console.error('Error guardando producto en cache:', error);
}

async function leerProductoPorHandle(storeId, handle) {
  const { data, error } = await supabase
    .from('stock_productos')
    .select('*')
    .eq('store_id', storeId)
    .eq('handle', handle)
    .maybeSingle();
  if (error) console.error('Error leyendo producto:', error);
  return data || null;
}

async function leerProductoPorId(storeId, productId) {
  const { data, error } = await supabase
    .from('stock_productos')
    .select('*')
    .eq('store_id', storeId)
    .eq('product_id', productId)
    .maybeSingle();
  if (error) console.error('Error leyendo producto por id:', error);
  return data || null;
}

// ---------------------------------------------------------------------
// Suscripciones ("avisame cuando vuelva")
// ---------------------------------------------------------------------
async function guardarSuscripcion(storeId, productId, email) {
  // Un mismo email no se anota dos veces al mismo producto.
  const { data: existente } = await supabase
    .from('stock_suscripciones')
    .select('id')
    .eq('store_id', storeId)
    .eq('product_id', productId)
    .ilike('email', email)
    .maybeSingle();
  if (existente) return { yaExistia: true };

  const { error } = await supabase.from('stock_suscripciones').insert({
    store_id: storeId,
    product_id: productId,
    email,
    creado_en: new Date().toISOString(),
  });
  if (error) {
    console.error('Error guardando suscripción:', error);
    return { error: true };
  }
  return { ok: true };
}

async function listarSuscripcionesPorProducto(storeId, productId) {
  const { data, error } = await supabase
    .from('stock_suscripciones')
    .select('*')
    .eq('store_id', storeId)
    .eq('product_id', productId);
  if (error) console.error('Error listando suscripciones:', error);
  return data || [];
}

async function borrarSuscripciones(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from('stock_suscripciones').delete().in('id', ids);
  if (error) console.error('Error borrando suscripciones:', error);
}

async function resumenPorTienda(storeId) {
  // Productos con al menos 1 suscripción pendiente, con la cuenta de
  // cuántos se anotaron. Se arma en JS (no una sola query) para no
  // depender de funciones agregadas específicas de Postgres/Supabase.
  const { data: subs, error } = await supabase
    .from('stock_suscripciones')
    .select('product_id, email')
    .eq('store_id', storeId);
  if (error) {
    console.error('Error armando resumen:', error);
    return [];
  }
  const conteo = {};
  const emailsPorProducto = {};
  (subs || []).forEach((s) => {
    conteo[s.product_id] = (conteo[s.product_id] || 0) + 1;
    if (!emailsPorProducto[s.product_id]) emailsPorProducto[s.product_id] = [];
    emailsPorProducto[s.product_id].push(s.email);
  });
  const productIds = Object.keys(conteo);
  if (productIds.length === 0) return [];

  const { data: productos, error: errProd } = await supabase
    .from('stock_productos')
    .select('*')
    .eq('store_id', storeId)
    .in('product_id', productIds);
  if (errProd) console.error('Error leyendo productos del resumen:', errProd);

  return (productos || []).map((p) => ({
    ...p,
    suscriptores: conteo[p.product_id] || 0,
    emails: emailsPorProducto[p.product_id] || [],
  }));
}

// ---------------------------------------------------------------------
// Email de aviso
// ---------------------------------------------------------------------
async function enviarEmailAviso(email, nombreProducto, link) {
  if (!RESEND_API_KEY) {
    console.error('⚠️ Falta RESEND_API_KEY, no se pudo enviar el email.');
    return;
  }
  try {
    const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background:#0C1712;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0C1712;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#12201B;border-radius:20px;overflow:hidden;">
        <tr><td style="padding:28px 32px 20px;">
          <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:#E8A33D;">hacecrecertutienda.com</p>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <p style="margin:0 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#F1EAD9;">¡Volvió al stock! 🎉</p>
          <p style="margin:0 0 20px;font-size:15px;color:#A9B8AC;line-height:1.5;">${nombreProducto} ya está disponible.</p>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <a href="${link}" style="display:inline-block;background:#E8632C;color:#F1EAD9;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;font-family:Arial,sans-serif;">Comprar ahora</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email],
        subject: `🎉 ${nombreProducto} ya tiene stock`,
        html,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Error enviando email con Resend:', err);
    } else {
      console.log(`📧 Aviso de stock enviado a ${email}`);
    }
  } catch (err) {
    console.error('Error enviando email:', err);
  }
}

// ---------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro code en la URL.');

  try {
    const response = await fetch('https://developers.tiendanegocio.com/v1/oauth/app/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Error al obtener token:', data);
      return res.status(500).send('No se pudo completar la instalación.');
    }

    const { access_token, store_id, scope } = data.data || {};
    if (!access_token || !store_id) {
      console.error('Respuesta inesperada del token endpoint:', data);
      return res.status(500).send('Respuesta inesperada de TiendaNegocio.');
    }

    await guardarTienda(store_id, access_token, scope);
    console.log(`✅ Tienda ${store_id} instaló Aviso de Stock.`);
    setearCookieSesion(res, store_id);
    res.redirect(`/admin/${store_id}`);
  } catch (err) {
    console.error('Error en /callback:', err);
    res.status(500).send('Error interno al procesar la instalación.');
  }
});

app.get('/', (req, res) => {
  res.send('Aviso de Stock backend funcionando ✅');
});

// ---------------------------------------------------------------------
// CRON — recorre todas las tiendas instaladas, trae sus productos de
// la API real, actualiza el cache y dispara los avisos cuando detecta
// que un producto pasó de sin-stock a con-stock.
// Protegido con CRON_KEY para que no lo dispare cualquiera.
// ---------------------------------------------------------------------
app.get('/cron/sync', async (req, res) => {
  if (req.query.key !== CRON_KEY) return res.status(403).json({ error: 'clave inválida' });

  const tiendas = await listarTiendas();
  const resumen = [];

  for (const tienda of tiendas) {
    try {
      let page = 1;
      let sigue = true;
      let productosAPI = [];

      while (sigue) {
        const r = await fetch(`https://developers.tiendanegocio.com/v1/products?page=${page}&per_page=200`, {
          headers: { Authorization: tienda.access_token, 'User-Agent': USER_AGENT, accept: 'application/json' },
        });
        if (!r.ok) {
          console.error(`Error trayendo productos de tienda ${tienda.store_id}:`, r.status);
          break;
        }
        const data = await r.json();
        productosAPI = productosAPI.concat(data.results || []);
        sigue = !!(data.pagination && data.pagination.next_page);
        page += 1;
        if (page > 50) break; // freno de seguridad
      }

      for (const producto of productosAPI) {
        const variante = (producto.variants && producto.variants[0]) || {};
        const stockNuevo = variante.stock;
        const conControl = !!variante.stock_management;

        const anterior = await leerProductoPorId(tienda.store_id, producto.id);
        const teniaSinStock =
          anterior && anterior.stock_management && (anterior.stock === null || Number(anterior.stock) <= 0);
        const volvioAlStock = !!(teniaSinStock && conControl && Number(stockNuevo) > 0);

        await upsertProducto(tienda.store_id, producto);

        if (volvioAlStock) {
          const subs = await listarSuscripcionesPorProducto(tienda.store_id, producto.id);
          for (const s of subs) {
            await enviarEmailAviso(s.email, (producto.name && producto.name.es) || 'tu producto', producto.product_link);
          }
          await borrarSuscripciones(subs.map((s) => s.id));
          resumen.push({ store_id: tienda.store_id, product_id: producto.id, avisados: subs.length });
        }
      }
    } catch (err) {
      console.error(`Error procesando tienda ${tienda.store_id}:`, err);
    }
  }

  res.json({ ok: true, avisos_enviados: resumen });
});

// ---------------------------------------------------------------------
// Script GLOBAL (se pega UNA VEZ en el código personalizado del theme,
// igual que el embed.js de Ruleta — TN no permite código por plantilla
// específica). Corre en todas las páginas, solo actúa si es un producto
// sin stock. Se auto-inserta: busca el botón de comprar/agregar al
// carrito y pone el formulario justo después; si no lo encuentra, cae
// a una tarjeta flotante fija en la esquina (no tapa nada más).
// ---------------------------------------------------------------------
app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(`(function () {
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/widget.js') !== -1) return scripts[i];
    }
    return null;
  })();
  if (!scriptTag) return;

  var params = new URLSearchParams(scriptTag.src.split('?')[1] || '');
  var storeId = params.get('store');
  if (!storeId) return;

  var BASE = '${APP_BASE_URL}';

  var m = window.location.pathname.match(/\\/producto\\/([^\\/?#]+)/);
  if (!m) return; // no es una página de producto, no hacemos nada
  var handle = decodeURIComponent(m[1]);

  function buscarBotonCompra() {
    var candidatos = document.querySelectorAll('button, a, input[type="submit"]');
    var regex = /agregar al carrito|añadir al carrito|comprar ahora|agregar|comprar/i;
    for (var i = 0; i < candidatos.length; i++) {
      var texto = (candidatos[i].textContent || candidatos[i].value || '').trim();
      if (regex.test(texto)) return candidatos[i];
    }
    return null;
  }

  function crearContenedor() {
    var boton = buscarBotonCompra();
    var contenedor = document.createElement('div');
    contenedor.id = 'aviso-stock-widget';

    if (boton && boton.parentNode) {
      contenedor.style.cssText = 'margin-top:12px;font-family:sans-serif;max-width:360px;';
      boton.parentNode.insertBefore(contenedor, boton.nextSibling);
    } else {
      // No encontramos el botón de compra en el theme: tarjeta flotante
      // fija, chica, no tapa el resto de la página.
      contenedor.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;' +
        'background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,0.15);font-family:sans-serif;max-width:300px;';
      document.body.appendChild(contenedor);
    }
    return contenedor;
  }

  function render(contenedor, producto) {
    contenedor.innerHTML =
      '<div>' +
        '<p style="margin:0 0 8px;font-size:0.9rem;color:#555;">Sin stock. Te avisamos por mail cuando vuelva.</p>' +
        '<div style="display:flex;gap:8px;">' +
          '<input id="aviso-stock-email" type="email" placeholder="Tu email" style="flex:1;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:0.9rem;min-width:0;" />' +
          '<button id="aviso-stock-btn" style="background:#E8632C;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600;flex:none;">Avisame</button>' +
        '</div>' +
        '<p id="aviso-stock-msg" style="margin:8px 0 0;font-size:0.85rem;"></p>' +
      '</div>';

    document.getElementById('aviso-stock-btn').addEventListener('click', function () {
      var email = document.getElementById('aviso-stock-email').value.trim();
      var msg = document.getElementById('aviso-stock-msg');
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        msg.textContent = 'Ingresá un email válido.';
        msg.style.color = '#c0392b';
        return;
      }
      fetch(BASE + '/suscribir/' + storeId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: producto.product_id, email: email }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          msg.style.color = '#1b7a3d';
          msg.textContent = data.yaExistia ? 'Ya estabas anotado con este email.' : '¡Listo! Te avisamos por mail apenas vuelva.';
          contenedor.querySelector('div').style.display = 'none';
        })
        .catch(function () {
          msg.style.color = '#c0392b';
          msg.textContent = 'Hubo un error, probá de nuevo.';
        });
    });
  }

  fetch(BASE + '/product-info/' + storeId + '?handle=' + encodeURIComponent(handle))
    .then(function (r) { return r.json(); })
    .then(function (producto) {
      if (!producto || !producto.stock_management) return; // no controla stock, no mostramos nada
      if (producto.stock > 0) return; // hay stock, no mostramos nada
      render(crearContenedor(), producto);
    })
    .catch(function () {});
})();
`);
});

app.get('/product-info/:storeId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'falta handle' });
  const producto = await leerProductoPorHandle(req.params.storeId, handle);
  if (!producto) return res.status(404).json({ error: 'producto no encontrado en cache' });
  res.json(producto);
});

app.post('/suscribir/:storeId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { product_id, email } = req.body;
  if (!product_id || !email) return res.status(400).json({ error: 'faltan datos' });
  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailValido) return res.status(400).json({ error: 'email inválido' });

  const resultado = await guardarSuscripcion(req.params.storeId, product_id, email);
  res.json(resultado);
});

// ---------------------------------------------------------------------
// Panel de administración — lista de productos con gente anotada.
// ---------------------------------------------------------------------
// TN no le agrega el store_id a la URL del iframe cuando la app está
// "integrada al administrador" — llega literal /admin pelado. Sin esta
// ruta, esa entrada del menú lateral tira 404 (Cannot GET /admin).
// Mismo parche que ya usa Ruleta, pero SIN listar todas las tiendas
// (eso filtraba datos entre comerciantes distintos). Usa la cookie de
// sesión seteada en /callback para saber a qué tienda redirigir.
app.get('/admin', async (req, res) => {
  const storeId = leerStoreIdDeCookie(req);
  if (storeId) return res.redirect(`/admin/${storeId}`);
  res.status(401).send('No pudimos identificar tu tienda. Volvé a abrir la app desde el panel de TiendaNegocio (Aplicaciones → Aviso de Stock).');
});

app.get('/admin/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const storeIdSesion = leerStoreIdDeCookie(req);
  if (storeIdSesion !== storeId) {
    return res.status(403).send('No autorizado. Abrí la app desde el panel de TiendaNegocio (Aplicaciones → Aviso de Stock).');
  }
  const tienda = await leerTienda(storeId);
  if (!tienda) return res.status(404).send('Tienda no encontrada o app no instalada.');

  const resumen = await resumenPorTienda(storeId);

  const filas = resumen
    .sort((a, b) => b.suscriptores - a.suscriptores)
    .map((p) => `
      <tr>
        <td>${p.nombre || '(sin nombre)'}</td>
        <td>${p.stock === null || p.stock === undefined ? '—' : p.stock}</td>
        <td><strong>${p.suscriptores}</strong></td>
        <td>${p.link ? `<a href="${p.link}" target="_blank" rel="noopener">Ver</a>` : ''}</td>
      </tr>
      <tr>
        <td colspan="4" class="fila-emails">${(p.emails || []).join(', ')}</td>
      </tr>`)
    .join('') || '<tr><td colspan="4" class="vacio">Todavía nadie se anotó a ningún producto.</td></tr>';

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aviso de Stock — Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#12201B; --bg-card:#1B3026;
    --ink:#F1EAD9; --ink-dim:#A9B8AC;
    --amber:#E8A33D; --coral:#E8632C;
    --border:rgba(241,234,217,0.10);
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ background:var(--bg); color:var(--ink); font-family:'Public Sans', sans-serif; padding:40px 20px 80px; }
  .wrap{ max-width:760px; margin:0 auto; }
  .eyebrow{ font-family:'IBM Plex Mono', monospace; text-transform:uppercase; letter-spacing:0.12em; font-size:0.7rem; color:var(--amber); display:block; margin-bottom:10px; }
  h1{ font-family:'Fraunces', serif; font-weight:600; font-size:1.7rem; margin-bottom:8px; }
  .subtitle{ color:var(--ink-dim); font-size:0.95rem; margin-bottom:28px; max-width:60ch; }
  table{ width:100%; border-collapse:collapse; background:var(--bg-card); border-radius:14px; overflow:hidden; }
  th{ text-align:left; font-family:'IBM Plex Mono', monospace; text-transform:uppercase; font-size:0.7rem; letter-spacing:0.08em; color:var(--ink-dim); padding:14px 16px; border-bottom:1px solid var(--border); }
  td{ padding:14px 16px; border-bottom:1px solid var(--border); font-size:0.92rem; }
  tr:last-child td{ border-bottom:none; }
  a{ color:var(--amber); }
  .vacio{ color:var(--ink-dim); text-align:center; padding:32px 16px; }
  .fila-emails{ color:var(--ink-dim); font-size:0.8rem; font-family:'IBM Plex Mono', monospace; padding-top:0 !important; padding-bottom:16px !important; }
  .install-card{ background:var(--bg-card); border:1px solid var(--border); border-radius:14px; padding:20px 24px; margin-top:28px; }
  .install-text{ color:var(--ink-dim); font-size:0.88rem; line-height:1.6; }
  .install-text code{ background:#0C1712; padding:2px 6px; border-radius:4px; font-family:'IBM Plex Mono', monospace; font-size:0.8rem; color:var(--amber); }
</style>
</head>
<body>
  <div class="wrap">
    <span class="eyebrow">Aviso de Stock · Tienda ${storeId}</span>
    <h1>Productos esperados</h1>
    <p class="subtitle">Gente anotada para que le avisemos cuando vuelva el stock. Se actualiza solo, cada vez que cargues stock en TiendaNegocio.</p>
    <table>
      <thead><tr><th>Producto</th><th>Stock actual</th><th>Anotados</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="install-card">
      <p class="install-text">Pegá esto UNA VEZ en el código personalizado de tu tema (el mismo lugar donde va cualquier script global, antes de <code>&lt;/body&gt;</code>). Se muestra solo en páginas de producto sin stock, no hace falta tocar nada más:<br><br>
      <code>&lt;script src="${APP_BASE_URL}/widget.js?store=${storeId}" defer&gt;&lt;/script&gt;</code></p>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Servidor Aviso de Stock corriendo en puerto ${PORT}`);
});
