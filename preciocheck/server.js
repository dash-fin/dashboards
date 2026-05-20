const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;

// URLs permitidas
const ALLOWED_DOMAINS = [
  'd3e6htiiul5ek9.cloudfront.net',
  'd735s5r2zljbo.cloudfront.net',
  'preciosclaros.gob.ar',
  'api.preciosclaros.gob.ar' // Aunque no funciona, se deja por si cambia en el futuro
];

// Endpoints API Precios Claros
const PRIMARY_API = 'https://d3e6htiiul5ek9.cloudfront.net/prod';
const FALLBACK_API = 'https://d735s5r2zljbo.cloudfront.net/prod';

async function fetchUrl(targetUrl, retries = 2, useFallback = false) {
  const currentApiUrl = useFallback ? FALLBACK_API : PRIMARY_API;
  const finalUrl = targetUrl.replace(PRIMARY_API, currentApiUrl); // Reemplaza solo si la URL contiene la primaria

  return new Promise((resolve, reject) => {
    const parsed = new URL(finalUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Referer': 'https://www.preciosclaros.gob.ar/',
        'Origin': 'https://www.preciosclaros.gob.ar',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
      },
      timeout: 15000
    };

    const doRequest = (attempt) => {
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              status: res.statusCode,
              body: data,
              headers: res.headers
            });
          } else if (attempt < retries - 1 && !useFallback) { // Si no es un reintento final y no estamos usando fallback
            console.log(`↻ Intento ${attempt + 1}/${retries} falló con ${res.statusCode}. Reintentando con fallback...`);
            fetchUrl(targetUrl, retries, true).then(resolve).catch(reject); // Intentar con fallback
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', (err) => {
        if (attempt < retries - 1 && !useFallback) {
          console.log(`↻ Intento ${attempt + 1}/${retries} falló con error: ${err.message}. Reintentando con fallback...`);
          fetchUrl(targetUrl, retries, true).then(resolve).catch(reject); // Intentar con fallback
        } else if (attempt < retries -1 && useFallback) { // Si ya estamos en fallback y falló, reintentar con fallback
           console.log(`↻ Fallback intento ${attempt + 1}/${retries} falló con error: ${err.message}. Reintentando con fallback...`);
           setTimeout(() => doRequest(attempt + 1), 1000); // Reintento normal
        } else {
          reject(err);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (attempt < retries -1 && !useFallback) {
          console.log(`↻ Timeout, reintentando (${attempt + 1}/${retries})...`);
          fetchUrl(targetUrl, retries, true).then(resolve).catch(reject); // Intentar con fallback
        } else if (attempt < retries -1 && useFallback) { // Si ya estamos en fallback y falló, reintentar con fallback
          console.log(`↻ Timeout en fallback, reintentando (${attempt + 1}/${retries})...`);
          setTimeout(() => doRequest(attempt + 1), 1000); // Reintento normal
        } else {
          reject(new Error('Timeout tras reintentos'));
        }
      });
      req.end();
    };
    doRequest(0);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Servir index.html
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading index.html');
    }
    return;
  }

  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    let targetUrl = parsed.query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falta parámetro url' }));
      return;
    }

    // Validar URL
    const isAllowed = ALLOWED_DOMAINS.some(d => targetUrl.includes(d));
    if (!isAllowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'URL no permitida' }));
      return;
    }

    try {
      console.log(`→ ${targetUrl}`);
      const result = await fetchUrl(targetUrl);
      console.log(`← ${result.status} (${result.body.length} bytes)`);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=300'
      });
      res.end(result.body);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Error al consultar API',
        detail: e.message
      }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`PrecioCheck corriendo en http://0.0.0.0:${PORT}`);
});
