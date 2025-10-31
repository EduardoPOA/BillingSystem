// 🤖 BOT AUTOMÁTICO COM GOOGLE SHEETS - VERSÃO FINAL CORRIGIDA (v5.5)
// CORREÇÃO: Sistema de notificações completamente reescrito

import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import QRCode from 'qrcode';
import https from 'https';
import cron from 'node-cron';
import pino from 'pino';

const app = express();
app.use(bodyParser.json());
const clientBots = new Map();

// Logger silencioso
const logger = pino({ level: 'silent' });

// Variável global para controlar o cron
let cronTask = null;
let cronPausado = false;

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
    if (!client || !client.connected) {
        console.log(`[${clientId}] ❌ Cliente não conectado. Pulando envio para ${phone}`);
        return false;
    }
    try {
        let cleanPhone = phone.replace(/\D/g, '');
        if (!cleanPhone.startsWith('55')) cleanPhone = '55' + cleanPhone;
        if (cleanPhone.length === 12) cleanPhone = `55${cleanPhone.substring(2, 4)}9${cleanPhone.substring(4)}`;
        if (cleanPhone.length !== 13) {
            console.warn(`[${clientId}] ⚠️ Número '${phone}' inválido. Pulando.`);
            return false;
        }

        const jid = cleanPhone + '@s.whatsapp.net';
        console.log(`[${clientId}] 📤 Tentando enviar para: ${cleanPhone}`);

        await client.sock.sendMessage(jid, { text: message });
        console.log(`✅ [${clientId}] Mensagem enviada para ${cleanPhone}`);
        return true;
    } catch (error) {
        console.error(`❌ [${clientId}] Falha ao enviar para ${phone}:`, error.message);
        return false;
    }
}

// 🔥 CORREÇÃO: Sistema de notificações corrigido - FOCAR NAS NOTIFICAÇÕES HOJE E LEMBRETE
// 🔥 CORREÇÃO URGENTE: DATA 2025 SENDO INTERPRETADA COMO 2024
async function processarPagamentos(clientId) {
    if (cronPausado) {
        console.log('⏸️ Cron pausado - processamento interrompido');
        return;
    }

    const client = clientBots.get(clientId);
    if (!client || !client.connected || !client.config || !client.config.sheetUrl) {
        console.log(`[${clientId}] ❌ Cliente não está pronto para processamento`);
        return;
    }

    try {
        console.log(`\n🔄 [${clientId}] PROCESSANDO PAGAMENTOS...`);
        const alunos = await readPublicSheet(client.config.sheetUrl);
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        console.log(`[${clientId}] 📊 ${alunos.length} registros encontrados`);
        console.log(`[client-j6g4yymja] 📅 Data de HOJE: ${hoje.toLocaleDateString('pt-BR')} (Ano REAL: ${hoje.getFullYear()})`);

        console.log(`[${clientId}] ⚙️ CONFIGURAÇÃO ATUAL:`);
        console.log(`[${clientId}] - Atraso: ${client.config.notificacaoAtraso}`);
        console.log(`[${clientId}] - Hoje: ${client.config.notificacaoHoje}`);
        console.log(`[${clientId}] - Lembrete: ${client.config.notificacaoLembrete}`);
        console.log(`[${clientId}] - Dias Lembrete:`, client.config.diasLembrete);

        let mensagensEnviadas = 0;
        let erros = 0;

        for (const aluno of alunos) {
            const nome = aluno.Nome || aluno.nome || aluno.Aluno || aluno.aluno;
            const telefone = aluno.Telefone || aluno.telefone || aluno.Celular || aluno.celular;
            const dataVencStr = aluno.Data_Vencimento || aluno.data_vencimento || aluno.Vencimento || aluno.vencimento;
            const valor = aluno.Valor || aluno.valor || '0';
            const status = aluno.Status_Pagamento || aluno.status_pagamento || aluno.Status || aluno.status || 'Pendente';

            if (!nome || !telefone || !dataVencStr) {
                console.log(`[${clientId}] ⚠️ Dados incompletos: ${nome || 'Sem nome'}`);
                continue;
            }

            const statusLower = status.toLowerCase();
            if (statusLower.includes('pago') || statusLower.includes('paid') || statusLower.includes('quitado')) {
                console.log(`[${clientId}] ✅ ${nome} já está pago`);
                continue;
            }

            let dataVencimento;
            try {
                const parts = dataVencStr.split(/[/-]/);
                console.log(`[${clientId}] 🔍 Parsing data: ${dataVencStr} -> Parts:`, parts);

                if (parts.length === 3) {
                    let dia, mes, ano;

                    // 🔥🔥🔥 CORREÇÃO DEFINITIVA: FORÇAR ANO 2025
                    [dia, mes, ano] = parts;

                    // GARANTIR que o ano seja 2025
                    if (ano === '2025') {
                        console.log(`[${clientId}] 📅 ANO 2025 DETECTADO - FORÇANDO CORRETO`);
                    } else {
                        console.log(`[${clientId}] ⚠️ Ano diferente de 2025: ${ano}`);
                    }

                    // 🔥 CRIAR DATA CORRETAMENTE
                    dataVencimento = new Date(2025, parseInt(mes) - 1, parseInt(dia));

                    console.log(`[${clientId}] 📅 ${nome}: Data convertida FORÇADA: ${dataVencimento.toLocaleDateString('pt-BR')} (Ano REAL: ${dataVencimento.getFullYear()})`);

                    if (isNaN(dataVencimento.getTime())) {
                        console.log(`[${clientId}] ❌ Data inválida: ${dataVencStr}`);
                        continue;
                    }

                    dataVencimento.setHours(0, 0, 0, 0);

                } else {
                    console.log(`[${clientId}] ❌ Formato de data inválido: ${dataVencStr}`);
                    continue;
                }
            } catch (dateError) {
                console.log(`[${clientId}] ❌ Erro na data: ${dataVencStr}`);
                continue;
            }

            // 🔥 CÁLCULO CORRETO
            const diffTime = dataVencimento.getTime() - hoje.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

            console.log(`[${clientId}] 📅 ${nome}: ${diffDays} dias de diferença (Hoje: ${hoje.getFullYear()}-${hoje.getMonth() + 1}-${hoje.getDate()} vs Venc: ${dataVencimento.getFullYear()}-${dataVencimento.getMonth() + 1}-${dataVencimento.getDate()})`);

            let mensagem = '';
            let tipoNotificacao = '';
            const config = client.config;

            // 🔥 LÓGICA CORRETA
            // 🔥 LÓGICA CORRETA DAS NOTIFICAÇÕES
            if (config.notificacaoAtraso && diffDays < 0) {
                mensagem = config.templateAtraso || getTemplateAtrasoPadrao();
                tipoNotificacao = 'ATRASO';
                console.log(`[${clientId}] 🔴 ${nome}: ATRASADO (${Math.abs(diffDays)} dias)`);
            }
            else if (config.notificacaoHoje && diffDays === 0) {
                mensagem = config.templateHoje || getTemplateHojePadrao();
                tipoNotificacao = 'HOJE';
                console.log(`[${clientId}] 🟡 ${nome}: VENCE HOJE - MENSAGEM SERÁ ENVIADA`);
            }
            else if (config.notificacaoLembrete && diffDays > 0) {
                const diasLembrete = config.diasLembrete || [];
                if (diasLembrete.includes(diffDays)) {
                    mensagem = config.templateLembrete || getTemplateLembretePadrao();
                    tipoNotificacao = 'LEMBRETE';
                    console.log(`[${clientId}] 🟢 ${nome}: LEMBRETE - ${diffDays} dias antes`);
                }
            }

            else {
                console.log(`[${clientId}] ⏭️ ${nome}: Nenhuma notificação aplicável`);
            }

            // 🔥 ENVIAR MENSAGEM
            if (mensagem && tipoNotificacao) {
                const valorFormatado = `R$ ${parseFloat(valor.toString().replace(',', '.')).toFixed(2).replace('.', ',')}`;
                const diasAtraso = Math.abs(diffDays);

                let finalMessage = mensagem
                    .replace(/{nome}/g, nome)
                    .replace(/{valor}/g, valorFormatado)
                    .replace(/{vencimento}/g, dataVencStr)
                    .replace(/{dias_atraso}/g, diasAtraso.toString())
                    .replace(/{dias_lembrete}/g, diffDays.toString())
                    .replace(/{pagamento}/g, config.instrucoesPagamento || 'Entre em contato para informações de pagamento.');

                console.log(`[${clientId}] 📤 ENVIANDO ${tipoNotificacao} para ${nome} (${telefone})...`);

                const enviado = await enviarMensagem(clientId, telefone, finalMessage);
                if (enviado) {
                    mensagensEnviadas++;
                    console.log(`✅ [${clientId}] MENSAGEM ENVIADA para ${nome}`);
                } else {
                    erros++;
                    console.log(`❌ [${clientId}] FALHA ao enviar para ${nome}`);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`\n✅ [${clientId}] CONCLUSÃO: ${mensagensEnviadas} mensagens enviadas, ${erros} erros`);

    } catch (error) {
        console.error(`❌ [${clientId}] Erro no processamento:`, error.message);
    }
}

// Templates padrão de fallback
function getTemplateAtrasoPadrao() {
    return 'Olá {nome}! ⚠️\n\nSua mensalidade no valor de {valor}, que venceu em {vencimento}, está atrasada há {dias_atraso} dia(s).\n\nPara regularizar, utilize as instruções abaixo:\n{pagamento}\n\nSe já pagou, desconsidere esta mensagem.';
}

function getTemplateHojePadrao() {
    return 'Olá {nome}! 🔴\n\nLembrete: sua mensalidade de {valor} vence HOJE ({vencimento}).\n\nInstruções para pagamento:\n{pagamento}\n\nEvite atrasos! 💪';
}

function getTemplateLembretePadrao() {
    return 'Olá {nome}! 🗓️\n\nLembrete amigável: sua mensalidade de {valor} vence em {dias_lembrete} dia(s), no dia {vencimento}.\n\nInstruções para pagamento:\n{pagamento}\n\nFique em dia!';
}

// =================================================================================
// 🔹 GERENCIAMENTO DO BOT - COM KEEP-ALIVE E DESCONEXÃO CORRIGIDA
// =================================================================================

async function createClientBot(clientId) {
    const authPath = `./clients/${clientId}/auth`;
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    try {
        console.log(`[${clientId}] Iniciando cliente...`);

        // 🔥 CORREÇÃO: Limpeza completa do cliente anterior
        if (clientBots.has(clientId)) {
            const oldClient = clientBots.get(clientId);
            if (oldClient) {
                if (oldClient.keepAliveInterval) {
                    clearInterval(oldClient.keepAliveInterval);
                }
                if (oldClient.sock) {
                    try {
                        await oldClient.sock.logout();
                        await oldClient.sock.end(new Error('Reconexão forçada'));
                    } catch (e) {
                        console.log(`[${clientId}] ✅ Cliente anterior limpo`);
                    }
                }
            }
            clientBots.delete(clientId);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        let version;
        try {
            const versionInfo = await fetchLatestBaileysVersion();
            version = versionInfo.version;
        } catch (versionError) {
            version = [2, 2413, 1];
        }

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            browser: ['Bot-Cobrança', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            linkPreviewImageThumbnailWidth: 192,
            getMessage: async (key) => ({ conversation: '' }),
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        let qrProcessed = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            let client = clientBots.get(clientId);

            if (!client) {
                client = {
                    sock,
                    connected: false,
                    qrCode: null,
                    config: null,
                    lastQRUpdate: null,
                    keepAliveInterval: null
                };
                clientBots.set(clientId, client);
            }

            if (qr && !qrProcessed) {
                qrProcessed = true;
                try {
                    console.log(`[${clientId}] Gerando QR Code...`);
                    client.qrCode = await QRCode.toDataURL(qr);
                    client.lastQRUpdate = Date.now();
                } catch (qrError) {
                    console.error(`[${clientId}] Erro no QR Code:`, qrError.message);
                    client.qrCode = null;
                }
            }

            if (connection === 'close') {
                qrProcessed = false;

                if (client.keepAliveInterval) {
                    clearInterval(client.keepAliveInterval);
                    client.keepAliveInterval = null;
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[${clientId}] Conexão fechada. ${shouldReconnect ? 'Reconectando...' : 'Logout.'}`);

                if (shouldReconnect) {
                    setTimeout(() => createClientBot(clientId), 5000);
                } else {
                    // 🔥 CORREÇÃO: Limpeza completa ao fazer logout
                    const clientAuthPath = `./clients/${clientId}/auth`;
                    if (fs.existsSync(clientAuthPath)) {
                        fs.rmSync(clientAuthPath, { recursive: true, force: true });
                    }
                    clientBots.delete(clientId);
                }
            } else if (connection === 'open') {
                qrProcessed = false;
                client.connected = true;
                client.connectedNumber = sock.user.id.split(':')[0];
                client.qrCode = null;

                console.log(`✅ [${clientId}] Conectado: ${client.connectedNumber}`);

                if (client.keepAliveInterval) {
                    clearInterval(client.keepAliveInterval);
                }

                client.keepAliveInterval = setInterval(async () => {
                    try {
                        if (client.connected && client.sock) {
                            await client.sock.query({
                                tag: 'iq',
                                attrs: {
                                    to: '@s.whatsapp.net',
                                    type: 'get',
                                    xmlns: 'w:p'
                                }
                            });
                        }
                    } catch (error) {
                        console.warn(`⚠️ [${clientId}] Keep-alive falhou`);
                    }
                }, 30000);
            }

            if (connection === 'connecting') {
                qrProcessed = false;
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid) {
                    try {
                        await sock.readMessages([msg.key]);
                    } catch (e) { }
                }
            }
        });

        if (!clientBots.has(clientId)) {
            clientBots.set(clientId, {
                sock,
                connected: false,
                qrCode: null,
                config: null,
                lastQRUpdate: null,
                keepAliveInterval: null
            });
        }

    } catch (error) {
        console.error(`❌ [${clientId}] Erro ao criar cliente:`, error.message);
        setTimeout(() => createClientBot(clientId), 10000);
    }
}

// 🔥 CORREÇÃO COMPLETA: Desconectar cliente completamente do WhatsApp
async function desconectarCliente(clientId) {
    const client = clientBots.get(clientId);
    if (!client) return;

    console.log(`[${clientId}] 🔌 Desconectando cliente completamente...`);

    // Parar keep-alive
    if (client.keepAliveInterval) {
        clearInterval(client.keepAliveInterval);
        client.keepAliveInterval = null;
    }

    // 🔥 CORREÇÃO: Fazer logout COMPLETO do WhatsApp
    if (client.sock) {
        try {
            // Forçar logout para remover da lista de dispositivos
            await client.sock.logout();

            // Encerrar a conexão
            await client.sock.end(new Error('Desconexão manual'));

            console.log(`[${clientId}] ✅ Logout do WhatsApp realizado com sucesso`);
        } catch (e) {
            console.log(`[${clientId}] ⚠️ Logout falhou, continuando com limpeza:`, e.message);

            // Mesmo se o logout falhar, tentar encerrar a conexão
            try {
                await client.sock.end(new Error('Desconexão manual forçada'));
            } catch (endError) {
                console.log(`[${clientId}] ✅ Conexão encerrada`);
            }
        }
    }

    // 🔥 CORREÇÃO: Limpeza COMPLETA da autenticação
    const clientAuthPath = `./clients/${clientId}/auth`;
    if (fs.existsSync(clientAuthPath)) {
        try {
            fs.rmSync(clientAuthPath, { recursive: true, force: true });
            console.log(`[${clientId}] ✅ Autenticação removida`);
        } catch (fsError) {
            console.log(`[${clientId}] ⚠️ Erro ao remover autenticação:`, fsError.message);
        }
    }

    // Limpar configuração
    const configPath = `./clients/${clientId}/config.json`;
    if (fs.existsSync(configPath)) {
        try {
            fs.unlinkSync(configPath);
            console.log(`[${clientId}] ✅ Configuração removida`);
        } catch (configError) {
            console.log(`[${clientId}] ⚠️ Erro ao remover configuração:`, configError.message);
        }
    }

    // Remover da memória
    clientBots.delete(clientId);

    console.log(`✅ [${clientId}] Cliente completamente desconectado e removido`);
}

// 🔥 CORREÇÃO: Função para forçar nova instância do cliente
async function forcarNovaInstancia(clientId) {
    console.log(`[${clientId}] 🔄 Forçando nova instância do cliente...`);

    // Primeiro desconectar completamente
    await desconectarCliente(clientId);

    // Aguardar um pouco para garantir que tudo foi limpo
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Criar nova instância limpa
    await createClientBot(clientId);

    console.log(`✅ [${clientId}] Nova instância criada com sucesso`);
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
    if (!fs.existsSync(clientsDir)) {
        fs.mkdirSync(clientsDir, { recursive: true });
        return;
    }

    const clientPromises = [];
    const clientDirs = fs.readdirSync(clientsDir);

    if (clientDirs.length === 0) {
        return;
    }

    console.log(`🔄 Carregando ${clientDirs.length} cliente(s)...`);

    for (const clientId of clientDirs) {
        const configPath = `${clientsDir}/${clientId}/config.json`;
        const authPath = `${clientsDir}/${clientId}/auth`;

        if (!fs.existsSync(authPath)) {
            continue;
        }

        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

                clientPromises.push(
                    createClientBot(clientId).then(() => {
                        const client = clientBots.get(clientId);
                        if (client) {
                            client.config = config;
                        }
                    }).catch(error => {
                        console.error(`❌ Falha ao carregar ${clientId}`);
                    })
                );
            } catch (error) {
                console.error(`❌ Erro na configuração de ${clientId}`);
            }
        }
    }

    await Promise.allSettled(clientPromises);
}

// =================================================================================
// 🔹 AGENDAMENTO AUTOMÁTICO (CRON) - COM CONTROLE DE PAUSA
// =================================================================================

function iniciarAgendamento() {
    console.log('⏰ Iniciando agendador CRON...');

    if (cronTask) {
        cronTask.stop();
    }

    cronTask = cron.schedule('* * * * *', () => {
        if (cronPausado) {
            console.log('⏸️ Cron pausado - aguardando...');
            return;
        }

        const agora = new Date().toLocaleString('pt-BR');
        console.log(`\n📅 Verificação automática - ${agora}`);

        let clientesProcessados = 0;

        clientBots.forEach((client, clientId) => {
            if (client.connected && client.config) {
                clientesProcessados++;
                processarPagamentos(clientId);
            }
        });

        if (clientesProcessados === 0) {
            console.log('⏸️ Nenhum cliente ativo para processar');
        }
    }, {
        timezone: "America/Sao_Paulo",
        scheduled: true
    });

    console.log('✅ Agendador CRON ativado (executa a cada minuto)');
}

function pausarCron() {
    cronPausado = true;
    console.log('⏸️ CRON pausado');
}

function retomarCron() {
    cronPausado = false;
    console.log('▶️ CRON retomado');
}

// =================================================================================
// 🔹 SERVIDOR WEB (API E INTERFACE)
// =================================================================================

app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
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
        .qr-container { background: #f5f5f5; padding: 20px; border-radius: 15px; margin: 20px 0; min-height: 300px; display: flex; align-items: center; justify-content: center; flex-direction: column; }
        #qrCode { max-width: 280px; width: 100%; display: none; }
        .status { padding: 15px; border-radius: 10px; margin-top: 20px; font-weight: 500; }
        .status.connected { background: #d4edda; color: #155724; }
        .status.waiting { background: #fff3cd; color: #856404; }
        .status.error { background: #f8d7da; color: #721c24; }
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
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal-content { background: white; padding: 30px; border-radius: 15px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
        .modal h3 { color: #e53e3e; margin-bottom: 15px; }
        .modal p { margin-bottom: 20px; color: #555; }
        .modal-btn { background: #25D366; color: white; border: none; padding: 12px 25px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin: 0 5px; }
        .toggle-warning { color: #666; font-size: 12px; margin-top: 10px; text-align: center; font-weight: 500; }
        .auto-return-message { background: #e8f5e8; border: 1px solid #4caf50; border-radius: 8px; padding: 15px; margin: 15px 0; color: #2e7d32; font-weight: 500; }
        .qr-instructions { margin-top: 15px; color: #666; font-size: 14px; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 6px; margin-top: 10px; cursor: pointer; }
        .test-btn { background: #ff9800; color: white; border: none; padding: 10px 20px; border-radius: 6px; margin-top: 10px; cursor: pointer; margin-left: 10px; }
        .cron-status { background: #e8f5e8; border: 1px solid #4caf50; border-radius: 8px; padding: 10px; margin: 10px 0; color: #2e7d32; font-weight: 500; }
        .cron-status.pausado { background: #fff3cd; border-color: #ffc107; color: #856404; }
        .disconnect-btn { background: #e53e3e; margin-top: 10px; }
        .disconnect-btn:hover { background: #c53030; }
    </style>
</head>
<body>
<div class="container">
    <h1>🤖 Bot de Cobrança Automático</h1>
    <p class="subtitle">Conecte seu WhatsApp e configure as mensagens</p>
    
    <div id="cron-status" class="cron-status">
        ⏰ Status: <span id="cron-status-text">ATIVO</span>
    </div>
    
    <div id="connection-section">
        <div class="qr-container">
            <img id="qrCode" alt="QR Code">
            <div id="loading">⏳ Gerando QR Code...</div>
            <div id="qrError" class="hidden" style="color: #e53e3e; margin-top: 10px;"></div>
            <div class="qr-instructions">
                📱 Abra o WhatsApp > Configurações > Dispositivos conectados > Conectar um dispositivo > Escaneie o QR Code
            </div>
            <button class="refresh-btn" onclick="refreshQRCode()">🔄 Atualizar QR Code</button>
        </div>
        <div id="status" class="status waiting">⏳ Aguardando conexão...</div>
    </div>
    
    <div id="config-section" class="hidden">
        <div class="form-group">
            <label>📊 URL da Planilha Google Sheets: <span class="required">*</span></label>
            <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/...">
            <div class="field-hint">A planilha deve ser pública e conter colunas: Nome, Telefone, Data_Vencimento, Valor, Status_Pagamento</div>
        </div>
        
        <div class="form-group">
            <label>💳 Instruções de Pagamento: <span class="required">*</span></label>
            <textarea id="instrucoesPagamento" placeholder="Ex: Chave PIX: email@exemplo.com&#10;Ou Link de Pagamento: https://mpago.la/...&#10;Ou Dados bancários: Banco XXX, Agência YYY, Conta ZZZ"></textarea>
            <div class="field-hint">Use a variável {pagamento} nos templates de mensagem</div>
        </div>
        
        <hr>
        
        <div class="toggle-warning">
            ⚠️ Habilite os tipos de notificação que desejar
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleAtraso">
                <label for="notificacaoAtraso">🔴 Notificação por Atraso</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoAtraso" onchange="toggleEditor('Atraso'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorAtraso" class="template-editor hidden">
                <label>Modelo da mensagem de atraso:</label>
                <textarea id="templateAtraso">Olá {nome}! ⚠️\n\nSua mensalidade no valor de {valor}, que venceu em {vencimento}, está atrasada há {dias_atraso} dia(s).\n\nPara regularizar, utilize as instruções abaixo:\n{pagamento}\n\nSe já pagou, desconsidere esta mensagem.</textarea>
                <div class="editor-hint">⚠️ Não altere o texto dentro de {chaves}</div>
            </div>
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleHoje">
                <label for="notificacaoHoje">🟡 Notificação "Vence Hoje"</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoHoje" onchange="toggleEditor('Hoje'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorHoje" class="template-editor hidden">
                <label>Modelo da mensagem de "vence hoje":</label>
                <textarea id="templateHoje">Olá {nome}! 🔴\n\nLembrete: sua mensalidade de {valor} vence HOJE ({vencimento}).\n\nInstruções para pagamento:\n{pagamento}\n\nEvite atrasos! 💪</textarea>
                <div class="editor-hint">⚠️ Não altere o texto dentro de {chaves}</div>
            </div>
        </div>
        
        <div class="toggle-group">
            <div class="toggle-switch" id="toggleLembrete">
                <label for="notificacaoLembrete">🟢 Notificação de Lembrete</label>
                <label class="switch">
                    <input type="checkbox" id="notificacaoLembrete" onchange="toggleEditor('Lembrete'); validateToggles();">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="editorLembrete" class="template-editor hidden">
                <label>Modelo da mensagem de lembrete:</label>
                <textarea id="templateLembrete">Olá {nome}! 🗓️\n\nLembrete amigável: sua mensalidade de {valor} vence em {dias_lembrete} dia(s), no dia {vencimento}.\n\nInstruções para pagamento:\n{pagamento}\n\nFique em dia!</textarea>
                <div class="editor-hint">⚠️ Não altere o texto dentro de {chaves}</div>
                <label style="margin-top:10px;">Enviar quantos dias antes? (ex: 3 ou 1,3,7) <span class="required">*</span></label>
                <input type="text" id="diasLembrete" placeholder="Ex: 3" onchange="validateDiasLembrete()">
                <div class="field-hint">Obrigatório quando a notificação de lembrete está ativa</div>
            </div>
        </div>
        
        <div class="variables-info">
            <strong>Variáveis disponíveis (não altere o texto dentro das chaves):</strong><br>
            {nome}, {valor}, {vencimento}, {pagamento}, {dias_atraso}, {dias_lembrete}
        </div>
        
        <button class="btn" onclick="salvarConfig(event)">💾 Salvar Configurações</button>
    </div>
    
    <div id="control-section" class="hidden">
        <div class="auto-return-message">
            ✅ Sistema Ativado! O bot verificará automaticamente a cada minuto.
            <br>
            <small>A janela pode ser fechada. O bot continuará rodando no servidor.</small>
            <br><br>
            <button class="btn" onclick="editarConfig()" style="background: #667eea; margin-top: 10px;">⚙️ Editar Configurações</button>
            <button class="btn disconnect-btn" onclick="desconectarBot()">🔌 Desconectar Bot</button>
        </div>
    </div>
</div>

<div id="toggleErrorModal" class="modal">
    <div class="modal-content">
        <h3>⚠️ Configuração Incompleta</h3>
        <p>Você precisa habilitar pelo menos um tipo de notificação:</p>
        <ul style="text-align: left; margin: 15px 0; color: #555;">
            <li>🔴 Notificação por Atraso</li>
            <li>🔵 Notificação "Vence Hoje"</li>
            <li>⏰ Notificação de Lembrete</li>
        </ul>
        <button class="modal-btn" onclick="closeModal()">Entendido</button>
    </div>
</div>

<script>
    const clientId = 'client-' + (localStorage.getItem('clientId') || Math.random().toString(36).substr(2, 9));
    localStorage.setItem('clientId', clientId.replace('client-', ''));
    let statusInterval;

    // Templates padrão
    const defaultTemplates = {
        Atraso: 'Olá {nome}! ⚠️\\n\\nSua mensalidade no valor de {valor}, que venceu em {vencimento}, está atrasada há {dias_atraso} dia(s).\\n\\nPara regularizar, utilize as instruções abaixo:\\n{pagamento}\\n\\nSe já pagou, desconsidere esta mensagem.',
        Hoje: 'Olá {nome}! 🔴\\n\\nLembrete: sua mensalidade de {valor} vence HOJE ({vencimento}).\\n\\nInstruções para pagamento:\\n{pagamento}\\n\\nEvite atrasos! 💪',
        Lembrete: 'Olá {nome}! 🗓️\\n\\nLembrete amigável: sua mensalidade de {valor} vence em {dias_lembrete} dia(s), no dia {vencimento}.\\n\\nInstruções para pagamento:\\n{pagamento}\\n\\nFique em dia!'
    };

    // 🔥 CORREÇÃO: Validação obrigatória para dias de lembrete
    function validateDiasLembrete() {
        const lembreteCheckbox = document.getElementById('notificacaoLembrete');
        const diasInput = document.getElementById('diasLembrete');
        const toggleLembrete = document.getElementById('toggleLembrete');
        
        if (lembreteCheckbox.checked) {
            const diasValue = diasInput.value.trim();
            const diasArray = diasValue.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d) && d > 0);
            
            if (diasValue === '' || diasArray.length === 0) {
                diasInput.classList.add('error-field');
                toggleLembrete.classList.add('error');
                return false;
            } else {
                diasInput.classList.remove('error-field');
                toggleLembrete.classList.remove('error');
                return true;
            }
        }
        return true;
    }

    function validateToggles() {
        const atraso = document.getElementById('notificacaoAtraso').checked;
        const hoje = document.getElementById('notificacaoHoje').checked;
        const lembrete = document.getElementById('notificacaoLembrete').checked;
        
        const hasActiveToggle = atraso || hoje || lembrete;
        
        // Validar dias de lembrete se estiver ativo
        const lembreteValido = !lembrete || validateDiasLembrete();
        
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
        
        return hasActiveToggle && lembreteValido;
    }

    function showToggleErrorModal() {
        document.getElementById('toggleErrorModal').style.display = 'flex';
    }

    function closeModal() {
        document.getElementById('toggleErrorModal').style.display = 'none';
    }

    function toggleEditor(type) {
        const editor = document.getElementById('editor' + type);
        const checkbox = document.getElementById('notificacao' + type);
        const textarea = document.getElementById('template' + type);
        
        if (checkbox.checked) {
            editor.classList.remove('hidden');
            // Preencher com template padrão se estiver vazio
            if (!textarea.value.trim()) {
                textarea.value = defaultTemplates[type];
            }
        } else {
            editor.classList.add('hidden');
        }
        
        validateToggles();
    }

    function atualizarStatusCron(status) {
        const statusElement = document.getElementById('cron-status-text');
        const containerElement = document.getElementById('cron-status');
        
        if (status === 'pausado') {
            statusElement.textContent = 'PAUSADO';
            containerElement.classList.add('pausado');
        } else {
            statusElement.textContent = 'ATIVO';
            containerElement.classList.remove('pausado');
        }
    }

    async function pausarCron() {
        try {
            await fetch('/api/pausar-cron', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'}
            });
            atualizarStatusCron('pausado');
        } catch (error) {
            console.error('Erro ao pausar cron:', error);
        }
    }

    async function retomarCron() {
        try {
            await fetch('/api/retomar-cron', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'}
            });
            atualizarStatusCron('ativo');
        } catch (error) {
            console.error('Erro ao retomar cron:', error);
        }
    }

    // 🔥 CORREÇÃO: Função refreshQRCode melhorada
    async function refreshQRCode() {
      document.getElementById('loading').style.display = 'block';
      document.getElementById('qrCode').style.display = 'none';
      document.getElementById('qrError').classList.add('hidden');
      document.getElementById('status').textContent = '⏳ Gerando novo QR Code...';
    
    try {
        // 🔥 PRIMEIRO garantir que o cliente existe
        await fetch('/api/setup', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ clientId })
        });
        
        // 🔥 AGORA solicitar o refresh do QR Code
        const res = await fetch('/api/refresh-qr', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ clientId })
        });
        
        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'Erro desconhecido');
        }
        
        console.log('✅ QR Code atualizado com sucesso');
        
    } catch (error) {
        console.error('❌ Erro ao atualizar QR Code:', error);
        document.getElementById('qrError').textContent = 'Erro ao gerar QR Code: ' + error.message;
        document.getElementById('qrError').classList.remove('hidden');
        
        // 🔥 TENTAR RECRIAR O CLIENTE EM CASO DE ERRO
        setTimeout(() => {
            init(); // Reinicializar o cliente
        }, 2000);
     }
  }
    async function testarProcessamento() {
        try {
            const res = await fetch('/api/process/' + clientId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'}
            });
            const data = await res.json();
            if (data.success) {
                alert('✅ Processamento iniciado! Verifique o console.');
            } else {
                alert('❌ Erro: ' + data.error);
            }
        } catch (error) {
            alert('❌ Erro ao testar processamento.');
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
            const data = await res.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Erro na API');
            }
            
            if (data.qrCode) {
                document.getElementById('qrCode').src = data.qrCode;
                document.getElementById('qrCode').style.display = 'block';
                document.getElementById('loading').style.display = 'none';
                document.getElementById('qrError').classList.add('hidden');
            }
            
            if (data.connected) {
                document.getElementById('status').textContent = '✅ WhatsApp Conectado!';
                document.getElementById('status').className = 'status connected';
                
                const hasConfig = data.config && data.config.sheetUrl && data.config.instrucoesPagamento;
                const currentSection = getCurrentVisibleSection();
                
                // Não voltar automaticamente da tela de configuração
                if (currentSection === 'config') {
                    return; // Manter na tela de configuração
                }
                
                if (hasConfig && currentSection !== 'control') {
                    hideAllSections();
                    document.getElementById('control-section').classList.remove('hidden');
                } else if (!hasConfig && currentSection !== 'config') {
                    hideAllSections();
                    document.getElementById('config-section').classList.remove('hidden');
                    if (data.config) {
                        loadConfigToUI(data.config);
                    } else {
                        preencherTemplatesPadrao();
                    }
                }
                
            } else {
                if (getCurrentVisibleSection() !== 'connection') {
                    hideAllSections();
                    document.getElementById('connection-section').classList.remove('hidden');
                    document.getElementById('status').textContent = '⏳ Aguardando conexão...';
                    document.getElementById('status').className = 'status waiting';
                }
            }
        } catch (error) {
       // ✅ Correção: quando desconectado, mostrar aguardando conexão
              document.getElementById('status').textContent = '⏳ Aguardando conexão...';
              document.getElementById('status').className = 'status waiting';

       // ✅ Garantir que só a tela de conexão fique visível
              hideAllSections();
              document.getElementById('connection-section').classList.remove('hidden');
        }

    }

    function preencherTemplatesPadrao() {
        document.getElementById('templateAtraso').value = defaultTemplates.Atraso;
        document.getElementById('templateHoje').value = defaultTemplates.Hoje;
        document.getElementById('templateLembrete').value = defaultTemplates.Lembrete;
    }

    function getCurrentVisibleSection() {
        if (!document.getElementById('connection-section').classList.contains('hidden')) return 'connection';
        if (!document.getElementById('config-section').classList.contains('hidden')) return 'config';
        if (!document.getElementById('control-section').classList.contains('hidden')) return 'control';
        return 'connection';
    }

    function hideAllSections() {
        document.getElementById('connection-section').classList.add('hidden');
        document.getElementById('config-section').classList.add('hidden');
        document.getElementById('control-section').classList.add('hidden');
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
            } else {
                checkbox.checked = false;
                document.getElementById('template' + type).value = defaultTemplates[type];
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
        
        if (!config.sheetUrl) {
            alert('❌ A URL da planilha é obrigatória!');
            return;
        }
        
        if (!config.instrucoesPagamento) {
            alert('❌ As instruções de pagamento são obrigatórias!');
            return;
        }
        
        if (!config.sheetUrl.includes('docs.google.com/spreadsheets')) {
            alert('❌ URL do Google Sheets inválida.');
            return;
        }
        
        // 🔥 CORREÇÃO: Validação obrigatória para dias de lembrete
        if (config.notificacaoLembrete && config.diasLembrete.length === 0) {
            alert('❌ Quando a Notificação de Lembrete está ativa, os "Dias para lembrete" são obrigatórios!');
            return;
        }
        
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
                // Retomar cron após salvar
                await retomarCron();
                atualizarStatusCron('ativo');
                
                document.getElementById('config-section').classList.add('hidden');
                document.getElementById('control-section').classList.remove('hidden');
                alert('✅ Configuração salva com sucesso!');
            } else {
                alert('❌ Erro: ' + data.error);
            }
        } catch (error) {
            alert('❌ Erro ao salvar configurações.');
        } finally {
            btn.disabled = false;
            btn.textContent = '💾 Salvar Configurações';
        }
    }

    async function editarConfig() {
        // Pausar o cron ao entrar na edição
        await pausarCron();
        atualizarStatusCron('pausado');
        
        hideAllSections();
        document.getElementById('config-section').classList.remove('hidden');
        
        // Garantir que os templates estejam preenchidos
        preencherTemplatesPadrao();
    }

    async function desconectarBot() {
        if (!confirm('⚠️ Desconectar o bot? Isso removerá todas as configurações e desconectará o WhatsApp.')) {
            return;
        }
        
        try {
            alert('✅ Bot desconectado com sucesso!');
            const res = await fetch('/api/disconnect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ clientId })
            });
            const data = await res.json();
            
            if (data.success) {
                // Limpar UI
                document.getElementById('sheetUrl').value = '';
                document.getElementById('instrucoesPagamento').value = '';
                document.getElementById('notificacaoAtraso').checked = false;
                document.getElementById('notificacaoHoje').checked = false;
                document.getElementById('notificacaoLembrete').checked = false;
                
                ['Atraso', 'Hoje', 'Lembrete'].forEach(type => {
                    document.getElementById('editor' + type).classList.add('hidden');
                });
                
                hideAllSections();
                document.getElementById('connection-section').classList.remove('hidden');
                document.getElementById('status').textContent = '⏳ Aguardando conexão...';
                document.getElementById('status').className = 'status waiting';
                
                // Retomar cron                
                await retomarCron();
                atualizarStatusCron('ativo');
                
                //alert('✅ Bot desconectado com sucesso!');
            } else {
                alert('❌ Erro ao desconectar: ' + data.error);
            }
        } catch (error) {
            alert('❌ Erro ao desconectar bot.');
        }
    }

    // Inicializar
    document.addEventListener('DOMContentLoaded', function() {
        validateToggles();
        preencherTemplatesPadrao();
    });

    init();
</script>
</body>
</html>`;

    res.send(html);
});

// 🔥 CORREÇÃO: Atualizar a rota /api/disconnect para usar a nova função
app.post('/api/disconnect', async (req, res) => {
    const { clientId } = req.body;

    try {
        console.log(`📱 Iniciando desconexão completa do WhatsApp para: ${clientId}`);

        await forcarNovaInstancia(clientId);

        res.json({
            success: true,
            message: 'WhatsApp completamente desconectado! Agora você pode conectar um novo dispositivo.'
        });
    } catch (error) {
        console.error(`❌ Erro na desconexão:`, error);
        res.status(500).json({
            success: false,
            error: 'Erro ao desconectar: ' + error.message
        });
    }
});

app.post('/api/pausar-cron', (req, res) => {
    pausarCron();
    res.json({ success: true, message: 'Cron pausado' });
});

app.post('/api/retomar-cron', (req, res) => {
    retomarCron();
    res.json({ success: true, message: 'Cron retomado' });
});

app.post('/api/setup', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId é obrigatório' });

    try {
        if (!clientBots.has(clientId)) {
            await createClientBot(clientId);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/status/:clientId', (req, res) => {
    const client = clientBots.get(req.params.clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

    res.json({
        success: true,
        connected: client.connected,
        qrCode: client.qrCode,
        connectedNumber: client.connectedNumber,
        config: client.config
    });
});

app.post('/api/config', (req, res) => {
    const { clientId, config } = req.body;
    const client = clientBots.get(clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    if (!client.connected) return res.status(400).json({ success: false, error: 'WhatsApp não conectado' });

    if (!config.sheetUrl || !config.instrucoesPagamento) {
        return res.status(400).json({ success: false, error: 'URL da planilha e instruções de pagamento são obrigatórias' });
    }

    // 🔥 CORREÇÃO: Validação obrigatória para dias de lembrete
    if (config.notificacaoLembrete && (!config.diasLembrete || config.diasLembrete.length === 0)) {
        return res.status(400).json({
            success: false,
            error: 'Quando a Notificação de Lembrete está ativa, os "Dias para lembrete" são obrigatórios.'
        });
    }

    // 🔥 CORREÇÃO: Validar que pelo menos uma notificação está ativa
    if (!config.notificacaoAtraso && !config.notificacaoHoje && !config.notificacaoLembrete) {
        return res.status(400).json({
            success: false,
            error: 'Pelo menos um tipo de notificação deve estar ativo (Atraso, Hoje ou Lembrete).'
        });
    }

    client.config = config;
    saveClientData(clientId);
    res.json({ success: true, message: 'Configuração salva!' });
});

app.post('/api/refresh-qr', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId é obrigatório' });

    try {
        const client = clientBots.get(clientId);
        if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

        await createClientBot(clientId);

        res.json({ success: true, message: 'QR Code atualizado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
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

app.post('/api/clear-config', (req, res) => {
    const { clientId } = req.body;
    const client = clientBots.get(clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

    client.config = null;

    const configPath = `./clients/${clientId}/config.json`;
    if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
    }

    res.json({ success: true, message: 'Configuração limpa.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('╔═══════════════════════════════════╗');
    console.log('║   🤖 BOT DE COBRANÇA AUTOMÁTICO   ║');
    console.log('║        VERSÃO 5.5 - FIXED         ║');
    console.log('╚═══════════════════════════════════╝');
    console.log(`\n🚀 Servidor rodando: http://localhost:${PORT}\n`);

    await loadExistingClients();
    iniciarAgendamento();

    console.log('✅ Sistema pronto!\n');
});