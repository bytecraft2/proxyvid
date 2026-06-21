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
  // Permite qualquer origem
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition'
  );

  // Evita sniffing e caching de respostas de erro
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
    `https://test.zerostorage.net/api/files/download/${id}?track=true` : 
    `https://test.zerostorage.net/api/files/${id}/stream`;
  
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

    // Verifica se a resposta é válida
    if (!remoteResponse.ok && remoteResponse.status !== 206) {
      console.error(`Erro do servidor remoto: ${remoteResponse.status}`);
      return res.status(remoteResponse.status).json({
        error: 'Erro ao buscar arquivo no servidor remoto',
        status: remoteResponse.status
      });
    }

    // Configura os headers antes de qualquer streaming
    // Importante: definir o status primeiro
    res.status(remoteResponse.status);

    // Força accept-ranges se não vier do remoto
    if (!remoteResponse.headers.has('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Repassa apenas headers permitidos
    let contentLength = null;
    for (const [name, value] of remoteResponse.headers.entries()) {
      const lowerName = name.toLowerCase();
      if (ALLOWED_RESPONSE_HEADERS.has(lowerName)) {
        // Guarda content-length para verificação depois
        if (lowerName === 'content-length') {
          contentLength = parseInt(value, 10);
        }
        res.setHeader(name, value);
      }
    }

    // Adiciona Content-Disposition para download
    if (download) {
      // Sanitiza o nome do arquivo
      const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    }

    // Se for uma resposta HEAD ou não tiver corpo
    if (remoteResponse.status === 204 || remoteResponse.status === 304) {
      return res.end();
    }

    // Verifica se há corpo na resposta
    if (!remoteResponse.body) {
      console.warn('Resposta sem corpo recebida');
      return res.end();
    }

    // Cria o stream a partir da resposta remota
    const nodeStream = Readable.fromWeb(remoteResponse.body);

    // Adiciona timeout para evitar conexões pendentes
    req.setTimeout(30000);
    res.setTimeout(30000);

    // Handler de erro do stream
    nodeStream.on('error', (err) => {
      console.error('Erro no stream:', err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Erro ao transmitir vídeo',
          details: err.message,
        });
      } else {
        // Se já enviou headers, apenas finaliza a conexão
        res.end();
      }
    });

    // Monitora o fim do stream
    nodeStream.on('end', () => {
      console.log('Stream finalizado com sucesso');
    });

    // Pipe com tratamento de erro
    nodeStream.pipe(res);

    // Handler para quando o cliente desconecta
    req.on('close', () => {
      // Destrói o stream se o cliente desconectar
      if (!nodeStream.destroyed) {
        nodeStream.destroy();
      }
    });

  } catch (err) {
    console.error('Erro no proxy:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Erro ao buscar vídeo',
        details: err.message,
      });
    } else {
      res.end();
    }
  }
});

// Rota simples para teste
app.get('/', (req, res) => {
  res.send('Proxy online - Use /proxy?id=SEU_ID para acessar o vídeo');
});

// Handler de erro global
app.use((err, req, res, next) => {
  console.error('Erro global:', err.message);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Erro interno do servidor',
      details: err.message,
    });
  } else {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
