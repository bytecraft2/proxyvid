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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition'
  );
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
    return res.status(400).json({ error: 'ID não informado' });
  }

  // URLs para teste
  const url = download ? 
    `https://test.zerostorage.net/api/files/download/${id}?track=true` : 
    `https://test.zerostorage.net/api/files/${id}/stream`;
  
  console.log(`[${new Date().toISOString()}] Tentando acessar: ${url}`);
  console.log(`[${new Date().toISOString()}] Modo: ${download ? 'download' : 'stream'}`);

  try {
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };

    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
      console.log(`[${new Date().toISOString()}] Range solicitado: ${req.headers.range}`);
    }

    // Adiciona timeout na requisição
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const remoteResponse = await fetch(url, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // LOG DETALHADO DA RESPOSTA
    console.log(`[${new Date().toISOString()}] Status remoto: ${remoteResponse.status} ${remoteResponse.statusText}`);
    console.log(`[${new Date().toISOString()}] Headers remotos:`);
    
    const headersObj = {};
    for (const [name, value] of remoteResponse.headers.entries()) {
      headersObj[name] = value;
      console.log(`  ${name}: ${value}`);
    }

    // Verifica se a resposta é válida
    if (remoteResponse.status === 404) {
      return res.status(404).json({
        error: 'Arquivo não encontrado no servidor remoto',
        status: 404,
        id: id
      });
    }

    if (remoteResponse.status === 403) {
      return res.status(403).json({
        error: 'Acesso negado ao arquivo',
        status: 403,
        id: id
      });
    }

    if (remoteResponse.status === 500 || remoteResponse.status === 502 || remoteResponse.status === 503) {
      return res.status(remoteResponse.status).json({
        error: `Servidor remoto com erro: ${remoteResponse.status}`,
        status: remoteResponse.status,
        details: remoteResponse.statusText
      });
    }

    // Para outros códigos de erro
    if (!remoteResponse.ok && remoteResponse.status !== 206) {
      console.error(`[${new Date().toISOString()}] Erro remoto: ${remoteResponse.status}`);
      
      // Tenta ler o corpo do erro
      let errorBody = '';
      try {
        const text = await remoteResponse.text();
        errorBody = text.substring(0, 500); // Limita o tamanho
      } catch (e) {
        errorBody = 'Não foi possível ler o corpo do erro';
      }
      
      return res.status(remoteResponse.status).json({
        error: 'Erro ao buscar arquivo no servidor remoto',
        status: remoteResponse.status,
        statusText: remoteResponse.statusText,
        body: errorBody
      });
    }

    // Configura os headers da resposta
    res.status(remoteResponse.status);

    // Força accept-ranges se não vier do remoto
    if (!remoteResponse.headers.has('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Repassa headers permitidos
    let contentLength = null;
    let contentType = null;
    
    for (const [name, value] of remoteResponse.headers.entries()) {
      const lowerName = name.toLowerCase();
      if (ALLOWED_RESPONSE_HEADERS.has(lowerName)) {
        if (lowerName === 'content-length') {
          contentLength = parseInt(value, 10);
        }
        if (lowerName === 'content-type') {
          contentType = value;
        }
        res.setHeader(name, value);
      }
    }

    console.log(`[${new Date().toISOString()}] Content-Type: ${contentType}`);
    console.log(`[${new Date().toISOString()}] Content-Length: ${contentLength}`);

    // Adiciona Content-Disposition para download
    if (download) {
      const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      console.log(`[${new Date().toISOString()}] Download iniciado: ${safeFilename}`);
    }

    // Se for status 204 ou 304, não tem corpo
    if (remoteResponse.status === 204 || remoteResponse.status === 304) {
      console.log(`[${new Date().toISOString()}] Resposta sem corpo (${remoteResponse.status})`);
      return res.end();
    }

    // Verifica se há corpo
    if (!remoteResponse.body) {
      console.warn(`[${new Date().toISOString()}] Resposta sem corpo`);
      return res.end();
    }

    // Cria o stream
    const nodeStream = Readable.fromWeb(remoteResponse.body);

    // Timeouts
    req.setTimeout(60000);
    res.setTimeout(60000);

    let bytesTransferred = 0;
    let hasError = false;

    // Monitora o progresso do stream
    nodeStream.on('data', (chunk) => {
      bytesTransferred += chunk.length;
      if (bytesTransferred % 1048576 < chunk.length) { // Log a cada 1MB
        console.log(`[${new Date().toISOString()}] Transferidos: ${(bytesTransferred / 1048576).toFixed(2)} MB`);
      }
    });

    nodeStream.on('error', (err) => {
      hasError = true;
      console.error(`[${new Date().toISOString()}] Erro no stream:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Erro ao transmitir vídeo',
          details: err.message,
        });
      } else {
        res.end();
      }
    });

    nodeStream.on('end', () => {
      if (!hasError) {
        console.log(`[${new Date().toISOString()}] Stream finalizado com sucesso. Total: ${(bytesTransferred / 1048576).toFixed(2)} MB`);
      }
    });

    // Pipe com tratamento
    nodeStream.pipe(res);

    req.on('close', () => {
      console.log(`[${new Date().toISOString()}] Cliente desconectou. Transferidos: ${(bytesTransferred / 1048576).toFixed(2)} MB`);
      if (!nodeStream.destroyed) {
        nodeStream.destroy();
      }
    });

  } catch (err) {
    clearTimeout(timeoutId);
    
    console.error(`[${new Date().toISOString()}] Erro na requisição:`, err.message);
    
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'Timeout ao buscar arquivo',
        details: 'O servidor remoto demorou muito para responder'
      });
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(502).json({
        error: 'Servidor remoto indisponível',
        details: err.message,
        code: err.code
      });
    }

    if (!res.headersSent) {
      res.status(502).json({
        error: 'Erro ao buscar vídeo',
        details: err.message,
        code: err.code
      });
    } else {
      res.end();
    }
  }
});

// Rota de teste com diagnóstico
app.get('/test', async (req, res) => {
  const id = req.query.id || 'teste';
  const url = `https://test.zerostorage.net/api/files/${id}/stream`;
  
  res.setHeader('Content-Type', 'application/json');
  
  try {
    console.log(`[${new Date().toISOString()}] Teste de conectividade: ${url}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    const headers = {};
    for (const [name, value] of response.headers.entries()) {
      headers[name] = value;
    }
    
    res.json({
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: headers,
      url: url
    });
  } catch (err) {
    clearTimeout(timeoutId);
    res.json({
      success: false,
      error: err.message,
      code: err.code,
      url: url
    });
  }
});

// Rota simples para teste
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Proxy de Vídeo</title></head>
      <body>
        <h1>Proxy de Vídeo</h1>
        <p>Use /proxy?id=SEU_ID para acessar o vídeo</p>
        <p>Use /test?id=SEU_ID para testar a conectividade</p>
        <p>Exemplo: <a href="/proxy?id=SEU_ID">/proxy?id=SEU_ID</a></p>
      </body>
    </html>
  `);
});

// Handler de erro global
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Erro global:`, err.message);
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
  console.log(`[${new Date().toISOString()}] Servidor rodando na porta ${PORT}`);
  console.log(`[${new Date().toISOString()}] Teste de conectividade: http://localhost:${PORT}/test?id=SEU_ID`);
});
