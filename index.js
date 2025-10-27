// 🤖 BOT AUTOMÁTICO COM GOOGLE SHEETS - VERSÃO ESTÁVEL E CUSTOMIZÁVEL (v4)
// CAMPOS OBRIGATÓRIOS: URL DO GOOGLE SHEETS, INSTRUÇÕES DE PAGAMENTO E PELO MENOS 1 TOGGLE

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

// =================================================================================
// 🔹 LÓGICA DO WHATSAPP E GOOGLE SHEETS
// =================================================================================

async function readPublicSheet(sheetUrl) {
    try {
        const sheetIdMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!sheetIdMatch || !sheetIdMatch[1]) throw new Error('URL da planilha inválida.');
        const sheetId = sheetIdMatch[1];
        const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        return new Promise((resolve, reject) => {
            https.get(csvUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    https.get(res.headers.location, (redirectedRes) => {
                        let data = '';
                        redirectedRes.on('data', chunk => data += chunk);
                        redirectedRes.on('end', () => handleCsvData(data, resolve, reject));
                    }).on('error', reject);
                    return;
                }
                if (res.statusCode !== 200) return reject(new Error(`Erro ${res.statusCode}. Verifique se a planilha é pública.`));
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => handleCsvData(data, resolve, reject));
            }).on('error', reject);
        });
    } catch (error) {
        console.error('❌ Erro ao ler planilha:', error.message);
        throw error;
    }
}

function handleCsvData(csvData, resolve, reject) {
    try {
        const lines = csvData.split('\n').map(line => line.trim());
        if (lines.length < 2 || !lines[0]) return resolve([]);
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const rows = lines.slice(1).map(line => {
            if (!line) return null;
            const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || line.split(',');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = (values[index] || '').trim().replace(/"/g, '');
            });
            return row;
        }).filter(Boolean);
        resolve(rows);
    } catch (e) {
        reject(e);
    }
}

async function enviarMensagem(clientId, phone, message) {
    const client = clientBots.get(clientId);
    if (!client || !client.connected) return false;
    try {
        let cleanPhone = phone.replace(/\D/g, '');
        if (!cleanPhone.startsWith('55')) cleanPhone = '55' + cleanPhone;
        if (cleanPhone.length === 12) cleanPhone = `55${cleanPhone.substring(2, 4)}9${cleanPhone.substring(4)}`;
        if (cleanPhone.length !== 13) {
            console.warn(`[${clientId}] Número '${phone}' inválido. Pulando.`);
            return false;
        }
        await client.sock.sendMessage(cleanPhone + '@c.us', { text: message });
        console.log(`✅ [${clientId}] Mensagem enviada para ${phone}`);
        return true;
    } catch (error) {
        console.error(`❌ [${clientId}] Falha ao enviar para ${phone}:`, error.message);
        return false;
    }
}

async function processarPagamentos(clientId) {
    const client = clientBots.get(clientId);
    if (!client || !client.connected || !client.config || !client.config.sheetUrl) return;

    try {
        console.log(`🔄 [${clientId}] Iniciando processamento de pagamentos...`);
        const alunos = await readPublicSheet(client.config.sheetUrl);
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
            let mensagem = '';
            const config = client.config;

            if (config.notificacaoAtraso && diffDays < 0) {
                mensagem = config.templateAtraso;
            } else if (config.notificacaoHoje && diffDays === 0) {
                mensagem = config.templateHoje;
            } else if (config.notificacaoLembrete && diffDays > 0 && config.diasLembrete.includes(diffDays)) {
                mensagem = config.templateLembrete;
            }

            if (mensagem) {
                const valorFormatado = `R$ ${parseFloat(valor.replace(',', '.')).toFixed(2).replace('.', ',')}`;
                const diasAtraso = Math.abs(diffDays);
                
                let finalMessage = mensagem
                    .replace(/{nome}/g, nome)
                    .replace(/{valor}/g, valorFormatado)
                    .replace(/{vencimento}/g, dataVencStr)
                    .replace(/{dias_atraso}/g, diasAtraso)
                    .replace(/{dias_lembrete}/g, diffDays)
                    .replace(/{pagamento}/g, config.instrucoesPagamento || 'Forma de pagamento não configurada.');

                await enviarMensagem(clientId, telefone, finalMessage);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        console.log(`✅ [${clientId}] Processamento concluído.`);
    } catch (error) {
        console.error(`❌ [${clientId}] Erro crítico no processamento:`, error.message);
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
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, console)
        },
        printQRInTerminal: false,
        browser: ['Bot-Cobrança', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const client = clientBots.get(clientId);
        if (qr && client) client.qrCode = await QRCode.toDataURL(qr);
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${clientId}] Conexão fechada. Motivo: ${statusCode}. ${shouldReconnect ? 'Tentando reconectar...' : 'Logout permanente.'}`);
            if (shouldReconnect) {
                setTimeout(() => createClientBot(clientId), 5000);
            } else {
                const clientAuthPath = `./clients/${clientId}/auth`;
                if (fs.existsSync(clientAuthPath)) {
                    fs.rmSync(clientAuthPath, { recursive: true, force: true });
                    console.log(`[${clientId}] Pasta de autenticação limpa devido a logout. Reinicie o servidor para gerar um novo QR Code.`);
                }
            }
        } else if (connection === 'open' && client) {
            client.connected = true;
            client.connectedNumber = sock.user.id.split(':')[0];
            client.qrCode = null;
            console.log(`✅ [${clientId}] Conectado com o número: ${client.connectedNumber}`);
        }
    });

    clientBots.set(clientId, { sock, connected: false, qrCode: null, config: null });
}

function saveClientData(clientId) {
    const client = clientBots.get(clientId);
    if (!client || !client.config) return;
    const clientDir = `./clients/${clientId}`;
    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
    const configToSave = { ...client.config, id: clientId };
    fs.writeFileSync(`${clientDir}/config.json`, JSON.stringify(configToSave, null, 2));
}

async function loadExistingClients() {
    const clientsDir = './clients';
    if (!fs.existsSync(clientsDir)) return;

    for (const clientId of fs.readdirSync(clientsDir)) {
        const configPath = `${clientsDir}/${clientId}/config.json`;
        const authPath = `${clientsDir}/${clientId}/auth`;

        if (!fs.existsSync(authPath)) {
            console.log(`[INFO] Pulando cliente ${clientId} por falta da pasta de autenticação.`);
            continue;
        }

        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                console.log(`🔄 Carregando cliente existente: ${clientId}`);
                await createClientBot(clientId);
                const client = clientBots.get(clientId);
                if (client) client.config = config;
            } catch (error) {
                console.error(`Falha ao carregar ${clientId}:`, error);
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
    <title>Sistema de Cobrança</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 40px; max-width: 600px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; }
        h1 { color: #25D366; margin-bottom: 10px; }
        .subtitle { color: #666; margin-bottom: 20px; }
        .hidden { display: none; }
        .qr-container { background: #f5f5f5; padding: 20px; border-radius: 15px; margin: 20px 0; min-height: 300px; display: flex; align-items: center; justify-content: center; }
        #qrCode { max-width: 280px; width: 100%; display: none; }
        .status { padding: 15px; border-radius: 10px; margin-top: 20px; font-weight: 500; }
        .status.connected { background: #d4edda; color: #155724; }
        .status.waiting { background: #fff3cd; color: #856404; }
        .form-group, .toggle-group { margin: 20px 0; text-align: left; }
        label { display: block; color: #555; margin-bottom: 8px; font-weight: 500; }
        .required { color: #e53e3e; font-weight: bold; }
        input[type="text"], textarea { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; transition: border-color 0.3s; }
        input[type="text"]:focus, textarea:focus { border-color: #25D366; outline: none; }
        textarea { min-height: 100px; resize: vertical; }
        .btn { background: #25D366; color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%; margin-top: 20px; transition: background 0.3s; }
        .btn:hover { background: #128C7E; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .toggle-switch { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; padding: 10px; border: 2px solid #e0e0e0; border-radius: 8px; transition: border-color 0.3s; }
        .toggle-switch.error { border-color: #e53e3e; background-color: #fff5f5; }
        .switch { position: relative; display: inline-block; width: 50px; height: 28px; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 28px; }
        .slider:before { position: absolute; content: ""; height: 20px; width: 20px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #25D366; }
        input:checked + .slider:before { transform: translateX(22px); }
        .template-editor { border-left: 3px solid #667eea; padding-left: 15px; margin-top: 10px; }
        .variables-info { font-size: 13px; color: #555; background: #f0f4ff; padding: 15px; border-radius: 8px; margin-top: 15px; text-align: left; border: 1px solid #c9d8ff; }
        .editor-hint { font-size: 11px; color: #e53e3e; text-align: center; margin-top: 5px; }
        .error-field { border-color: #e53e3e !important; background-color: #fff5f5; }
        .field-hint { font-size: 12px; color: #666; margin-top: 5px; }
        
        /* Modal/Popup Styles */
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal-content { background: white; padding: 30px; border-radius: 15px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
        .modal h3 { color: #e53e3e; margin-bottom: 15px; }
        .modal p { margin-bottom: 20px; color: #555; }
        .modal-btn { background: #25D366; color: white; border: none; padding: 12px 25px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin: 0 5px; }
        .modal-btn.cancel { background: #6c757d; }
        
        .toggle-warning { color: #e53e3e; font-size: 12px; margin-top: 10px; text-align: center; font-weight: 500; }
    </style>
</head>
<body>
<div class="container">
    <h1>🤖 Bot de Cobrança Customizável</h1>
    <p class="subtitle">Conecte seu WhatsApp e personalize suas mensagens</p>
    <div id="connection-section">
        <div class="qr-container">
            <img id="qrCode" alt="QR Code">
            <div id="loading">⏳ Gerando QR Code...</div>
        </div>
        <div id="status" class="status waiting">⏳ Aguardando conexão...</div>
    </div>
    <div id="config-section" class="hidden">
        <div id="status-connected" class="status connected">✅ WhatsApp Conectado!</div>
        
        <div class="form-group">
            <label>📊 URL da Planilha Google Sheets: <span class="required">*</span></label>
            <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/...">
            <div class="field-hint">A planilha deve ser pública e conter colunas: Nome, Telefone, Data_Vencimento, Valor, Status_Pagamento</div>
        </div>
        
        <div class="form-group">
            <label>💳 Instruções de Pagamento: <span class="required">*</span></label>
            <textarea id="instrucoesPagamento" placeholder="Ex: Chave PIX: email@exemplo.com&#10;Ou Link de Pagamento: https://mpago.la/...&#10;Ou Dados bancários: Banco XXX, Agência YYY, Conta ZZZ"></textarea>
            <div class="field-hint">Use a variável {pagamento} nos templates de mensagem para inserir estas instruções</div>
        </div>
        
        <hr>
        
        <div class="toggle-warning">
            ⚠️ Você deve habilitar pelo menos um tipo de notificação abaixo
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleAtraso">
                <label for="notificacaoAtraso">Notificação por Atraso</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoAtraso" onchange="toggleEditor('Atraso'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorAtraso" class="template-editor hidden">
                <label>Modelo da mensagem de atraso:</label>
                <textarea id="templateAtraso"></textarea>
                <div class="editor-hint">⚠️ Cuidado: não altere o texto dentro de {chaves}.</div>
            </div>
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleHoje">
                <label for="notificacaoHoje">Notificação "Vence Hoje"</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoHoje" onchange="toggleEditor('Hoje'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorHoje" class="template-editor hidden">
                <label>Modelo da mensagem de "vence hoje":</label>
                <textarea id="templateHoje"></textarea>
                <div class="editor-hint">⚠️ Cuidado: não altere o texto dentro de {chaves}.</div>
            </div>
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleLembrete">
                <label for="notificacaoLembrete">Notificação de Lembrete</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoLembrete" onchange="toggleEditor('Lembrete'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorLembrete" class="template-editor hidden">
                <label>Modelo da mensagem de lembrete:</label>
                <textarea id="templateLembrete"></textarea>
                <div class="editor-hint">⚠️ Cuidado: não altere o texto dentro de {chaves}.</div>
                <label style="margin-top:10px;">Enviar quantos dias antes? (ex: 3 ou 1,3,7)</label>
                <input type="text" id="diasLembrete" placeholder="Ex: 3">
            </div>
        </div>
        
        <div class="variables-info">
            <strong>Variáveis disponíveis (não altere o texto dentro das chaves):</strong><br>
            {nome}, {valor}, {vencimento}, {pagamento}, {dias_atraso}, {dias_lembrete}
        </div>
        
        <button class="btn" onclick="salvarConfig(event)">💾 Salvar Configurações</button>
    </div>
    
    <div id="control-section" class="hidden">
        <div class="status connected">✅ Sistema Ativado! O bot rodará conforme o agendamento.</div>
        <button class="btn" onclick="processarManualmente(event)">🚀 Testar Envio Agora</button>
    </div>
</div>

<!-- Modal/Popup para erro de toggles -->
<div id="toggleErrorModal" class="modal">
    <div class="modal-content">
        <h3>⚠️ Configuração Incompleta</h3>
        <p>Você precisa habilitar pelo menos um tipo de notificação para o bot funcionar:</p>
        <ul style="text-align: left; margin: 15px 0; color: #555;">
            <li>🔔 Notificação por Atraso</li>
            <li>📅 Notificação "Vence Hoje"</li>
            <li>⏰ Notificação de Lembrete</li>
        </ul>
        <p>Selecione pelo menos uma opção para continuar.</p>
        <button class="modal-btn" onclick="closeModal()">Entendido</button>
    </div>
</div>

<script>
    const clientId = 'client-' + (localStorage.getItem('clientId') || Math.random().toString(36).substr(2, 9));
    localStorage.setItem('clientId', clientId.replace('client-', ''));
    let statusInterval;

    const defaultTemplates = {
        Atraso: 'Olá {nome}! ⚠️\\n\\nSua mensalidade no valor de {valor}, que venceu em {vencimento}, está atrasada há {dias_atraso} dia(s).\\n\\nPara regularizar, utilize as instruções abaixo:\\n{pagamento}\\n\\nSe já pagou, desconsidere esta mensagem.',
        Hoje: 'Olá {nome}! 🔴\\n\\nLembrete: sua mensalidade de {valor} vence HOJE ({vencimento}).\\n\\nInstruções para pagamento:\\n{pagamento}\\n\\nEvite atrasos! 💪',
        Lembrete: 'Olá {nome}! 🗓️\\n\\nLembrete amigável: sua mensalidade de {valor} vence em {dias_lembrete} dia(s), no dia {vencimento}.\\n\\nInstruções para pagamento:\\n{pagamento}\\n\\nFique em dia!'
    };

    // Função para validar se pelo menos um toggle está ativo
    function validateToggles() {
        const atraso = document.getElementById('notificacaoAtraso').checked;
        const hoje = document.getElementById('notificacaoHoje').checked;
        const lembrete = document.getElementById('notificacaoLembrete').checked;
        
        const hasActiveToggle = atraso || hoje || lembrete;
        
        // Aplicar/remover estilo de erro nos toggles
        const toggles = ['toggleAtraso', 'toggleHoje', 'toggleLembrete'];
        toggles.forEach(toggle => {
            const element = document.getElementById(toggle);
            if (element) {
                if (!hasActiveToggle) {
                    element.classList.add('error');
                } else {
                    element.classList.remove('error');
                }
            }
        });
        
        return hasActiveToggle;
    }

    // Função para mostrar modal de erro
    function showToggleErrorModal() {
        document.getElementById('toggleErrorModal').style.display = 'flex';
    }

    // Função para fechar modal
    function closeModal() {
        document.getElementById('toggleErrorModal').style.display = 'none';
    }

    // Função para destacar campos com erro
    function highlightErrorFields() {
        const requiredFields = ['sheetUrl', 'instrucoesPagamento'];
        requiredFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (!field.value.trim()) {
                field.classList.add('error-field');
            } else {
                field.classList.remove('error-field');
            }
        });
    }

    // Função para remover highlight de erro
    function clearFieldError(fieldId) {
        document.getElementById(fieldId).classList.remove('error-field');
    }

    // Adicionar eventos para limpar erro ao digitar
    document.addEventListener('DOMContentLoaded', function() {
        const sheetUrlField = document.getElementById('sheetUrl');
        const instrucoesField = document.getElementById('instrucoesPagamento');
        
        if (sheetUrlField) {
            sheetUrlField.addEventListener('input', function() {
                clearFieldError('sheetUrl');
            });
        }
        
        if (instrucoesField) {
            instrucoesField.addEventListener('input', function() {
                clearFieldError('instrucoesPagamento');
            });
        }
        
        // Validar toggles inicialmente
        validateToggles();
    });

    function toggleEditor(type) {
        const editor = document.getElementById('editor' + type);
        const checkbox = document.getElementById('notificacao' + type);
        const textarea = document.getElementById('template' + type);
        if (checkbox.checked) {
            editor.classList.remove('hidden');
            if (!textarea.value) textarea.value = defaultTemplates[type];
        } else {
            editor.classList.add('hidden');
        }
    }

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
                clearInterval(statusInterval);
                document.getElementById('connection-section').classList.add('hidden');
                if (data.config && data.config.sheetUrl && data.config.instrucoesPagamento) {
                    document.getElementById('config-section').classList.add('hidden');
                    document.getElementById('control-section').classList.remove('hidden');
                    loadConfigToUI(data.config);
                } else {
                    document.getElementById('config-section').classList.remove('hidden');
                    if (data.config) loadConfigToUI(data.config);
                }
            }
        } catch (error) {
            console.error('Erro ao verificar status:', error);
        }
    }

    function loadConfigToUI(config) {
        document.getElementById('sheetUrl').value = config.sheetUrl || '';
        document.getElementById('instrucoesPagamento').value = config.instrucoesPagamento || '';
        ['Atraso', 'Hoje', 'Lembrete'].forEach(type => {
            const checkbox = document.getElementById('notificacao' + type);
            const configKey = 'notificacao' + type;
            if (config[configKey]) {
                checkbox.checked = true;
                document.getElementById('template' + type).value = config['template' + type] || defaultTemplates[type];
                if (type === 'Lembrete') {
                    document.getElementById('diasLembrete').value = (config.diasLembrete || []).join(',');
                }
                toggleEditor(type);
            }
        });
        validateToggles();
    }

    async function salvarConfig(event) {
        const config = {
            id: clientId,
            sheetUrl: document.getElementById('sheetUrl').value.trim(),
            instrucoesPagamento: document.getElementById('instrucoesPagamento').value.trim(),
            notificacaoAtraso: document.getElementById('notificacaoAtraso').checked,
            templateAtraso: document.getElementById('templateAtraso').value,
            notificacaoHoje: document.getElementById('notificacaoHoje').checked,
            templateHoje: document.getElementById('templateHoje').value,
            notificacaoLembrete: document.getElementById('notificacaoLembrete').checked,
            templateLembrete: document.getElementById('templateLembrete').value,
            diasLembrete: document.getElementById('diasLembrete').value.split(',').map(d => parseInt(d.trim())).filter(Number.isInteger)
        };
        
        // VALIDAÇÃO RIGOROSA DOS CAMPOS OBRIGATÓRIOS
        highlightErrorFields();
        
        if (!config.sheetUrl) {
            alert('❌ A URL da planilha é obrigatória!');
            document.getElementById('sheetUrl').focus();
            return;
        }
        
        if (!config.instrucoesPagamento) {
            alert('❌ As instruções de pagamento são obrigatórias!');
            document.getElementById('instrucoesPagamento').focus();
            return;
        }
        
        // Validação básica da URL do Google Sheets
        if (!config.sheetUrl.includes('docs.google.com/spreadsheets')) {
            alert('❌ Por favor, insira uma URL válida do Google Sheets.');
            document.getElementById('sheetUrl').focus();
            return;
        }
        
        // VALIDAÇÃO DOS TOGGLES - PELO MENOS UM DEVE ESTAR ATIVO
        if (!validateToggles()) {
            showToggleErrorModal();
            return;
        }
        
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Salvando...';
        
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ clientId, config })
            });
            const data = await res.json();
            if (data.success) {
                document.getElementById('config-section').classList.add('hidden');
                document.getElementById('control-section').classList.remove('hidden');
            } else {
                alert('❌ Erro: ' + data.error);
            }
        } catch (error) {
            alert('❌ Erro ao salvar configurações.');
            console.error('Erro:', error);
        } finally {
            btn.disabled = false;
            btn.textContent = '💾 Salvar Configurações';
        }
    }

    async function processarManualmente(event) {
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = '🔄 Processando...';
        try {
            const res = await fetch('/api/process/' + clientId, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('✅ Processamento concluído! Verifique o terminal para mais detalhes.');
            } else {
                alert('❌ Erro: ' + data.error);
            }
        } catch (error) {
            alert('❌ Falha ao se comunicar com o servidor.');
        } finally {
            btn.disabled = false;
            btn.textContent = '🚀 Testar Envio Agora';
        }
    }

    // Inicializar o sistema
    init();
</script>
</body>
</html>`);
});

// =================================================================================
// 🔹 ENDPOINTS DA API
// =================================================================================

app.post('/api/setup', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId é obrigatório' });
    if (!clientBots.has(clientId)) await createClientBot(clientId);
    res.json({ success: true });
});

app.get('/api/status/:clientId', (req, res) => {
    const client = clientBots.get(req.params.clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    res.json({ success: true, connected: client.connected, qrCode: client.qrCode, config: client.config });
});

app.post('/api/config', (req, res) => {
    const { clientId, config } = req.body;
    const client = clientBots.get(clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    if (!client.connected) return res.status(400).json({ success: false, error: 'WhatsApp não conectado' });
    
    // VALIDAÇÃO NO BACKEND - CAMPOS OBRIGATÓRIOS
    if (!config.sheetUrl || !config.instrucoesPagamento) {
        return res.status(400).json({ success: false, error: 'URL da planilha e instruções de pagamento são obrigatórias' });
    }
    
    // VALIDAÇÃO NO BACKEND - PELO MENOS UM TOGGLE
    if (!config.notificacaoAtraso && !config.notificacaoHoje && !config.notificacaoLembrete) {
        return res.status(400).json({ success: false, error: 'Pelo menos um tipo de notificação deve estar habilitado' });
    }
    
    client.config = config;
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

setTimeout(() => {
    console.log('✅ Agendador (CRON) ativado.');
    cron.schedule('* * * * *', () => {
        console.log('⏰ CRON: Iniciando verificação agendada...');
        clientBots.forEach((client, clientId) => {
            if (client.connected && client.config && client.config.sheetUrl && client.config.instrucoesPagamento) {
                processarPagamentos(clientId);
            }
        });
    }, { timezone: "America/Sao_Paulo" });
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   🤖 BOT DE COBRANÇA CUSTOMIZÁVEL    ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`\n🚀 Servidor rodando! Acesse: http://localhost:${PORT}\n`);
    await loadExistingClients();
    console.log('✅ Sistema pronto para receber conexões.\n');
});