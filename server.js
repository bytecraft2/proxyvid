'use strict';

const express = require('express');
const { Readable } = require('stream');

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

// Headers globais
app.use((req, res, next) => {
  // Permite qualquer origem (removida a verificação de domínio)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  );

  // Opcional: evita sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.get('/proxy', async (req, res) => {
  const id = req.query.id;
  const filename = req.query.filename || 'video.mp4';
  const type = req.query.type || 'stream';
  const download = type === 'download';

  if (!id) {
    return res.status(400).send('ID não informado');
  }

  const url = download ? 
    `https://zerostorage.net/api/files/download/${id}` : 
    `https://zerostorage.net/api/files/${id}/stream`;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).send('ID inválido');
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

    // Adiciona Content-Disposition para download com nome do arquivo
    if (download) {
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename.replace(/"/g, '\\"') + '"');
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
