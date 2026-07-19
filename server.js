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
  TRIAL_DIAS = 7,
  MP_PREAPPROVAL_PLAN_ID = 'c2accdd57a7e4f6a8bd5b86b8e3a5206',
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
//
// Guarda una LISTA de tiendas (no una sola): si instalás/abrís más de
// una tienda en el mismo navegador, la cookie anterior pisaba la
// anterior y el panel te mostraba SIEMPRE la última, aunque el iframe
// estuviera embebido en la tienda vieja (TN no manda qué tienda es).
// Con lista, si hay más de una, /admin obliga a elegir en vez de
// adivinar mal.
// ---------------------------------------------------------------------
function firmarLista(valor) {
  const firma = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(valor).digest('hex');
  return `${valor}.${firma}`;
}

function leerTiendasDeCookie(req) {
  const header = req.headers.cookie;
  if (!header) return [];
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith('store_session='));
  if (!match) return [];
  const cookieVal = decodeURIComponent(match.slice('store_session='.length));
  const idx = cookieVal.lastIndexOf('.');
  if (idx === -1) return [];
  const valor = cookieVal.slice(0, idx);
  const firma = cookieVal.slice(idx + 1);
  const esperada = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(valor).digest('hex');
  if (firma.length !== esperada.length) return [];
  const coincide = crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  if (!coincide) return [];
  return valor.split(',').filter(Boolean);
}

function agregarTiendaYSetearCookie(req, res, nuevoStoreId) {
  const actuales = leerTiendasDeCookie(req);
  if (!actuales.includes(String(nuevoStoreId))) actuales.push(String(nuevoStoreId));
  const valor = encodeURIComponent(firmarLista(actuales.join(',')));
  // SameSite=None + Secure porque esto vive dentro de un iframe cross-site
  // (el admin de TiendaNegocio embebe nuestra URL).
  res.setHeader('Set-Cookie', `store_session=${valor}; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Path=/`);
}

// ---------------------------------------------------------------------
// Tiendas instaladas
// ---------------------------------------------------------------------
async function guardarTienda(storeId, accessToken, scope) {
  // Solo se pisa trial_ends_at/pago si la tienda es nueva (primera
  // instalación). Si ya existía (reinstalación), se preservan esos
  // valores para no regalar un trial nuevo cada vez que reinstalan.
  const existente = await leerTienda(storeId);

  const registro = {
    store_id: storeId,
    access_token: accessToken,
    scope,
    instalada_en: new Date().toISOString(),
  };

  if (!existente) {
    const dias = Number(TRIAL_DIAS) || 7;
    registro.trial_ends_at = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
    registro.pago = false;
  }

  const { error } = await supabase.from('stock_tiendas').upsert(registro);
  if (error) console.error('Error guardando tienda:', error);
}

// Acceso pago/trial: "pago" se activa solo, vía webhook de Mercado
// Pago (ver /webhook/mercadopago). Mientras no pague, tiene acceso
// hasta que vence trial_ends_at.
function tieneAccesoActivo(tienda) {
  if (!tienda) return false;
  if (tienda.pago === true) return true;
  if (!tienda.trial_ends_at) return true; // tiendas viejas sin trial cargado: no cortar de golpe
  return new Date(tienda.trial_ends_at).getTime() > Date.now();
}

function diasRestantesTrial(tienda) {
  if (!tienda || !tienda.trial_ends_at) return null;
  const ms = new Date(tienda.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
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

    const { access_token, store_id: storeIdRaw, scope } = data.data || {};
    if (!access_token || !storeIdRaw) {
      console.error('Respuesta inesperada del token endpoint:', data);
      return res.status(500).send('Respuesta inesperada de TiendaNegocio.');
    }
    const store_id = String(storeIdRaw); // TN lo manda como número, no string

    await guardarTienda(store_id, access_token, scope);
    console.log(`✅ Tienda ${store_id} instaló Aviso de Stock.`);
    agregarTiendaYSetearCookie(req, res, store_id);
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
async function sincronizarTodasLasTiendas() {
  const tiendas = await listarTiendas();
  if (tiendas.length === 1) {
    return res.redirect(`/admin/${tiendas[0].store_id}`);
  }
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

  console.log('✅ Sync de stock terminado.', JSON.stringify(resumen));
  return resumen;
}

// El endpoint responde YA (antes de 1seg) y sigue trabajando en
// background. cron-job.org (plan gratis) corta a los 30s como máximo
// y con varias tiendas/productos el recorrido real puede tardar más
// que eso — si el cron espera la respuesta, siempre da timeout aunque
// el sync haya funcionado bien igual del lado del server.
app.get('/cron/sync', (req, res) => {
  if (req.query.key !== CRON_KEY) return res.status(403).json({ error: 'clave inválida' });

  res.json({ ok: true, iniciado: true, nota: 'sync corriendo en background, revisá los logs de Render para el resultado' });

  sincronizarTodasLasTiendas().catch((err) => {
    console.error('Error en sincronizarTodasLasTiendas:', err);
  });
});

// ---------------------------------------------------------------------
// ESTADÍSTICAS — el widget manda un evento 'vista' cada vez que se
// muestra el badge de sin-stock o stock-bajo (fire-and-forget). Las
// conversiones ya se miden con stock_suscripciones.
// ---------------------------------------------------------------------
app.options('/track', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.post('/track', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(204).end();
  const { storeId, tipo } = req.body || {};
  if (!storeId || tipo !== 'vista') return;
  const { error } = await supabase.from('aviso_eventos').insert({ store_id: storeId, tipo });
  if (error) console.error('Error guardando evento:', error);
});

async function contarVistas(storeId) {
  const { count, error } = await supabase
    .from('aviso_eventos').select('*', { count: 'exact', head: true }).eq('store_id', storeId);
  if (error) { console.error('Error contando vistas:', error); return 0; }
  return count || 0;
}

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
  function track(tipo) {
    try {
      fetch(BASE + '/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: storeId, tipo: tipo }), keepalive: true,
      });
    } catch (e) {}
  }

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

  function renderSinStock(contenedor, producto) {
    track('vista');
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

  function renderStockBajo(contenedor, producto) {
    track('vista');
    contenedor.innerHTML =
      '<p style="margin:0;font-size:0.85rem;font-weight:700;color:#B34700;background:#FFF3E6;border:1px solid #FFD8AD;border-radius:8px;padding:8px 12px;display:inline-block;">' +
        '⚠️ ¡Quedan solo ' + producto.stock + ' unidades!' +
      '</p>';
  }

  fetch(BASE + '/product-info/' + storeId + '?handle=' + encodeURIComponent(handle))
    .then(function (r) { return r.json(); })
    .then(function (producto) {
      if (!producto || !producto.stock_management) return; // no controla stock, no mostramos nada
      if (producto.stock <= 0) {
        if (producto.mostrar_sin_stock) renderSinStock(crearContenedor(), producto);
        return;
      }
      if (producto.mostrar_stock_bajo && producto.stock <= producto.umbral_stock_bajo) {
        renderStockBajo(crearContenedor(), producto);
      }
    })
    .catch(function () {});
})();
`);
});

app.get('/product-info/:storeId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'falta handle' });
  const tienda = await leerTienda(req.params.storeId);
  if (!tienda || !tieneAccesoActivo(tienda) || tienda.activo === false) return res.status(403).json({ error: 'app desactivada o trial vencido' });
  const producto = await leerProductoPorHandle(req.params.storeId, handle);
  if (!producto) return res.status(404).json({ error: 'producto no encontrado en cache' });
  res.json({
    ...producto,
    mostrar_sin_stock: tienda.mostrar_sin_stock !== false,
    mostrar_stock_bajo: tienda.mostrar_stock_bajo === true,
    umbral_stock_bajo: tienda.umbral_stock_bajo || 5,
  });
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
//
// Usa la lista de tiendas de la cookie de sesión: si es 1 sola,
// redirige directo (comportamiento de siempre). Si hay MÁS de una en
// el mismo navegador, NUNCA adivina cuál está embebida — TN no lo
// dice — y muestra selector para elegir.
app.get('/admin', async (req, res) => {
  const tiendas = leerTiendasDeCookie(req);

  if (tiendas.length === 0) {
    return res.status(401).send('No pudimos identificar tu tienda. Volvé a abrir la app desde el panel de TiendaNegocio (Aplicaciones → Aviso de Stock).');
  }

  if (tiendas.length === 1) {
    return res.redirect(`/admin/${tiendas[0]}`);
  }

  const filas = tiendas
    .map((id) => `<a class="fila-tienda" href="/admin/${id}">Tienda ${id}</a>`)
    .join('');

  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Aviso de Stock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  body{ font-family:'Space Grotesk', sans-serif; font-weight:500; background:#fdf9f0; color:#111111; padding:40px 20px; }
  h1{ font-family:'Archivo Black', sans-serif; font-weight:400; text-transform:uppercase; font-size:1.5rem; margin-bottom:8px; }
  p{ color:#5b5648; margin-bottom:24px; }
  .fila-tienda{ display:block; padding:16px; margin-bottom:12px; background:#ffffff; border:2px solid #111111; box-shadow:4px 4px 0px 0px #111111; border-radius:14px; color:#111111; text-decoration:none; font-weight:700; transition:transform .12s ease; }
  .fila-tienda:hover{ transform:translate(-2px,-2px); box-shadow:6px 6px 0px 0px #111111; }
</style></head>
<body>
  <h1>🎡 Elegí tu tienda</h1>
  <p>Seleccioná la tienda para ver los productos esperados.</p>
  ${filas}
</body>
</html>`);
});

const APPS_CATALOGO = [
  {
    nombre: 'Ruleta WhatsApp',
    descripcion: 'Ruleta de premios para captar leads y dar cupones a cambio de un giro.',
    icono: '🎡',
  },
  {
    nombre: 'Raspadita',
    descripcion: 'Raspadita de premios para captar leads y dar cupones a cambio de jugar.',
    icono: '🎟️',
  },
  {
    nombre: 'Barra de Envío Gratis',
    descripcion: 'Barra que motiva a sumar productos al carrito para llegar al envío gratis.',
    icono: '🚚',
  },
  {
    nombre: 'Caja Sorpresa',
    descripcion: 'Caja sorpresa de premios para captar leads y dar cupones a cambio de abrirla.',
    icono: '🎁',
  },
  {
    nombre: 'Popup Ventas',
    descripcion: 'Popup de compras recientes para generar confianza en tiempo real.',
    icono: '🛒',
  },
  {
    nombre: 'Popup de Salida',
    descripcion: 'Popup que detecta cuándo el visitante se va y le ofrece un cupón para que no abandone la tienda.',
    icono: '👋',
  },
];

function generarAppsHTML() {
  const cards = APPS_CATALOGO.map((a) => `
      <a class="app-card" href="https://hacecrecertutienda.com" target="_blank" rel="noopener">
        <div class="app-icon">${a.icono}</div>
        <div class="app-info">
          <div class="app-top"><span class="app-name">${a.nombre}</span><span class="app-badge">Activa</span></div>
          <p class="app-desc">${a.descripcion}</p>
        </div>
      </a>`).join('');
  return `
    <div class="section-label">Más herramientas para tu tienda</div>
    <div class="apps-grid">${cards}</div>`;
}

app.post('/admin/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) {
    return res.status(403).send('No autorizado. Abrí la app desde el panel de TiendaNegocio (Aplicaciones → Aviso de Stock).');
  }
  const umbralStockBajo = Math.max(1, Math.min(50, parseInt(req.body.umbral_stock_bajo, 10) || 5));
  const { error } = await supabase.from('stock_tiendas').update({
    activo: req.body.activo === 'on',
    mostrar_sin_stock: req.body.mostrar_sin_stock === 'on',
    mostrar_stock_bajo: req.body.mostrar_stock_bajo === 'on',
    umbral_stock_bajo: umbralStockBajo,
  }).eq('store_id', storeId);
  if (error) console.error('Error actualizando config:', error);
  res.redirect(`/admin/${storeId}`);
});

app.get('/admin/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) {
    return res.status(403).send('No autorizado. Abrí la app desde el panel de TiendaNegocio (Aplicaciones → Aviso de Stock).');
  }
  const tienda = await leerTienda(storeId);
  if (!tienda) return res.status(404).send('Tienda no encontrada o app no instalada.');

  const accesoActivo = tieneAccesoActivo(tienda);
  const diasRestantes = diasRestantesTrial(tienda);
  const linkPago = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${MP_PREAPPROVAL_PLAN_ID}&external_reference=aviso:${storeId}`;

  let bannerTrial = '';
  if (tienda.pago !== true) {
    if (accesoActivo && diasRestantes !== null) {
      bannerTrial = `
        <div class="trial-banner ${diasRestantes <= 2 ? 'trial-banner--urgente' : ''}">
          <span>🕒 Trial: te quedan <strong>${diasRestantes}</strong> día${diasRestantes === 1 ? '' : 's'}.</span>
          <a href="${linkPago}" target="_blank" rel="noopener">Activar plan pago</a>
        </div>`;
    } else if (!accesoActivo) {
      bannerTrial = `
        <div class="trial-banner trial-banner--vencido">
          <span>🔒 Trial vencido. El widget no se muestra en tu tienda hasta que actives el plan pago.</span>
          <a href="${linkPago}" target="_blank" rel="noopener">Activar plan pago</a>
        </div>`;
    }
  }

  const resumen = await resumenPorTienda(storeId);
  const vistas = await contarVistas(storeId);
  const totalSuscriptores = resumen.reduce((acc, p) => acc + (p.suscriptores || 0), 0);
  const ctrAviso = vistas > 0 ? Math.round((totalSuscriptores / vistas) * 100) : 0;
  const statsHTML = `<p class="subtitle">👁️ ${vistas} vista${vistas === 1 ? '' : 's'} · ✉️ ${totalSuscriptores} anotado${totalSuscriptores === 1 ? '' : 's'} · ${ctrAviso}% conversión</p>`;

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
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#fdf9f0; --bg-alt:#f4f0e4; --bg-card:#ffffff;
    --ink:#111111; --ink-dim:#5b5648;
    --pink:#ff3d81; --coral:#ff6b5e; --mint:#3ddc97; --canary:#ffd23f;
    --sh-sm:4px 4px 0px 0px #111111;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ background:var(--bg); color:var(--ink); font-family:'Space Grotesk', sans-serif; font-weight:500; padding:40px 20px 80px; }
  .wrap{ max-width:760px; margin:0 auto; }
  .eyebrow{ font-family:'Space Mono', monospace; text-transform:uppercase; letter-spacing:0.1em; font-size:0.7rem; color:var(--pink); font-weight:700; display:block; margin-bottom:10px; }
  h1{ font-family:'Archivo Black', sans-serif; font-weight:400; text-transform:uppercase; font-size:1.5rem; margin-bottom:8px; }
  .subtitle{ color:var(--ink-dim); font-size:0.95rem; margin-bottom:28px; max-width:60ch; font-weight:500; }
  table{ width:100%; border-collapse:collapse; background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; overflow:hidden; }
  th{ text-align:left; font-family:'Space Mono', monospace; text-transform:uppercase; font-size:0.7rem; letter-spacing:0.06em; color:var(--ink-dim); font-weight:700; padding:14px 16px; border-bottom:2px solid var(--ink); }
  td{ padding:14px 16px; border-bottom:1px solid #e3ddc9; font-size:0.92rem; }
  tr:last-child td{ border-bottom:none; }
  a{ color:var(--pink); font-weight:700; }
  .vacio{ color:var(--ink-dim); text-align:center; padding:32px 16px; }
  .trial-banner{
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    flex-wrap:wrap; margin-bottom:24px; padding:14px 18px; border-radius:14px;
    background:var(--canary); border:2px solid var(--ink); box-shadow:var(--sh-sm);
    font-size:0.9rem; color:var(--ink); font-weight:600;
  }
  .trial-banner--urgente{ background:var(--coral); }
  .trial-banner--vencido{ background:var(--coral); }
  .trial-banner a{
    background:var(--ink); color:var(--bg); text-decoration:none;
    padding:9px 18px; border-radius:999px; font-weight:700; font-size:0.85rem;
    white-space:nowrap; border:2px solid var(--ink);
  }
  .fila-emails{ color:var(--ink-dim); font-size:0.8rem; font-family:'Space Mono', monospace; padding-top:0 !important; padding-bottom:16px !important; }
  .install-card{ background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; padding:20px 24px; margin-top:28px; }
  .install-text{ color:var(--ink-dim); font-size:0.88rem; line-height:1.6; font-weight:500; }
  .install-text code{ background:var(--canary); padding:2px 6px; border-radius:4px; border:1px solid var(--ink); font-family:'Space Mono', monospace; font-size:0.8rem; color:var(--ink); }
  .section-label{ font-family:'Space Mono', monospace; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-dim); margin-top:28px; margin-bottom:12px; }
  .apps-grid{ display:grid; grid-template-columns:1fr; gap:12px; }
  .app-card{
    display:flex; gap:14px; align-items:flex-start;
    background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm);
    border-radius:16px; padding:16px 18px; text-decoration:none; color:var(--ink);
    transition:transform .12s ease, box-shadow .12s ease;
  }
  .app-card:hover{ transform:translate(-2px,-2px); box-shadow:6px 6px 0px 0px var(--ink); }
  .app-icon{ font-size:1.5rem; line-height:1; flex:none; margin-top:2px; }
  .app-info{ flex:1; min-width:0; }
  .app-top{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
  .app-name{ font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:1rem; }
  .app-desc{ color:var(--ink-dim); font-size:0.85rem; line-height:1.4; font-weight:500; }
  .app-badge{
    font-family:'Space Mono', monospace; font-size:0.62rem; text-transform:uppercase;
    letter-spacing:0.06em; padding:3px 9px; border-radius:999px; flex:none;
    border:1.5px solid var(--ink); font-weight:700; background:var(--mint); color:var(--ink);
  }
  .admin-footer{ margin-top:40px; padding-top:24px; border-top:2px solid var(--ink); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; }
  .admin-footer .brand{ font-family:'Space Mono', monospace; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-dim); }
  .admin-footer .brand a{ color:var(--ink); font-weight:700; text-decoration:underline; }
  .admin-footer .soporte{ display:inline-flex; align-items:center; gap:6px; background:var(--mint); color:var(--ink); border:2px solid var(--ink); padding:8px 16px; border-radius:999px; font-weight:700; font-size:0.82rem; box-shadow:var(--sh-sm); text-decoration:none; transition:transform .1s ease; }
  .admin-footer .soporte:hover{ transform:translate(-1px,-1px); }
  .settings-card{ background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; padding:18px 22px; margin-bottom:24px; display:flex; flex-direction:column; align-items:flex-start; gap:14px; }
  .umbral-label{ display:flex; flex-direction:column; gap:6px; font-size:0.85rem; color:var(--ink-dim); font-weight:600; }
  .umbral-label input{ width:100px; background:var(--bg-alt); border:2px solid var(--ink); border-radius:8px; padding:8px 10px; font-size:0.9rem; font-family:'Space Grotesk', sans-serif; font-weight:600; }
  .check-row{ display:flex; align-items:center; gap:10px; }
  .check-row input{ width:auto; }
  .check-row label{ margin:0; font-weight:700; }
  .switch-wrap{
    display:flex; align-items:center; gap:10px; cursor:pointer;
    background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm);
    border-radius:999px; padding:10px 16px 10px 10px; flex:none; width:fit-content;
  }
  .switch-wrap input{ display:none; }
  .switch-track{
    width:40px; height:22px; border-radius:999px; background:#e3ddc9;
    border:2px solid var(--ink);
    position:relative; transition:background .2s ease; flex:none;
  }
  .switch-track::after{
    content:''; position:absolute; top:1px; left:1px;
    width:16px; height:16px; border-radius:50%; background:var(--ink);
    transition:transform .2s ease;
  }
  .switch-wrap input:checked + .switch-track{ background:var(--mint); }
  .switch-wrap input:checked + .switch-track::after{ transform:translateX(18px); }
  .switch-label{ font-size:0.88rem; font-weight:700; white-space:nowrap; }
  button{ margin-top:14px; background:var(--pink); color:var(--ink); border:2px solid var(--ink); padding:10px 20px; border-radius:999px; font-weight:700; cursor:pointer; box-shadow:var(--sh-sm); transition:transform .1s ease, box-shadow .1s ease; font-family:'Space Grotesk', sans-serif; font-size:0.88rem; }
  button:hover{ transform:translate(-1px,-1px); box-shadow:5px 5px 0px 0px var(--ink); }
  button:active{ transform:translate(2px,2px); box-shadow:0px 0px 0px 0px var(--ink); }
</style>
</head>
<body>
  <div class="wrap">
    <span class="eyebrow">Aviso de Stock · Tienda ${storeId}</span>
    <h1>Productos esperados</h1>
    ${bannerTrial}
    <p class="subtitle">Gente anotada para que le avisemos cuando vuelva el stock. Se actualiza solo, cada vez que cargues stock en TiendaNegocio.</p>
    ${statsHTML}
    <form class="settings-card" method="POST" action="/admin/${storeId}">
      <label class="switch-wrap">
        <input type="checkbox" name="activo" ${tienda.activo !== false ? 'checked' : ''} onchange="this.nextElementSibling.nextElementSibling.textContent = this.checked ? 'App activa' : 'App desactivada'" />
        <span class="switch-track"></span>
        <span class="switch-label">${tienda.activo !== false ? 'App activa' : 'App desactivada'}</span>
      </label>

      <label class="switch-wrap">
        <input type="checkbox" name="mostrar_sin_stock" ${tienda.mostrar_sin_stock !== false ? 'checked' : ''} onchange="this.nextElementSibling.nextElementSibling.textContent = this.checked ? 'Avisame cuando vuelva: activo' : 'Avisame cuando vuelva: desactivado'" />
        <span class="switch-track"></span>
        <span class="switch-label">${tienda.mostrar_sin_stock !== false ? 'Avisame cuando vuelva: activo' : 'Avisame cuando vuelva: desactivado'}</span>
      </label>

      <label class="switch-wrap">
        <input type="checkbox" name="mostrar_stock_bajo" ${tienda.mostrar_stock_bajo === true ? 'checked' : ''} onchange="this.nextElementSibling.nextElementSibling.textContent = this.checked ? 'Quedan pocas unidades: activo' : 'Quedan pocas unidades: desactivado'" />
        <span class="switch-track"></span>
        <span class="switch-label">${tienda.mostrar_stock_bajo === true ? 'Quedan pocas unidades: activo' : 'Quedan pocas unidades: desactivado'}</span>
      </label>

      <label class="umbral-label">
        <span>Mostrar "quedan pocas unidades" cuando el stock sea igual o menor a:</span>
        <input type="number" name="umbral_stock_bajo" min="1" max="50" value="${tienda.umbral_stock_bajo || 5}" />
      </label>

      <button type="submit">Guardar</button>
    </form>
    <table>
      <thead><tr><th>Producto</th><th>Stock actual</th><th>Anotados</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="install-card">
      <p class="install-text">Pegá esto UNA VEZ en el código personalizado de tu tema (el mismo lugar donde va cualquier script global, antes de <code>&lt;/body&gt;</code>). Se muestra solo en páginas de producto sin stock, no hace falta tocar nada más:<br><br>
      <code>&lt;script src="${APP_BASE_URL}/widget.js?store=${storeId}" defer&gt;&lt;/script&gt;</code></p>
    </div>
    ${generarAppsHTML()}
    <div class="admin-footer">
      <span class="brand">Una app de <a href="https://hacecrecertutienda.com" target="_blank" rel="noopener">hacecrecertutienda.com</a></span>
      <a class="soporte" href="https://wa.me/5490000000000" target="_blank" rel="noopener">💬 Soporte por WhatsApp</a>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Servidor Aviso de Stock corriendo en puerto ${PORT}`);
});
