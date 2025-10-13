// 🤖 BOT AUTOMÁTICO COM GOOGLE SHEETS
// Personal só escaneia QR Code e cola URL da planilha

import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import QRCode from 'qrcode';
import https from 'https';
import cron from 'node-cron';

const app = express();
app.use(bodyParser.json());

const clientBots = new Map();

// 🔹 Função para ler Google Sheets público
async function readPublicSheet(sheetUrl) {
  try {
    // Extrai o ID da planilha
    const sheetId = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!sheetId) throw new Error('URL da planilha inválida');
    
    // URL da API do Google Sheets (formato CSV público)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    
    return new Promise((resolve, reject) => {
      https.get(csvUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Parseia CSV para array
          const lines = data.split('\n');
          const headers = lines[0].split(',');
          const rows = [];
          
          for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const values = lines[i].split(',');
            const row = {};
            headers.forEach((header, index) => {
              row[header.trim()] = values[index]?.trim() || '';
            });
            rows.push(row);
          }
          
          resolve(rows);
        });
      }).on('error', reject);
    });
  } catch (error) {
    console.error('❌ Erro ao ler planilha:', error);
    throw error;
  }
}

// 🔹 Processar pagamentos de um cliente
async function processarPagamentos(clientId) {
  const client = clientBots.get(clientId);
  if (!client || !client.connected || !client.sheetUrl) return;
  
  try {
    console.log(`🔄 Processando pagamentos para ${clientId}`);
    
    const alunos = await readPublicSheet(client.sheetUrl);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
    for (const aluno of alunos) {
      // Adaptar aos nomes reais da planilha
      const nome = aluno.Nome || aluno.nome || aluno.Aluno || aluno.aluno;
      const telefone = aluno.Telefone || aluno.telefone || aluno.Celular || aluno.celular;
      const dataVenc = aluno.Data_Vencimento || aluno.data_vencimento || aluno.Vencimento || aluno.vencimento;
      const valor = aluno.Valor || aluno.valor || '0';
      const status = aluno.Status_Pagamento || aluno.status_pagamento || 'Pendente';
      
      if (!nome || !telefone || !dataVenc || status === 'Pago') continue;
      
      // Converte data (formato DD/MM/AAAA)
      const [dia, mes, ano] = dataVenc.split('/');
      const dataVencimento = new Date(ano, mes - 1, dia);
      dataVencimento.setHours(0, 0, 0, 0);
      
      // Calcula dias
      const diffDays = Math.ceil((dataVencimento - hoje) / (1000 * 60 * 60 * 24));
      
      let mensagem = '';
      const valorFormatado = valor ? `R$ ${parseFloat(valor).toFixed(2).replace('.', ',')}` : 'N/A';
      const chavePix = client.chavePix || 'Não configurado';
      
      // Lógica de envio
      if (diffDays < 0) {
        // Atrasado
        const diasAtraso = Math.abs(diffDays);
        mensagem = `Olá ${nome}! ⚠️\n\nSeu pagamento está atrasado há ${diasAtraso} dia(s).\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento: ${dataVenc}\n\n💳 PIX:\n${chavePix}\n\nPor favor, regularize sua situação! 💪`;
      } else if (diffDays === 0) {
        // Vence hoje
        mensagem = `Olá ${nome}! 🔴\n\nSeu pagamento vence HOJE!\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento: ${dataVenc}\n\n💳 PIX:\n${chavePix}\n\nRealize o pagamento para evitar bloqueio! 💪`;
      } else if (diffDays === 3) {
        // 3 dias antes
        mensagem = `Olá ${nome}! 🔔\n\nSeu pagamento vence em 3 dias.\n\n💰 Valor: ${valorFormatado}\n📅 Vencimento: ${dataVenc}\n\n💳 PIX:\n${chavePix}\n\nFique em dia! 💪`;
      }
      
      if (mensagem) {
        await enviarMensagem(clientId, telefone, mensagem);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Delay
      }
    }
    
    console.log(`✅ Processamento concluído para ${clientId}`);
  } catch (error) {
    console.error(`❌ Erro ao processar ${clientId}:`, error);
  }
}

// 🔹 Enviar mensagem
async function enviarMensagem(clientId, phone, message) {
  const client = clientBots.get(clientId);
  if (!client || !client.connected) return false;
  
  try {
    let cleanPhone = phone.replace(/\D/g, '');
    
    // Adiciona 9 no celular se necessário (BR)
    if (cleanPhone.startsWith('55') && cleanPhone.length === 12) {
      const countryCode = cleanPhone.substring(0, 2);
      const ddd = cleanPhone.substring(2, 4);
      const number = cleanPhone.substring(4);
      cleanPhone = countryCode + ddd + '9' + number;
    }
    
    const formattedPhone = cleanPhone + '@c.us';
    await client.sock.sendMessage(formattedPhone, { text: message });
    
    console.log(`✅ [${clientId}] Mensagem enviada para ${phone}`);
    return true;
  } catch (error) {
    console.error(`❌ [${clientId}] Erro:`, error);
    return false;
  }
}

// 🔹 Criar bot do cliente
async function createClientBot(clientId) {
  try {
    const authPath = `./clients/${clientId}/auth`;
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console),
      },
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        const client = clientBots.get(clientId);
        if (client) {
          client.qrCode = qrImage;
        }
        console.log(`📷 QR Code gerado para ${clientId}`);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 Reconectando ${clientId}`);
          setTimeout(() => createClientBot(clientId), 3000);
        }
      } else if (connection === 'open') {
        const client = clientBots.get(clientId);
        const connectedNumber = sock.user.id.split(':')[0];
        
        console.log(`✅ ${clientId} conectado! Número: ${connectedNumber}`);
        
        if (client) {
          client.connected = true;
          client.connectedNumber = connectedNumber;
          client.qrCode = null;
          
          // Salva informações
          saveClientData(clientId);
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

    return sock;
  } catch (error) {
    console.error(`❌ Erro ao criar bot para ${clientId}:`, error);
    throw error;
  }
}

// 🔹 Salvar dados do cliente
function saveClientData(clientId) {
  const client = clientBots.get(clientId);
  if (!client) return;
  
  const clientDir = `./clients/${clientId}`;
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }
  
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

// 🔹 Carregar clientes existentes
async function loadExistingClients() {
  const clientsDir = './clients';
  if (!fs.existsSync(clientsDir)) {
    fs.mkdirSync(clientsDir, { recursive: true });
    return;
  }

  const clients = fs.readdirSync(clientsDir);
  
  for (const clientId of clients) {
    const configPath = `${clientsDir}/${clientId}/config.json`;
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log(`🔄 Carregando cliente: ${clientId}`);
      
      await createClientBot(clientId);
      
      const client = clientBots.get(clientId);
      if (client) {
        client.sheetUrl = config.sheetUrl;
        client.chavePix = config.chavePix;
      }
    }
  }
}

// 🔹 Página inicial (Cadastro/Conexão)
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
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    h1 { color: #25D366; margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .qr-container {
      background: #f5f5f5;
      padding: 20px;
      border-radius: 15px;
      margin: 20px 0;
      min-height: 300px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #qrCode { max-width: 280px; width: 100%; }
    .loading { color: #667eea; }
    .form-group {
      margin: 20px 0;
      text-align: left;
    }
    label {
      display: block;
      color: #555;
      margin-bottom: 8px;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    .btn {
      background: #25D366;
      color: white;
      border: none;
      padding: 15px 30px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      margin-top: 10px;
    }
    .btn:hover { background: #128C7E; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    .status {
      padding: 15px;
      border-radius: 10px;
      margin-top: 20px;
      font-weight: 500;
    }
    .status.connected { background: #d4edda; color: #155724; }
    .status.waiting { background: #fff3cd; color: #856404; }
    .info-box {
      background: #e7f3ff;
      padding: 15px;
      border-radius: 10px;
      margin-top: 20px;
      text-align: left;
      font-size: 14px;
      color: #004085;
    }
    .info-box strong { display: block; margin-bottom: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Sistema de Cobrança</h1>
    <p class="subtitle">Configure em 3 passos</p>
    
    <div class="qr-container">
      <img id="qrCode" style="display:none;" alt="QR Code">
      <div class="loading" id="loading">⏳ Gerando QR Code...</div>
    </div>
    
    <div id="status" class="status waiting">
      ⏳ Aguardando conexão WhatsApp...
    </div>
    
    <div class="form-group" id="formGroup" style="display:none;">
      <label>📊 URL da sua Planilha Google Sheets:</label>
      <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/...">
      
      <label style="margin-top:15px;">💳 Sua Chave PIX:</label>
      <input type="text" id="chavePix" placeholder="email@pix.com ou CPF">
      
      <button class="btn" onclick="salvarConfig()">✅ Ativar Sistema</button>
    </div>
    
    <div class="info-box" style="display:none;" id="infoBox">
      <strong>✅ Sistema Ativado!</strong>
      Todo dia às 9h da manhã, o sistema vai verificar sua planilha e enviar mensagens automaticamente.
    </div>
    
    <script>
      const clientId = 'client-' + Math.random().toString(36).substr(2, 9);
      let checkInterval;
      
      async function init() {
        // Cria o cliente
        await fetch('/api/setup', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ clientId })
        });
        
        // Inicia verificação
        checkInterval = setInterval(checkStatus, 2000);
        checkStatus();
      }
      
      async function checkStatus() {
        try {
          const res = await fetch('/api/status/' + clientId);
          const data = await res.json();
          
          if (data.qrCode && !data.connected) {
            document.getElementById('qrCode').src = data.qrCode;
            document.getElementById('qrCode').style.display = 'block';
            document.getElementById('loading').style.display = 'none';
          }
          
          if (data.connected) {
            document.getElementById('status').className = 'status connected';
            document.getElementById('status').textContent = '✅ WhatsApp conectado!';
            document.getElementById('formGroup').style.display = 'block';
            clearInterval(checkInterval);
          }
        } catch (error) {
          console.error('Erro:', error);
        }
      }
      
      async function salvarConfig() {
        const sheetUrl = document.getElementById('sheetUrl').value;
        const chavePix = document.getElementById('chavePix').value;
        
        if (!sheetUrl || !chavePix) {
          alert('Por favor, preencha todos os campos');
          return;
        }
        
        try {
          const res = await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ clientId, sheetUrl, chavePix })
          });
          
          const data = await res.json();
          
          if (data.success) {
            document.getElementById('formGroup').style.display = 'none';
            document.getElementById('infoBox').style.display = 'block';
          } else {
            alert('Erro: ' + data.error);
          }
        } catch (error) {
          alert('Erro ao salvar configuração');
        }
      }
      
      init();
    </script>
  </body>
</html>
  `);
});

// 🔹 API: Setup inicial
app.post('/api/setup', async (req, res) => {
  const { clientId } = req.body;
  
  try {
    if (!clientBots.has(clientId)) {
      await createClientBot(clientId);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔹 API: Status
app.get('/api/status/:clientId', (req, res) => {
  const { clientId } = req.params;
  const client = clientBots.get(clientId);
  
  if (!client) {
    return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
  }
  
  res.json({
    success: true,
    connected: client.connected,
    qrCode: client.qrCode,
    hasConfig: !!(client.sheetUrl && client.chavePix),
  });
});

// 🔹 API: Salvar configuração
app.post('/api/config', (req, res) => {
  const { clientId, sheetUrl, chavePix } = req.body;
  
  const client = clientBots.get(clientId);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
  }
  
  if (!client.connected) {
    return res.status(400).json({ success: false, error: 'WhatsApp não conectado' });
  }
  
  client.sheetUrl = sheetUrl;
  client.chavePix = chavePix;
  
  saveClientData(clientId);
  
  res.json({ success: true, message: 'Configuração salva com sucesso!' });
});

// 🔹 Cron job: Roda todo dia às 9h
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Iniciando verificação diária de pagamentos...');
  clientBots.forEach((client, clientId) => {
    if (client.connected && client.sheetUrl) {
      processarPagamentos(clientId);
    }
  });
});

// 🔹 API: Processar manualmente (teste)
app.post('/api/process/:clientId', async (req, res) => {
  const { clientId } = req.params;
  
  try {
    await processarPagamentos(clientId);
    res.json({ success: true, message: 'Processamento concluído' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔹 Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🤖 SISTEMA DE COBRANÇA AUTOMÁTICO   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🚀 Acesse: http://localhost:${PORT}\n`);
  
  await loadExistingClients();
  console.log('✅ Sistema pronto!\n');
});