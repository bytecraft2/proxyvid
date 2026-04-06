'use strict';

const express = require('express');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// Troque aqui pelo seu domínio real
const ALLOWED_DOMAIN = 'arquivoplay.site';
const ALLOWED_ORIGIN = `https://${ALLOWED_DOMAIN}`;

const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'expires',
]);

function isAllowedRequest(req) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  try {
    if (origin) {
      const originUrl = new URL(origin);
      if (originUrl.hostname === ALLOWED_DOMAIN || originUrl.hostname.endsWith(`.${ALLOWED_DOMAIN}`)) {
        return true;
      }
    }
  } catch {}

  try {
    if (referer) {
      const refererUrl = new URL(referer);
      if (refererUrl.hostname === ALLOWED_DOMAIN || refererUrl.hostname.endsWith(`.${ALLOWED_DOMAIN}`)) {
        return true;
      }
    }
  } catch {}

  return false;
}

// Headers globais
app.use((req, res, next) => {
  // Permite apenas seu site acessar por navegador
  // res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  );

  // Só permite iframe no seu domínio
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors 'self' ${ALLOWED_ORIGIN}`
  );

  // Opcional: evita sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.get('/proxy', async (req, res) => {
  // Bloqueia uso fora do seu domínio
  if (!isAllowedRequest(req)) {
    return res.status(403).send('Acesso não permitido');
  }

  const url = req.query.url;

  if (!url) {
    return res.status(400).send('URL não informada');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).send('URL inválida');
    }
  } catch {
    return res.status(400).send('URL inválida');
  }

  try {
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
      'Connection': 'keep-alive',
    };

    // Repassa Range do navegador
    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    const remoteResponse = await fetch(parsedUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow',
    });

    res.status(remoteResponse.status);

    // Se o servidor remoto não mandar, força suporte a range
    if (!remoteResponse.headers.has('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Repassa só os headers permitidos
    for (const [name, value] of remoteResponse.headers.entries()) {
      if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }

    if (!remoteResponse.body) {
      return res.end();
    }

    const nodeStream = Readable.fromWeb(remoteResponse.body);

    nodeStream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Erro ao buscar vídeo',
          details: err.message,
        });
      } else {
        res.destroy(err);
      }
    });

    nodeStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Erro ao buscar vídeo',
        details: err.message,
      });
    } else {
      res.destroy(err);
    }
  }
});

// Rota simples para teste
app.get('/', (req, res) => {
  res.send('Proxy online');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
