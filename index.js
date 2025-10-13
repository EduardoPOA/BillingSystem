// 🤖 BOT AUTOMÁTICO COM GOOGLE SHEETS - VERSÃO AJUSTADA
// Foco em testes manuais e melhorias de usabilidade.

import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import QRCode from 'qrcode';
import https from 'https';
import cron from 'node-cron';

const app = express( );
app.use(bodyParser.json());

// Armazena as instâncias dos bots em memória
const clientBots = new Map();

// =================================================================================
// 🔹 LÓGICA DO WHATSAPP E GOOGLE SHEETS
// =================================================================================

/**
 * Lê uma planilha pública do Google Sheets, extraindo o ID de qualquer formato de URL.
 * @param {string} sheetUrl - A URL da planilha pública (qualquer formato).
 * @returns {Promise<Array<Object>>}
 */
async function readPublicSheet(sheetUrl) {
  try {
    const sheetIdMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch || !sheetIdMatch[1]) {
      throw new Error('URL da planilha inválida. Não foi possível encontrar o ID.');
    }
    const sheetId = sheetIdMatch[1];

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    console.log(`[INFO] Acessando a planilha via URL de exportação: ${csvUrl}` );

    return new Promise((resolve, reject) => {
      https.get(csvUrl, (res ) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`[INFO] Redirecionamento detectado (Status: ${res.statusCode}). Seguindo para: ${res.headers.location}`);
          https.get(res.headers.location, (redirectedRes ) => {
            let data = '';
            redirectedRes.on('data', chunk => data += chunk);
            redirectedRes.on('end', () => handleCsvData(data, resolve, reject));
          }).on('error', reject);
          return;
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Erro ao acessar a planilha. Status: ${res.statusCode}. Verifique se ela é pública.`));
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => handleCsvData(data, resolve, reject));

      }).on('error', reject);
    });
  } catch (error) {
    console.error('❌ Erro ao ler planilha:', error);
    throw error;
  }
}

/**
 * Função auxiliar para processar os dados CSV.
 */
function handleCsvData(csvData, resolve, reject) {
  try {
    const lines = csvData.split('\n').map(line => line.trim());
    if (lines.length < 2 || !lines[0]) return resolve([]);

    const headers = lines[0].split(',').map(header => header.trim().replace(/"/g, ''));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const values = lines[i].match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
      const row = {};
      headers.forEach((header, index) => {
        row[header] = (values[index] || '').trim().replace(/"/g, '');
      });
      rows.push(row);
    }
    resolve(rows);
  } catch (e) {
    reject(e);
  }
}

/**
 * Envia uma mensagem de texto para um número de telefone via WhatsApp.
 * @param {string} clientId - O ID do cliente/bot.
 * @param {string} phone - O número de telefone do destinatário.
 * @param {string} message - A mensagem a ser enviada.
 * @returns {Promise<boolean>}
 */
async function enviarMensagem(clientId, phone, message) {
  const client = clientBots.get(clientId);
  if (!client || !client.connected) return false;

  try {
    let cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = '55' + cleanPhone;
    }

    if (cleanPhone.length === 12) {
      const ddd = cleanPhone.substring(2, 4);
      const number = cleanPhone.substring(4);
      cleanPhone = `55${ddd}9${number}`;
    }

    if (cleanPhone.length !== 13) {
      console.warn(`[${clientId}] Número de telefone '${phone}' parece inválido. Pulando.`);
      return false;
    }

    const formattedPhone = cleanPhone + '@c.us';
    await client.sock.sendMessage(formattedPhone, { text: message });
    console.log(`✅ [${clientId}] Mensagem enviada para ${phone}`);
    return true;
  } catch (error) {
    console.error(`❌ [${clientId}] Falha ao enviar para ${phone}:`, error.message);
    return false;
  }
}

/**
 * Processa a planilha de pagamentos e envia as notificações de cobrança.
 * @param {string} clientId - O ID do cliente/bot.
 */
async function processarPagamentos(clientId) {
  const client = clientBots.get(clientId);
  if (!client || !client.connected || !client.sheetUrl) {
    console.warn(`[${clientId}] Processamento abortado: bot não conectado ou planilha não configurada.`);
    return;
  }

  try {
    console.log(`🔄 [${clientId}] Iniciando processamento de pagamentos...`);
    const alunos = await readPublicSheet(client.sheetUrl);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    for (const aluno of alunos) {
      const nome = aluno.Nome || aluno.nome || aluno.Aluno || aluno.aluno;
      const telefone = aluno.Telefone || aluno.telefone || aluno.Celular || aluno.celular;
      const dataVencStr = aluno.Data_Vencimento || aluno.data_vencimento || aluno.Vencimento || aluno.vencimento;
      const valor = aluno.Valor || aluno.valor || '0';
      const status = aluno.Status_Pagamento || aluno.status_pagamento || 'Pendente';

      if (!nome || !telefone || !dataVencStr || status.toLowerCase() === 'pago') continue;

      const parts = dataVencStr.split('/');
      if (parts.length !== 3) continue;
      const [dia, mes, ano] = parts;
      const dataVencimento = new Date(ano, mes - 1, dia);
      dataVencimento.setHours(0, 0, 0, 0);

      const diffDays = Math.ceil((dataVencimento - hoje) / (1000 * 60 * 60 * 24));
      const valorFormatado = `R$ ${parseFloat(valor.replace(',', '.')).toFixed(2).replace('.', ',')}`;
      const chavePix = client.chavePix || 'Não configurada';
      let mensagem = '';

      // --- LÓGICA DE MENSAGENS CORRIGIDA ---

      if (diffDays < 0) {
        // 1. MENSALIDADE ATRASADA
        const diasAtraso = Math.abs(diffDays);
        mensagem = `Olá ${nome}! ⚠️\n\nSua mensalidade está atrasada há ${diasAtraso} dia(s).\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento original: ${dataVencStr}\n\nPara regularizar, utilize o PIX abaixo:\n${chavePix}\n\nQualquer dúvida, estamos à disposição! 💪`;

      } else if (diffDays === 0) {
        // 2. VENCIMENTO HOJE
        mensagem = `Olá ${nome}! 🔴\n\nSua mensalidade vence HOJE!\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento: ${dataVencStr}\n\n💳 PIX para pagamento:\n${chavePix}\n\nRealize o pagamento para evitar atrasos! 💪`;

      } else if (diffDays === 3) {
        // 3. LEMBRETE DE 3 DIAS (NÃO ESTÁ ATRASADO)
        mensagem = `Olá ${nome}! 🔔\n\nLembrete amigável: sua mensalidade vence em 3 dias.\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento: ${dataVencStr}\n\nPara facilitar, você já pode pagar usando o PIX:\n${chavePix}\n\nFique em dia! 💪`;
      }

      if (mensagem) {
        await enviarMensagem(clientId, telefone, mensagem);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Delay para evitar bloqueio
      }
    }
    console.log(`✅ [${clientId}] Processamento concluído.`);
  } catch (error) {
    console.error(`❌ [${clientId}] Erro crítico durante o processamento:`, error);
  }
}


// =================================================================================
// 🔹 GERENCIAMENTO DO BOT (CONEXÃO E DADOS)
// =================================================================================

async function createClientBot(clientId) {
  const authPath = `./clients/${clientId}/auth`;
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, console) },
    printQRInTerminal: false,
    browser: ['Bot-Cobrança', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const client = clientBots.get(clientId);

    if (qr && client) client.qrCode = await QRCode.toDataURL(qr);

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[${clientId}] Conexão fechada. Motivo: ${DisconnectReason[lastDisconnect?.error?.output?.statusCode]}. ${shouldReconnect ? 'Tentando reconectar...' : 'Logout.'}`);
      if (shouldReconnect) setTimeout(() => createClientBot(clientId), 5000);
    } else if (connection === 'open') {
      if (client) {
        client.connected = true;
        client.connectedNumber = sock.user.id.split(':')[0];
        client.qrCode = null;
        saveClientData(clientId);
        console.log(`✅ [${clientId}] Conectado com o número: ${client.connectedNumber}`);
      }
    }
  });

  clientBots.set(clientId, {
    sock,
    connected: false,
    qrCode: null,
    sheetUrl: null,
    chavePix: null,
    createdAt: new Date(),
  });
}

function saveClientData(clientId) {
  const client = clientBots.get(clientId);
  if (!client) return;

  const clientDir = `./clients/${clientId}`;
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

  const data = {
    id: clientId,
    connectedNumber: client.connectedNumber,
    sheetUrl: client.sheetUrl,
    chavePix: client.chavePix,
    connected: client.connected,
    createdAt: client.createdAt,
  };
  fs.writeFileSync(`${clientDir}/config.json`, JSON.stringify(data, null, 2));
}

async function loadExistingClients() {
  const clientsDir = './clients';
  if (!fs.existsSync(clientsDir)) return;

  const clientIds = fs.readdirSync(clientsDir);
  for (const clientId of clientIds) {
    const configPath = `${clientsDir}/${clientId}/config.json`;
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log(`🔄 Carregando cliente existente: ${clientId}`);
        await createClientBot(clientId);
        const client = clientBots.get(clientId);
        if (client) {
          client.sheetUrl = config.sheetUrl;
          client.chavePix = config.chavePix;
        }
      } catch (error) {
        console.error(`Falha ao carregar cliente ${clientId}:`, error);
      }
    }
  }
}

// =================================================================================
// 🔹 SERVIDOR WEB (API E INTERFACE)
// =================================================================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sistema de Cobrança Automática</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: white; border-radius: 20px; padding: 40px; max-width: 500px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; }
    h1 { color: #25D366; margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    #clientIdDisplay { font-size: 12px; color: #888; margin-bottom: 20px; user-select: all; }
    .qr-container { background: #f5f5f5; padding: 20px; border-radius: 15px; margin: 20px 0; min-height: 300px; display: flex; align-items: center; justify-content: center; }
    #qrCode { max-width: 280px; width: 100%; display: none; }
    .loading { color: #667eea; }
    .form-group { margin: 20px 0; text-align: left; }
    label { display: block; color: #555; margin-bottom: 8px; font-weight: 500; }
    input { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; }
    input:focus { outline: none; border-color: #667eea; }
    .btn { background: #25D366; color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%; margin-top: 10px; transition: background-color 0.2s; }
    .btn:hover { background: #128C7E; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    .btn-secondary { background-color: #667eea; margin-top: 15px; }
    .btn-secondary:hover { background-color: #5a67d8; }
    .status { padding: 15px; border-radius: 10px; margin-top: 20px; font-weight: 500; }
    .status.connected { background: #d4edda; color: #155724; }
    .status.waiting { background: #fff3cd; color: #856404; }
    .info-box { background: #e7f3ff; padding: 20px; border-radius: 10px; margin-top: 20px; text-align: left; font-size: 14px; color: #004085; }
    .info-box strong { display: block; margin-bottom: 5px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Sistema de Cobrança</h1>
    <p class="subtitle">Configure em 3 passos</p>
    <p id="clientIdDisplay"></p>
    
    <div id="connection-section">
        <div class="qr-container">
            <img id="qrCode" alt="QR Code do WhatsApp">
            <div class="loading" id="loading">⏳ Gerando QR Code...</div>
        </div>
        <div id="status" class="status waiting">⏳ Aguardando conexão com o WhatsApp...</div>
    </div>
    
    <div id="config-section" class="hidden">
        <div id="status-connected" class="status connected">✅ WhatsApp Conectado!</div>
        <div class="form-group">
            <label>📊 URL da sua Planilha Google Sheets:</label>
            <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/...">
            
            <label style="margin-top:15px;">💳 Sua Chave PIX:</label>
            <input type="text" id="chavePix" placeholder="email@pix.com ou CPF">
            
            <button class="btn" onclick="salvarConfig( )">💾 Salvar e Ativar</button>
        </div>
    </div>
    
    <div id="control-section" class="hidden">
        <div class="info-box">
            <strong>✅ Sistema Ativado!</strong>
            <p>O bot está pronto. Use o botão abaixo para iniciar o envio das mensagens de cobrança conforme sua planilha.</p>
            <button id="process-btn" class="btn btn-secondary" onclick="processarManualmente()">🚀 Testar Envio Agora</button>
        </div>
    </div>
    
    <script>
      const clientId = 'client-' + Math.random().toString(36).substr(2, 9);
      document.getElementById('clientIdDisplay').textContent = 'ID da Sessão: ' + clientId;
      let statusInterval;

      async function init() {
        await fetch('/api/setup', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ clientId })
        });
        statusInterval = setInterval(checkStatus, 2000);
      }

      async function checkStatus() {
        try {
          const res = await fetch('/api/status/' + clientId);
          if (!res.ok) return;
          const data = await res.json();

          if (data.qrCode) {
            document.getElementById('qrCode').src = data.qrCode;
            document.getElementById('qrCode').style.display = 'block';
            document.getElementById('loading').style.display = 'none';
          }

          if (data.connected) {
            document.getElementById('connection-section').classList.add('hidden');
            if (data.hasConfig) {
                document.getElementById('config-section').classList.add('hidden');
                document.getElementById('control-section').classList.remove('hidden');
            } else {
                document.getElementById('config-section').classList.remove('hidden');
            }
            clearInterval(statusInterval);
          }
        } catch (error) {
          console.error('Erro ao verificar status:', error);
        }
      }

      async function salvarConfig() {
        const sheetUrl = document.getElementById('sheetUrl').value;
        const chavePix = document.getElementById('chavePix').value;
        if (!sheetUrl || !chavePix) {
          alert('Por favor, preencha a URL da planilha e a Chave PIX.');
          return;
        }
        
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        try {
          const res = await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ clientId, sheetUrl, chavePix })
          });
          const data = await res.json();
          if (data.success) {
            document.getElementById('config-section').classList.add('hidden');
            document.getElementById('control-section').classList.remove('hidden');
          } else {
            alert('Erro: ' + data.error);
          }
        } catch (error) {
          alert('Erro ao salvar configuração.');
        } finally {
            btn.disabled = false;
            btn.textContent = '💾 Salvar e Ativar';
        }
      }

      async function processarManualmente() {
        const btn = document.getElementById('process-btn');
        btn.disabled = true;
        btn.textContent = '🔄 Processando...';

        try {
            const res = await fetch('/api/process/' + clientId, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Processamento concluído! Verifique o terminal para ver os detalhes do envio.');
            } else {
                alert('Erro no processamento: ' + data.error);
            }
        } catch (error) {
            alert('Falha ao se comunicar com o servidor.');
        } finally {
            btn.disabled = false;
            btn.textContent = '🚀 Testar Envio Agora';
        }
      }

      init();
    </script>
  </body>
</html>`);
});

app.post('/api/setup', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId é obrigatório' });
  if (!clientBots.has(clientId)) await createClientBot(clientId);
  res.json({ success: true });
});

app.get('/api/status/:clientId', (req, res) => {
  const client = clientBots.get(req.params.clientId);
  if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
  res.json({
    success: true,
    connected: client.connected,
    qrCode: client.qrCode,
    hasConfig: !!(client.sheetUrl && client.chavePix),
  });
});

app.post('/api/config', (req, res) => {
  const { clientId, sheetUrl, chavePix } = req.body;
  const client = clientBots.get(clientId);
  if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
  if (!client.connected) return res.status(400).json({ success: false, error: 'WhatsApp não está conectado' });

  client.sheetUrl = sheetUrl;
  client.chavePix = chavePix;
  saveClientData(clientId);
  res.json({ success: true, message: 'Configuração salva!' });
});

app.post('/api/process/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    await processarPagamentos(clientId);
    res.json({ success: true, message: 'Processamento iniciado.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================================
// 🔹 AGENDAMENTO AUTOMÁTICO (CRON)
// =================================================================================

// A expressão '* * * * *' significa "executar a cada minuto" (para testes).
// Para produção, use algo como '0 9 * * *' (todo dia às 9h).
cron.schedule('* * * * *', () => {
  console.log('⏰ CRON: Iniciando verificação agendada de pagamentos...');
  
  clientBots.forEach((client, clientId) => {
    if (client.connected && client.sheetUrl) {
      console.log(`[CRON] Acionando processamento para o cliente: ${clientId}`);
      processarPagamentos(clientId);
    }
  });
}, {
  timezone: "America/Sao_Paulo"
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🤖 SISTEMA DE COBRANÇA AUTOMÁTICO   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🚀 Servidor rodando! Acesse: http://localhost:${PORT}\n` );
  await loadExistingClients();
  console.log('✅ Sistema pronto para receber conexões.\n');
});
