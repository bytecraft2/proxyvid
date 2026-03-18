'use strict';

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.get('/proxy', async (req, res) => {
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

    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    const remoteResponse = await fetch(parsedUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow',
    });

    res.status(remoteResponse.status);

    if (!remoteResponse.headers.has('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    for (const [name, value] of remoteResponse.headers.entries()) {
      if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }

    if (!remoteResponse.body) {
      return res.end();
    }

    const { Readable } = require('stream');
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});